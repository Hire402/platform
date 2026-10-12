// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Hire402Escrow, IERC20} from "./Hire402Escrow.sol";

/// @title BudgetGuard — on-chain spending budget for a delegated agent (spec §5.8).
/// @notice The enforcement half of delegated spending: the account holder
///         funds this guard; the agent (the spender) can commit that money
///         ONLY through capped escrow creation. Caps live on-chain —
///         per-counterparty (the escrow seller), per UTC day, and total —
///         so a buggy or prompt-injected agent cannot exceed them, unlike
///         SDK spending policies, which are advisory process memory (they
///         reset on restart and an agent can skip them).
///
///         The guard is the escrow BUYER: every refund comes back to the
///         guard — never to the agent — and the holder can withdraw
///         everything at any time. The agent's buyer-side release control
///         (approve, dispute, cancel, expireRefund) routes through the
///         guard as pure passthroughs; money only ever moves at `spend`.
/// @dev    Self-contained: no external dependencies. One settlement asset
///         and one escrow address, fixed at construction. The arbiter and
///         feeBps inside spend() params are chosen by the spender and
///         validated by the escrow (fee 150–300 bps); pinning the arbiter
///         here is a future config if holders ask. Caps are CONSERVATIVE:
///         committed spend is never refunded back into the budget — a
///         cancelled escrow returns funds but does not restore cap room.
interface GuardToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract BudgetGuard {
    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------
    error NotHolder();
    error NotSpender();
    error Paused();
    error InvalidAddress();
    error ZeroAmount();
    error WrongToken();
    error InsufficientBudget();
    error PerCounterpartyCapExceeded();
    error PerDayCapExceeded();
    error TotalCapExceeded();

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------
    address public immutable holder;       // the account holder: deposits, withdraws, sets caps
    address public spender;                // the agent; 0 = spends disabled
    GuardToken public immutable token;      // the only settlement asset this guard may spend
    Hire402Escrow public immutable escrow;  // the only escrow it funds through

    uint256 public capPerCounterparty;     // 0 = uncapped
    uint256 public capPerDay;              // 0 = uncapped
    uint256 public capTotal;               // 0 = uncapped
    bool public paused;                     // blocks new spends; holder ops + release control unaffected

    mapping(address => uint256) public spentPerCounterparty; // seller → committed lifetime
    uint256 public currentDay;              // block.timestamp / 1 days (UTC)
    uint256 public spentToday;
    uint256 public spentTotal;

    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }
    modifier onlyHolder() {
        if (msg.sender != holder) revert NotHolder();
        _;
    }
    modifier onlySpender() {
        if (msg.sender != spender) revert NotSpender();
        _;
    }
    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // -----------------------------------------------------------------
    // Events
    // -----------------------------------------------------------------
    event Deposited(uint256 amount);
    event Withdrawn(uint256 amount);
    event SpenderSet(address indexed oldSpender, address indexed newSpender);
    event CapsSet(uint256 perCounterparty, uint256 perDay, uint256 total);
    event PauseSet(bool paused);
    event EscrowSpent(uint256 indexed escrowId, address indexed seller, uint256 amount, uint256 spentToday, uint256 spentTotal);
    event EscrowApprovedThrough(uint256 indexed escrowId, uint256 indexed index);
    event EscrowDisputedThrough(uint256 indexed escrowId, uint256 indexed index);
    event EscrowCancelledThrough(uint256 indexed escrowId);
    event EscrowRefundedThrough(uint256 indexed escrowId, uint256 indexed index);

    // -----------------------------------------------------------------
    // Construction
    // -----------------------------------------------------------------
    constructor(address token_, address escrow_, address holder_, address spender_) {
        if (token_ == address(0) || escrow_ == address(0) || holder_ == address(0)) revert InvalidAddress();
        token = GuardToken(token_);
        escrow = Hire402Escrow(escrow_);
        holder = holder_;
        spender = spender_;
        currentDay = block.timestamp / 1 days;
        // Standing approval so escrow.fund() can pull from this guard. The
        // guard holds capped-purpose funds only, the escrow is the only
        // puller, and the approval is public and auditable on-chain.
        token.approve(escrow_, type(uint256).max);
    }

    // -----------------------------------------------------------------
    // Holder operations (custody + config; no cap logic)
    // -----------------------------------------------------------------
    /// @notice Holder tops up the guard's budget.
    function deposit(uint256 amount) external onlyHolder nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit Deposited(amount);
        token.transferFrom(holder, address(this), amount);
    }

    /// @notice Holder pulls funds out — to the holder, always. Refunds that
    ///         returned to the guard are withdrawable at any time.
    function withdraw(uint256 amount) external onlyHolder nonReentrant {
        if (amount == 0) revert ZeroAmount();
        emit Withdrawn(amount);
        token.transfer(holder, amount);
    }

    /// @notice Sets the agent (0 disables spends; in-flight escrows stay controllable).
    function setSpender(address who) external onlyHolder {
        emit SpenderSet(spender, who);
        spender = who;
    }

    /// @notice Sets the caps (0 = uncapped). Caps bound FUTURE commits;
    ///         already-committed spend is not refunded into cap room.
    function setCaps(uint256 perCounterparty, uint256 perDay, uint256 total) external onlyHolder {
        capPerCounterparty = perCounterparty;
        capPerDay = perDay;
        capTotal = total;
        emit CapsSet(perCounterparty, perDay, total);
    }

    /// @notice Pause blocks new spends only. Release control stays live so
    ///         in-flight escrows can still be approved, disputed, or cancelled.
    function setPaused(bool p) external onlyHolder {
        paused = p;
        emit PauseSet(p);
    }

    // -----------------------------------------------------------------
    // Agent operations
    // -----------------------------------------------------------------
    /// @notice The ONLY way the agent can move money: create and fund one
    ///         escrow within every set cap, atomically. The guard is the
    ///         buyer; refunds return here, never to the agent.
    function spend(Hire402Escrow.CreateParams calldata p)
        external
        onlySpender
        whenNotPaused
        nonReentrant
        returns (uint256 escrowId)
    {
        if (address(p.token) != address(token)) revert WrongToken();
        if (p.seller == address(0)) revert InvalidAddress();

        uint256 total;
        for (uint256 i = 0; i < p.milestones.length; ++i) {
            total += p.milestones[i].amount; // checked math reverts on overflow
        }
        if (total == 0) revert ZeroAmount();

        _rollDay();
        if (capPerCounterparty != 0 && spentPerCounterparty[p.seller] + total > capPerCounterparty) {
            revert PerCounterpartyCapExceeded();
        }
        if (capPerDay != 0 && spentToday + total > capPerDay) {
            revert PerDayCapExceeded();
        }
        if (capTotal != 0 && spentTotal + total > capTotal) {
            revert TotalCapExceeded();
        }
        if (token.balanceOf(address(this)) < total) revert InsufficientBudget();

        // effects first, then the external calls (CEI)
        spentPerCounterparty[p.seller] += total;
        spentToday += total;
        spentTotal += total;

        escrowId = escrow.create(p); // buyer = this guard
        escrow.fund(escrowId);       // pulls from the guard's balance via its standing approval

        emit EscrowSpent(escrowId, p.seller, total, spentToday, spentTotal);
    }

    // ----- buyer-side release control: passthroughs (money can only
    // ----- return here; the guard's and escrow's reentrancy locks are
    // ----- separate storage, so nesting is safe)
    /// @notice Approve a milestone (release path; not gated by pause).
    function approve(uint256 escrowId, uint256 index) external onlySpender nonReentrant {
        escrow.approve(escrowId, index);
        emit EscrowApprovedThrough(escrowId, index);
    }

    /// @notice Freeze a milestone into dispute (no funds move).
    function dispute(uint256 escrowId, uint256 index, string calldata reasonURI) external onlySpender {
        escrow.dispute(escrowId, index, reasonURI);
        emit EscrowDisputedThrough(escrowId, index);
    }

    /// @notice Cancel — refunds come back to the guard, not the agent.
    function cancel(uint256 escrowId) external onlySpender nonReentrant {
        escrow.cancel(escrowId);
        emit EscrowCancelledThrough(escrowId);
    }

    /// @notice Deadline-expiry refund — same destination rule.
    function expireRefund(uint256 escrowId, uint256 index) external onlySpender nonReentrant {
        escrow.expireRefund(escrowId, index);
        emit EscrowRefundedThrough(escrowId, index);
    }

    // -----------------------------------------------------------------
    // Views (for the agent to pre-check; the reverts are the source of truth)
    // -----------------------------------------------------------------
    function heldBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function perCounterpartyRemaining(address seller) external view returns (uint256) {
        if (capPerCounterparty == 0) return type(uint256).max;
        uint256 spent = spentPerCounterparty[seller];
        return spent >= capPerCounterparty ? 0 : capPerCounterparty - spent;
    }

    function perDayRemaining() external view returns (uint256) {
        if (capPerDay == 0) return type(uint256).max;
        uint256 spent = block.timestamp / 1 days == currentDay ? spentToday : 0;
        return spent >= capPerDay ? 0 : capPerDay - spent;
    }

    function totalRemaining() external view returns (uint256) {
        if (capTotal == 0) return type(uint256).max;
        return spentTotal >= capTotal ? 0 : capTotal - spentTotal;
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------
    function _rollDay() private {
        uint256 today = block.timestamp / 1 days;
        if (today != currentDay) {
            currentDay = today;
            spentToday = 0;
        }
    }
}
