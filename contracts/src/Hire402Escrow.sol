// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title Hire402Escrow — non-custodial milestone escrow for the machine economy.
/// @notice Reference implementation of Hire402 Protocol Spec v0.1 §5
///         (docs/protocol-spec.md). Agents are principals: buyers and
///         sellers are autonomous agent wallets. Funds move ONLY through
///         terminal milestone transitions — no admin path can ever move
///         escrowed funds.
///
///         Lifecycle (spec §5.2):
///           Created → Funded → Active → Complete | Cancelled
///           Per milestone:
///             Pending → Submitted → Approved → Released (terminal)
///             Submitted → Disputed → resolve(arbiter) → Released | Refunded
///             Pending → Refunded (expiry / cancel; terminal)
///
///         Release rules:
///           - buyer approves on-chain (`approve`), or
///           - buyer signs an EIP-712 approval off-chain; seller `claim`s
///             with the signature inside the challenge window, or
///           - the challenge window elapses undisputed; seller `claim`s
///             without a signature (optimistic release).
///
///         Fees: `fee = amount × feeBps / 10_000`, charged on release only;
///         refunds are fee-free. `minFeeBps ≤ feeBps ≤ maxFeeBps` (deploy
///         config; recommended 150/300).
/// @dev    Self-contained: no external dependencies. USDC assumed (6
///         decimals) but any IERC20 works.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract Hire402Escrow {
    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------
    error NotBuyer();
    error NotSeller();
    error NotArbiter();
    error NotPartyOrVerifier();
    error NotOwner();
    error InvalidAddress();
    error InvalidParams();
    error InvalidState();
    error TooManyMilestones();
    error InvalidStatus();
    error DeadlinePassed();
    error DeadlineNotPassed();
    error WindowClosed();
    error StartWindowPassed();
    error InvalidSignature();
    error SignatureExpired();
    error FeeCapExceeded();
    error FeeTooLow();
    error TransferFailed();
    error CannotCancel();

    // -----------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------
    enum EscrowState { Created, Funded, Active, Complete, Cancelled }
    enum MStatus { Pending, Submitted, Approved, Released, Disputed, Refunded }
    enum RefundReason { DisputeOutcome, Expiry, Cancelled }

    struct Milestone {
        uint128 amount;           // settlement-asset units (USDC 6dp)
        uint64  deadline;         // latest submission time (unix); 0 = none
        uint64  submittedAt;      // 0 = not yet submitted
        MStatus status;
        bool    resolvedRelease;  // arbiter outcome once terminal
        string  descriptionURI;   // what was ordered
        string  attestationURI;   // proof of work submitted
    }

    struct MilestoneInit {
        uint128 amount;
        uint64  deadline;
        string  descriptionURI;
    }

    struct CreateParams {
        address token;             // settlement asset (e.g. USDC)
        address seller;            // the selling agent
        address verifier;         // optional; 0 = none
        address arbiter;           // optional; 0 = deploy default
        uint16  feeBps;             // protocol take on release
        uint32  challengeSeconds;  // dispute window after submission
        MilestoneInit[] milestones;
    }

    struct Escrow {
        address buyer;
        address seller;
        address verifier;
        address arbiter;
        address token;
        uint16  feeBps;
        uint32  challengeSeconds;
        uint64  fundedAt;          // 0 = not funded
        uint256 totalAmount;
        uint256 released;          // gross released (payout + fee)
        uint256 refunded;
        uint256 feesPaid;
        EscrowState state;
        Milestone[] milestones;
    }

    // -----------------------------------------------------------------
    // Constants
    // -----------------------------------------------------------------
    uint64  public constant START_WINDOW    = 3 days;  // seller must start within this of funding
    uint32  public constant MIN_CHALLENGE   = 60;      // challenge-window bounds
    uint32  public constant MAX_CHALLENGE   = 30 days;
    uint256 public constant MAX_MILESTONES  = 50;
    uint16  public constant ABS_MAX_FEE_BPS = 300;     // deploy-time ceiling

    // EIP-712 (spec §5.4)
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant MILESTONE_APPROVAL_TYPEHASH = keccak256(
        "MilestoneApproval(uint256 escrowId,uint256 milestoneIndex,uint256 amount,uint64 sigExpiry)"
    );
    string public constant NAME    = "Hire402Escrow";
    string public constant VERSION = "1";

    // -----------------------------------------------------------------
    // Storage
    // -----------------------------------------------------------------
    address public owner;           // admin for config only; can never move escrowed funds
    address public treasury;        // fee sink
    address public defaultArbiter;  // used when create.arbiter == 0
    uint16  public minFeeBps;
    uint16  public maxFeeBps;
    uint256 public escrowCount;

    mapping(uint256 => Escrow) internal _escrows;

    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "REENTRANCY");
        _locked = 2;
        _;
        _locked = 1;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // -----------------------------------------------------------------
    // Events (indexer contract — spec §5.6)
    // -----------------------------------------------------------------
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        address verifier,
        address arbiter,
        address token,
        uint256 totalAmount,
        uint16 feeBps,
        uint32 challengeSeconds,
        uint256 milestoneCount
    );
    event EscrowFunded(uint256 indexed escrowId, uint256 totalAmount);
    event EscrowStarted(uint256 indexed escrowId);
    event MilestoneSubmitted(uint256 indexed escrowId, uint256 indexed index, string attestationURI);
    event MilestoneApproved(uint256 indexed escrowId, uint256 indexed index, address indexed approver);
    event MilestoneReleased(
        uint256 indexed escrowId,
        uint256 indexed index,
        address indexed payee,
        uint256 payout,
        uint256 fee
    );
    event MilestoneRefunded(uint256 indexed escrowId, uint256 indexed index, uint256 amount, RefundReason reason);
    event MilestoneDisputed(uint256 indexed escrowId, uint256 indexed index, address indexed disputer, string reasonURI);
    event MilestoneResolved(
        uint256 indexed escrowId,
        uint256 indexed index,
        address indexed arbiter,
        bool releaseToSeller,
        string verdictURI
    );
    event EscrowCompleted(uint256 indexed escrowId, uint256 released, uint256 refunded, uint256 feesPaid);
    event EscrowCancelled(uint256 indexed escrowId, uint256 refundedAmount);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event DefaultArbiterUpdated(address oldArbiter, address newArbiter);

    // -----------------------------------------------------------------
    // Construction & admin (config only — never touches escrowed funds)
    // -----------------------------------------------------------------
    constructor(address treasury_, uint16 minFeeBps_, uint16 maxFeeBps_) {
        if (treasury_ == address(0)) revert InvalidAddress();
        if (maxFeeBps_ == 0 || maxFeeBps_ > ABS_MAX_FEE_BPS || minFeeBps_ > maxFeeBps_) revert InvalidParams();
        owner = msg.sender;
        treasury = treasury_;
        defaultArbiter = treasury_;
        minFeeBps = minFeeBps_;
        maxFeeBps = maxFeeBps_;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert InvalidAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setDefaultArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert InvalidAddress();
        emit DefaultArbiterUpdated(defaultArbiter, newArbiter);
        defaultArbiter = newArbiter;
    }

    // -----------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------

    /// @notice Buyer creates an escrow with ordered milestones. State: Created.
    function create(CreateParams calldata p) external returns (uint256 escrowId) {
        if (p.seller == address(0) || p.token == address(0)) revert InvalidAddress();
        if (p.milestones.length == 0 || p.milestones.length > MAX_MILESTONES) revert TooManyMilestones();
        if (p.feeBps > maxFeeBps) revert FeeCapExceeded();
        if (p.feeBps < minFeeBps) revert FeeTooLow();
        if (p.challengeSeconds < MIN_CHALLENGE || p.challengeSeconds > MAX_CHALLENGE) revert InvalidParams();

        escrowId = ++escrowCount;
        Escrow storage e = _escrows[escrowId];
        e.buyer = msg.sender;
        e.seller = p.seller;
        e.verifier = p.verifier;
        e.arbiter = p.arbiter == address(0) ? defaultArbiter : p.arbiter;
        e.token = p.token;
        e.feeBps = p.feeBps;
        e.challengeSeconds = p.challengeSeconds;
        e.state = EscrowState.Created;

        uint256 total;
        for (uint256 i = 0; i < p.milestones.length; ++i) {
            MilestoneInit calldata m = p.milestones[i];
            if (m.amount == 0) revert InvalidParams();
            total += m.amount; // checked math reverts on overflow
            e.milestones.push(
                Milestone({
                    amount: m.amount,
                    deadline: m.deadline,
                    submittedAt: 0,
                    status: MStatus.Pending,
                    resolvedRelease: false,
                    descriptionURI: m.descriptionURI,
                    attestationURI: ""
                })
            );
        }
        e.totalAmount = total;

        emit EscrowCreated(
            escrowId,
            msg.sender,
            p.seller,
            p.verifier,
            e.arbiter,
            p.token,
            total,
            p.feeBps,
            p.challengeSeconds,
            p.milestones.length
        );
    }

    /// @notice Buyer funds the full amount. State: Funded. Escrow contract holds funds.
    function fund(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != EscrowState.Created) revert InvalidState();
        e.state = EscrowState.Funded;
        e.fundedAt = uint64(block.timestamp);
        emit EscrowFunded(escrowId, e.totalAmount);
        _safeTransferFrom(IERC20(e.token), e.buyer, address(this), e.totalAmount);
    }

    /// @notice Seller starts work. State: Active. Must occur within START_WINDOW of funding.
    function start(uint256 escrowId) external {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.seller) revert NotSeller();
        if (e.state != EscrowState.Funded) revert InvalidState();
        if (block.timestamp > e.fundedAt + START_WINDOW) revert StartWindowPassed();
        e.state = EscrowState.Active;
        emit EscrowStarted(escrowId);
    }

    /// @notice Seller submits proof of work for a milestone. Opens the challenge window.
    function submit(uint256 escrowId, uint256 index, string calldata attestationURI) external {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.seller) revert NotSeller();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Pending) revert InvalidStatus();
        if (m.deadline != 0 && block.timestamp > m.deadline) revert DeadlinePassed();
        m.submittedAt = uint64(block.timestamp);
        m.status = MStatus.Submitted;
        m.attestationURI = attestationURI;
        emit MilestoneSubmitted(escrowId, index, attestationURI);
    }

    /// @notice Buyer approves on-chain; the milestone releases immediately.
    function approve(uint256 escrowId, uint256 index) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Submitted) revert InvalidStatus();
        emit MilestoneApproved(escrowId, index, msg.sender);
        _release(e, escrowId, index);
    }

    /// @notice Seller claims a submitted milestone.
    ///         Inside the challenge window: requires the buyer's EIP-712
    ///         approval signature (off-chain, gas-free for the buyer).
    ///         After the window with no dispute: optimistic release,
    ///         no signature needed.
    function claim(uint256 escrowId, uint256 index, uint8 v, bytes32 r, bytes32 s, uint64 sigExpiry)
        external
        nonReentrant
    {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.seller) revert NotSeller();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Submitted) revert InvalidStatus();

        if (block.timestamp <= m.submittedAt + e.challengeSeconds) {
            // Window open: buyer's signed approval required.
            if (sigExpiry < block.timestamp) revert SignatureExpired();
            bytes32 digest = _approvalDigest(escrowId, index, m.amount, sigExpiry);
            address signer = _recover(digest, v, r, s);
            if (signer != e.buyer) revert InvalidSignature();
            emit MilestoneApproved(escrowId, index, signer);
        } else {
            // Window elapsed, undisputed: optimistic release.
            emit MilestoneApproved(escrowId, index, address(0));
        }
        _release(e, escrowId, index);
    }

    /// @notice Buyer or verifier disputes a submitted milestone within the
    ///         challenge window. Freezes the milestone for arbiter resolution.
    function dispute(uint256 escrowId, uint256 index, string calldata reasonURI) external {
        Escrow storage e = _escrow(escrowId);
        bool isVerifier = e.verifier != address(0) && msg.sender == e.verifier;
        if (msg.sender != e.buyer && !isVerifier) revert NotPartyOrVerifier();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Submitted) revert InvalidStatus();
        if (block.timestamp > m.submittedAt + e.challengeSeconds) revert WindowClosed();
        m.status = MStatus.Disputed;
        emit MilestoneDisputed(escrowId, index, msg.sender, reasonURI);
    }

    /// @notice Arbiter resolves a disputed milestone. Release or refund; final.
    function resolve(uint256 escrowId, uint256 index, bool releaseToSeller, string calldata verdictURI)
        external
        nonReentrant
    {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.arbiter) revert NotArbiter();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Disputed) revert InvalidStatus();
        m.resolvedRelease = releaseToSeller;
        emit MilestoneResolved(escrowId, index, msg.sender, releaseToSeller, verdictURI);
        if (releaseToSeller) {
            _release(e, escrowId, index);
        } else {
            _refund(e, escrowId, index, RefundReason.DisputeOutcome);
        }
    }

    /// @notice Buyer reclaims a milestone the seller never submitted before
    ///         its deadline. Fee-free.
    function expireRefund(uint256 escrowId, uint256 index) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state != EscrowState.Active) revert InvalidState();
        Milestone storage m = _milestone(e, index);
        if (m.status != MStatus.Pending) revert InvalidStatus();
        if (m.deadline == 0 || block.timestamp <= m.deadline) revert DeadlineNotPassed();
        _refund(e, escrowId, index, RefundReason.Expiry);
    }

    /// @notice Buyer cancels. Allowed in Created (nothing held), Funded
    ///         (full refund — seller never started), or Active only while
    ///         every milestone is still Pending. Fee-free.
    function cancel(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (e.state == EscrowState.Created) {
            e.state = EscrowState.Cancelled;
            emit EscrowCancelled(escrowId, 0);
            return;
        }
        if (e.state == EscrowState.Funded) {
            e.state = EscrowState.Cancelled;
            uint256 amount = e.totalAmount;
            emit EscrowCancelled(escrowId, amount);
            _safeTransfer(IERC20(e.token), e.buyer, amount);
            return;
        }
        if (e.state == EscrowState.Active) {
            for (uint256 i = 0; i < e.milestones.length; ++i) {
                if (e.milestones[i].status != MStatus.Pending) revert CannotCancel();
            }
            e.state = EscrowState.Cancelled;
            uint256 amount = e.totalAmount;
            emit EscrowCancelled(escrowId, amount);
            _safeTransfer(IERC20(e.token), e.buyer, amount);
            return;
        }
        revert InvalidState();
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------
    function _escrow(uint256 escrowId) internal view returns (Escrow storage) {
        if (escrowId == 0 || escrowId > escrowCount) revert InvalidParams();
        return _escrows[escrowId];
    }

    function _milestone(Escrow storage e, uint256 index) internal view returns (Milestone storage) {
        if (index >= e.milestones.length) revert InvalidParams();
        return e.milestones[index];
    }

    /// @dev Virtual: `AdvancedEscrow` overrides this to route advance
    ///      repayment to the capital desk before the seller (spec §8).
    function _release(Escrow storage e, uint256 escrowId, uint256 index) internal virtual {
        Milestone storage m = e.milestones[index];
        m.status = MStatus.Released;
        uint256 fee = (uint256(m.amount) * e.feeBps) / 10_000;
        uint256 payout = m.amount - fee;
        e.released += m.amount;
        e.feesPaid += fee;
        if (fee > 0) {
            _safeTransfer(IERC20(e.token), treasury, fee);
        }
        _safeTransfer(IERC20(e.token), e.seller, payout);
        emit MilestoneReleased(escrowId, index, e.seller, payout, fee);
        _completeIfDone(e, escrowId);
    }

    function _refund(Escrow storage e, uint256 escrowId, uint256 index, RefundReason reason) private {
        Milestone storage m = e.milestones[index];
        m.status = MStatus.Refunded;
        e.refunded += m.amount;
        _safeTransfer(IERC20(e.token), e.buyer, m.amount);
        emit MilestoneRefunded(escrowId, index, m.amount, reason);
        _completeIfDone(e, escrowId);
    }

    function _completeIfDone(Escrow storage e, uint256 escrowId) internal {
        if (e.state != EscrowState.Active) return;
        for (uint256 i = 0; i < e.milestones.length; ++i) {
            MStatus s = e.milestones[i].status;
            if (s != MStatus.Released && s != MStatus.Refunded) return;
        }
        e.state = EscrowState.Complete;
        emit EscrowCompleted(escrowId, e.released, e.refunded, e.feesPaid);
    }

    function _approvalDigest(uint256 escrowId, uint256 index, uint128 amount, uint64 sigExpiry)
        private
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash = keccak256(abi.encode(MILESTONE_APPROVAL_TYPEHASH, escrowId, index, amount, sigExpiry));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        if (v != 27 && v != 28) revert InvalidSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
        return signer;
    }

    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------
    function approvalDigest(uint256 escrowId, uint256 index, uint128 amount, uint64 sigExpiry)
        external
        view
        returns (bytes32)
    {
        return _approvalDigest(escrowId, index, amount, sigExpiry);
    }

    function getEscrowCore(uint256 escrowId)
        external
        view
        returns (
            address buyer,
            address seller,
            address verifier,
            address arbiter,
            address token,
            uint16 feeBps,
            uint32 challengeSeconds,
            EscrowState state
        )
    {
        Escrow storage e = _escrow(escrowId);
        return (e.buyer, e.seller, e.verifier, e.arbiter, e.token, e.feeBps, e.challengeSeconds, e.state);
    }

    function getEscrowTotals(uint256 escrowId)
        external
        view
        returns (uint256 totalAmount, uint256 released, uint256 refunded, uint256 feesPaid, uint64 fundedAt)
    {
        Escrow storage e = _escrow(escrowId);
        return (e.totalAmount, e.released, e.refunded, e.feesPaid, e.fundedAt);
    }

    function milestoneCount(uint256 escrowId) external view returns (uint256) {
        return _escrow(escrowId).milestones.length;
    }

    function getMilestone(uint256 escrowId, uint256 index)
        external
        view
        returns (uint128 amount, uint64 deadline, uint64 submittedAt, MStatus status, bool resolvedRelease)
    {
        Escrow storage e = _escrow(escrowId);
        Milestone storage m = _milestone(e, index);
        return (m.amount, m.deadline, m.submittedAt, m.status, m.resolvedRelease);
    }

    function getMilestoneURIs(uint256 escrowId, uint256 index)
        external
        view
        returns (string memory descriptionURI, string memory attestationURI)
    {
        Escrow storage e = _escrow(escrowId);
        Milestone storage m = _milestone(e, index);
        return (m.descriptionURI, m.attestationURI);
    }





}
