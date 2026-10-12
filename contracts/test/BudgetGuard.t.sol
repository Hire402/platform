// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BudgetGuard} from "../src/BudgetGuard.sol";
import {Hire402Escrow} from "../src/Hire402Escrow.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @dev Minimal Foundry cheatcode surface (no forge-std dependency).
interface GuardTestVm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external returns (address);
}

/// @title BudgetGuardTest — spec §5.8 acceptance tests (self-contained).
/// @notice Covers: holder custody (deposit/withdraw holder-only, refunds
///         return to the guard and NEVER to the agent, cap room is not
///         restored on refund — conservative); on-chain caps (per-
///         counterparty incl. isolation, per UTC day incl. rollover,
///         total incl. exact-boundary); only-spender spends + disable;
///         pause blocks spends but not release control; wrong-token and
///         insufficient-budget reverts are atomic (no accounting, no
///         escrow); the full spend → start → submit → approve-through-guard
///         flow (fee to treasury, payout to seller).
contract BudgetGuardTest {
    GuardTestVm constant vm = GuardTestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Deterministic test identities: the account holder and the agent.
    uint256 constant HOLDER_KEY = 0xA11CE;     // the account holder
    uint256 constant AGENT_KEY  = 0xB0B00;    // the spending agent
    uint256 constant SELLER_KEY = 0xDE5C0DE;  // the counterparty agent

    uint16 constant FEE_BPS   = 150;
    uint32 constant CHALLENGE = 600;

    MockUSDC usdc;
    MockUSDC otherToken;
    Hire402Escrow escrow;
    BudgetGuard guard;

    address holder;
    address agent;
    address seller;

    function setUp() public {
        holder = vm.addr(HOLDER_KEY);
        agent = vm.addr(AGENT_KEY);
        seller = vm.addr(SELLER_KEY);

        usdc = new MockUSDC();       // mints 1M USDC to this test contract
        otherToken = new MockUSDC();
        escrow = new Hire402Escrow(address(this), FEE_BPS, 300); // treasury = this test contract
        guard = new BudgetGuard(address(usdc), address(escrow), holder, agent);

        usdc.transfer(holder, 10_000_000); // 10.00 USDC
        vm.prank(holder);
        usdc.approve(address(guard), type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function assertEq(uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) revert(string(abi.encodePacked(what, ": got ", _str(got), " want ", _str(want))));
    }

    function assertEqAddr(address got, address want, string memory what) internal pure {
        if (got != want) revert(string(abi.encodePacked(what, ": address mismatch")));
    }

    function _str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v;
        uint256 len;
        while (n > 0) { len++; n /= 10; }
        bytes memory b = new bytes(len);
        for (uint256 i = len; i > 0; i--) { b[i - 1] = bytes1(uint8(48 + (v % 10))); v /= 10; }
        return string(b);
    }

    function _params(address token_, address seller_, uint128 amount)
        internal view returns (Hire402Escrow.CreateParams memory p)
    {
        Hire402Escrow.MilestoneInit[] memory ms = new Hire402Escrow.MilestoneInit[](1);
        ms[0] = Hire402Escrow.MilestoneInit(amount, uint64(block.timestamp + 30 days), "ipfs://m0");
        p = Hire402Escrow.CreateParams({
            token: token_,
            seller: seller_,
            verifier: address(0),
            arbiter: address(0),
            feeBps: FEE_BPS,
            challengeSeconds: CHALLENGE,
            milestones: ms
        });
    }

    function _spend(address seller_, uint128 amount) internal returns (uint256 id) {
        vm.prank(agent);
        id = guard.spend(_params(address(usdc), seller_, amount));
    }

    function _deposit(uint256 amount) internal {
        vm.prank(holder);
        guard.deposit(amount);
    }

    // ------------------------------------------------------------------
    // Custody: the holder owns the money; the agent never touches it
    // ------------------------------------------------------------------
    function test_Custody_HolderOnlyDepositWithdraw() public {
        _deposit(10_000_000);
        assertEq(guard.heldBalance(), 10_000_000, "guard holds deposit");

        vm.prank(holder);
        guard.withdraw(4_000_000);
        assertEq(usdc.balanceOf(holder), 4_000_000, "withdrawal to the holder");
        assertEq(guard.heldBalance(), 6_000_000, "guard holds remainder");

        vm.prank(agent);
        vm.expectRevert(BudgetGuard.NotHolder.selector);
        guard.deposit(1_000_000);

        vm.prank(seller);
        vm.expectRevert(BudgetGuard.NotHolder.selector);
        guard.withdraw(1_000_000);
    }

    // ------------------------------------------------------------------
    // spend(): the only money path — atomic create+fund within the caps
    // ------------------------------------------------------------------
    function test_SpendCreatesAndFundsEscrow() public {
        _deposit(10_000_000);
        uint256 id = _spend(seller, 2_000_000); // caps all 0 = uncapped

        assertEq(escrow.escrowCount(), 1, "escrow created");
        (address buyer,,,,,,, Hire402Escrow.EscrowState st) = escrow.getEscrowCore(id);
        assertEqAddr(buyer, address(guard), "guard is the buyer");
        assertEq(uint8(st), 1, "funded (state 1) atomically at spend");
        assertEq(guard.heldBalance(), 8_000_000, "escrow funded from the guard's balance");
        assertEq(guard.spentTotal(), 2_000_000, "total committed");
        assertEq(guard.spentPerCounterparty(seller), 2_000_000, "per-counterparty committed");
        assertEq(guard.spentToday(), 2_000_000, "today committed");
    }

    function test_CapPerCounterparty() public {
        _deposit(10_000_000);
        vm.prank(holder);
        guard.setCaps(3_000_000, 0, 0);

        _spend(seller, 2_000_000); // 2 ≤ 3 ok
        vm.expectRevert(BudgetGuard.PerCounterpartyCapExceeded.selector);
        _spend(seller, 2_000_000); // 2 + 2 > 3

        _spend(address(0x51), 2_000_000); // a different counterparty is isolated
        assertEq(guard.spentPerCounterparty(seller), 2_000_000, "first seller unchanged");
        assertEq(guard.spentPerCounterparty(address(0x51)), 2_000_000, "second seller counted");
    }

    function test_CapPerDay_Rollover() public {
        _deposit(10_000_000);
        vm.prank(holder);
        guard.setCaps(0, 3_000_000, 0);

        _spend(seller, 2_000_000);
        vm.expectRevert(BudgetGuard.PerDayCapExceeded.selector);
        _spend(address(0x51), 2_000_000); // 2 + 2 > 3 same UTC day

        vm.warp(block.timestamp + 1 days); // next UTC day
        _spend(address(0x52), 2_000_000); // ok — the day rolled
        assertEq(guard.spentToday(), 2_000_000, "today's counter reset then counted");
    }

    function test_CapTotal_Boundary() public {
        _deposit(10_000_000);
        vm.prank(holder);
        guard.setCaps(0, 0, 5_000_000);

        _spend(seller, 3_000_000);
        vm.expectRevert(BudgetGuard.TotalCapExceeded.selector);
        _spend(address(0x51), 3_000_000); // 3 + 3 > 5
        _spend(address(0x52), 2_000_000); // 3 + 2 = 5 — exactly at the cap passes
        assertEq(guard.spentTotal(), 5_000_000, "total at the cap");
    }

    function test_OnlySpenderSpends() public {
        _deposit(10_000_000);
        vm.prank(holder);
        vm.expectRevert(BudgetGuard.NotSpender.selector);
        guard.spend(_params(address(usdc), seller, 1_000_000));

        vm.prank(seller);
        vm.expectRevert(BudgetGuard.NotSpender.selector);
        guard.spend(_params(address(usdc), seller, 1_000_000));

        // setSpender(0) disables spends entirely
        vm.prank(holder);
        guard.setSpender(address(0));
        vm.expectRevert(BudgetGuard.NotSpender.selector);
        _spend(seller, 1_000_000);
    }

    function test_Pause_BlocksSpendNotReleaseControl() public {
        _deposit(10_000_000);
        uint256 id = _spend(seller, 2_000_000);

        vm.prank(seller);
        escrow.start(id);
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://att0");

        vm.prank(holder);
        guard.setPaused(true);

        vm.expectRevert(BudgetGuard.Paused.selector);
        _spend(address(0x51), 1_000_000); // new spends blocked while paused

        uint256 treasuryBefore = usdc.balanceOf(address(this));
        vm.prank(agent);
        guard.approve(id, 0); // release control stays live while paused
        assertEq(usdc.balanceOf(seller), 1_970_000, "seller paid through the guard while paused");
        assertEq(usdc.balanceOf(address(this)) - treasuryBefore, 30_000, "fee to treasury");
    }

    function test_WrongToken_RevertsAtomically() public {
        _deposit(10_000_000);
        vm.prank(agent);
        vm.expectRevert(BudgetGuard.WrongToken.selector);
        guard.spend(_params(address(otherToken), seller, 1_000_000));
        assertEq(guard.spentTotal(), 0, "no commit on wrong token");
    }

    function test_InsufficientBudget_RevertsAtomically() public {
        _deposit(1_000_000);
        vm.expectRevert(BudgetGuard.InsufficientBudget.selector);
        _spend(seller, 2_000_000);
        assertEq(guard.spentTotal(), 0, "cap accounting untouched");
        assertEq(escrow.escrowCount(), 0, "no escrow created");
    }

    function test_CancelReturnsToGuardNotAgent() public {
        _deposit(10_000_000);
        uint256 id = _spend(seller, 2_000_000);

        uint256 agentBefore = usdc.balanceOf(agent);
        vm.prank(agent);
        guard.cancel(id); // Funded, seller never started → full refund

        assertEq(guard.heldBalance(), 10_000_000, "refund returned to the GUARD");
        assertEq(usdc.balanceOf(agent), agentBefore, "the agent got nothing");
        assertEq(guard.spentTotal(), 2_000_000, "cap room NOT restored (conservative)");
        (,,,,,,, Hire402Escrow.EscrowState st) = escrow.getEscrowCore(id);
        assertEq(uint8(st), 4, "escrow Cancelled (state 4)");
    }

    function test_FullFlowThroughGuard() public {
        uint256 treasuryBefore = usdc.balanceOf(address(this));
        _deposit(10_000_000);
        uint256 id = _spend(seller, 2_000_000);

        vm.prank(seller);
        escrow.start(id);
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://att0");
        vm.prank(agent);
        guard.approve(id, 0);

        assertEq(usdc.balanceOf(seller), 1_970_000, "seller payout net of fee");
        assertEq(usdc.balanceOf(address(this)) - treasuryBefore, 30_000, "150 bps fee to treasury");
        assertEq(guard.heldBalance(), 8_000_000, "no further guard funds moved at release");

        (, uint256 released,, uint256 feesPaid,) = escrow.getEscrowTotals(id);
        assertEq(released, 2_000_000, "gross released accounting");
        assertEq(feesPaid, 30_000, "feesPaid accounting");
    }
}
