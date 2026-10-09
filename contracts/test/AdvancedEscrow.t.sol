// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdvancedEscrow, Hire402Escrow} from "../src/AdvancedEscrow.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @dev Minimal Foundry cheatcode surface — no forge-std dependency.
interface TestVm {
    function prank(address) external;
    function warp(uint256) external;
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external returns (address);
}

/// @title AdvancedEscrowTest — spec §8 Advances acceptance tests (self-contained).
/// @notice Covers: EIP-712 offer acceptance (desk→seller disbursement, APR
///         bounds 500–800, 80% cap incl. exact boundary, desk-only signer,
///         expiry, seller-only, Active-only, single use per offer); release
///         routing (full repayment with exact 365-day interest, partial
///         routing with a second accrual period, interest-first application);
///         voluntary direct repayment (capped at live debt, no overpayment,
///         paid to the desk recorded at acceptance); buyer-side refunds
///         BLOCKED while debt is outstanding (cancel + deadline expiry;
///         arbiter resolve() stays); one advance per escrow; fee untouched
///         by the rail (still 150 bps).
contract AdvancedEscrowTest {
    TestVm constant vm = TestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Deterministic test identities for the agent wallets.
    uint256 constant BUYER_KEY  = 0xA11CE;
    uint256 constant SELLER_KEY = 0xB0B00;
    uint256 constant DESK_KEY   = 0xDE5C0DE; // the capital desk

    uint16 constant FEE_BPS    = 150;
    uint32 constant CHALLENGE = 600;
    uint128 constant AMOUNT   = 1_000_000; // 1.00 USDC per milestone (6 dp)
    uint128 constant FEE      = 15_000;     // 150 bps of 1.00
    uint128 constant PAYOUT   = 985_000;    // 1.00 − fee

    MockUSDC usdc;
    AdvancedEscrow escrow;
    address buyer;
    address seller;
    address desk;
    address treasury; // = this contract

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        desk = vm.addr(DESK_KEY);
        usdc = new MockUSDC(); // mints 1,000 USDC to this
        escrow = new AdvancedEscrow(address(this), 150, 300, desk);
        treasury = address(this);

        usdc.transfer(buyer, 100_000_000);
        usdc.transfer(desk, 100_000_000);
        usdc.transfer(seller, 100_000_000); // for direct repayments
        vm.prank(buyer); usdc.approve(address(escrow), type(uint256).max);
        vm.prank(desk); usdc.approve(address(escrow), type(uint256).max);
        vm.prank(seller); usdc.approve(address(escrow), type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function _assertEq(uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) revert(string(abi.encodePacked(what, ": got ", _str(got), " want ", _str(want))));
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

    /// Two milestones of 1.00 each — the standard desk-demo shape.
    function _twoMs() internal view returns (Hire402Escrow.MilestoneInit[] memory ms) {
        ms = new Hire402Escrow.MilestoneInit[](2);
        ms[0] = Hire402Escrow.MilestoneInit(AMOUNT, uint64(block.timestamp + 30 days), "ipfs://m0");
        ms[1] = Hire402Escrow.MilestoneInit(AMOUNT, uint64(block.timestamp + 60 days), "ipfs://m1");
    }

    function _activeEscrow() internal returns (uint256 id) {
        vm.prank(buyer);
        id = escrow.create(Hire402Escrow.CreateParams({
            token: address(usdc),
            seller: seller,
            verifier: address(0),
            arbiter: address(0),
            feeBps: FEE_BPS,
            challengeSeconds: CHALLENGE,
            milestones: _twoMs()
        }));
        vm.prank(buyer); escrow.fund(id);
        vm.prank(seller); escrow.start(id);
    }

    function _offer(uint256 id, uint256 principal, uint16 apr, uint64 expiry)
        internal returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = escrow.advanceOfferDigest(id, seller, principal, apr, expiry);
        (v, r, s) = vm.sign(DESK_KEY, digest);
    }

    function _accept(uint256 id, uint256 principal, uint16 apr) internal {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, principal, apr, expiry);
        vm.prank(seller);
        escrow.acceptAdvance(id, principal, apr, expiry, v, r, s);
    }

    function _submitBoth(uint256 id) internal {
        vm.prank(seller); escrow.submit(id, 0, "ipfs://att0");
        vm.prank(seller); escrow.submit(id, 1, "ipfs://att1");
    }

    // ------------------------------------------------------------------
    // Acceptance: desk → seller disbursement, state, bounds
    // ------------------------------------------------------------------
    function test_AcceptAdvance_PaysSeller() public {
        uint256 id = _activeEscrow();
        uint256 sellerBal = usdc.balanceOf(seller);
        uint256 deskBal = usdc.balanceOf(desk);

        _accept(id, 800_000, 600);

        _assertEq(usdc.balanceOf(seller) - sellerBal, 800_000, "seller received advance");
        _assertEq(deskBal - usdc.balanceOf(desk), 800_000, "desk disbursed");
        _assertEq(escrow.advanceDebt(id), 800_000, "debt == principal at t0");
        _assertEq(escrow.remainingReceivables(id), 2_000_000, "receivables intact");
        (uint256 p, uint16 apr,,,) = escrow.getAdvance(id);
        _assertEq(p, 800_000, "advance principal");
        _assertEq(apr, 600, "advance apr");
    }

    function test_AcceptAdvance_CapBoundaryAndExcess() public {
        uint256 id = _activeEscrow();
        _accept(id, 1_600_000, 600); // exactly 80% of 2.00 — allowed
        _assertEq(escrow.advanceDebt(id), 1_600_000, "cap boundary accepted");

        uint256 id2 = _activeEscrow();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id2, 1_600_001, 600, expiry);
        vm.expectRevert(AdvancedEscrow.AdvanceCapExceeded.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id2, 1_600_001, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_OnlyDeskSigns() public {
        uint256 id = _activeEscrow();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        bytes32 digest = escrow.advanceOfferDigest(id, seller, 800_000, 600, expiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SELLER_KEY, digest); // wrong signer
        vm.expectRevert(AdvancedEscrow.NotDesk.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 800_000, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_OfferParamsBound() public {
        // A different principal than the one signed → different digest → NotDesk.
        uint256 id = _activeEscrow();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 800_000, 600, expiry);
        vm.expectRevert(AdvancedEscrow.NotDesk.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 900_000, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_ExpiredOffer() public {
        uint256 id = _activeEscrow();
        uint64 expiry = uint64(block.timestamp - 1);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 800_000, 600, expiry);
        vm.expectRevert(AdvancedEscrow.OfferExpired.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 800_000, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_OnlySeller() public {
        uint256 id = _activeEscrow();
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 800_000, 600, expiry);
        vm.expectRevert(Hire402Escrow.NotSeller.selector);
        vm.prank(buyer); // buyer is not the seller
        escrow.acceptAdvance(id, 800_000, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_OnlyWhenActive() public {
        // Created + Funded, but not started → InvalidState.
        vm.prank(buyer);
        uint256 id = escrow.create(Hire402Escrow.CreateParams({
            token: address(usdc),
            seller: seller,
            verifier: address(0),
            arbiter: address(0),
            feeBps: FEE_BPS,
            challengeSeconds: CHALLENGE,
            milestones: _twoMs()
        }));
        vm.prank(buyer); escrow.fund(id);

        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 800_000, 600, expiry);
        vm.expectRevert(Hire402Escrow.InvalidState.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 800_000, 600, expiry, v, r, s);
    }

    function test_AcceptAdvance_AprBounds() public {
        uint256 id = _activeEscrow();
        uint64 expiry = uint64(block.timestamp + 1 hours);

        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 800_000, 400, expiry);
        vm.expectRevert(AdvancedEscrow.AprOutOfBounds.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 800_000, 400, expiry, v, r, s);

        (v, r, s) = _offer(id, 800_000, 900, expiry);
        vm.expectRevert(AdvancedEscrow.AprOutOfBounds.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 800_000, 900, expiry, v, r, s);
    }

    function test_AcceptAdvance_NoDuplicateWhileActive() public {
        uint256 id = _activeEscrow();
        _accept(id, 800_000, 600);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 100_000, 600, expiry);
        vm.expectRevert(AdvancedEscrow.AdvanceExists.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 100_000, 600, expiry, v, r, s);
    }

    // ------------------------------------------------------------------
    // Release routing: desk first, interest first, remainder to seller
    // ------------------------------------------------------------------
    function test_ReleaseRouting_FullRepayment() public {
        uint256 id = _activeEscrow();
        _submitBoth(id);
        _accept(id, 800_000, 600); // 0.80 @ 6%

        uint256 sellerBal = usdc.balanceOf(seller);
        uint256 deskBal = usdc.balanceOf(desk);
        uint256 treasuryBal = usdc.balanceOf(treasury);

        vm.warp(block.timestamp + 365 days); // exactly one accrual year
        vm.prank(buyer);
        escrow.approve(id, 0);

        // interest = 0.80 × 6% = 0.048; debt = 0.848 ≤ payout 0.985
        _assertEq(usdc.balanceOf(desk) - deskBal, 848_000, "desk repaid principal + interest");
        _assertEq(usdc.balanceOf(seller) - sellerBal, 985_000 - 848_000, "seller remainder");
        _assertEq(usdc.balanceOf(treasury) - treasuryBal, FEE, "fee untouched (150 bps)");
        _assertEq(escrow.advanceDebt(id), 0, "debt cleared");

        (uint256 p, uint16 apr, uint256 accrued, , ) = escrow.getAdvance(id);
        _assertEq(p, 0, "principal cleared");
        _assertEq(accrued, 0, "interest cleared");
        _assertEq(apr, 600, "apr retained");
    }

    function test_ReleaseRouting_PartialThenSecondAccrualPeriod() public {
        uint256 id = _activeEscrow();
        _submitBoth(id);
        _accept(id, 1_600_000, 800); // cap boundary, 8% APR

        uint256 sellerBal = usdc.balanceOf(seller);
        uint256 deskBal = usdc.balanceOf(desk);

        vm.warp(block.timestamp + 365 days);
        vm.prank(buyer);
        escrow.approve(id, 0);

        // debt = 1.60 + 0.128 = 1.728 > payout 0.985 → desk takes ALL
        _assertEq(usdc.balanceOf(desk) - deskBal, 985_000, "desk takes whole payout");
        _assertEq(usdc.balanceOf(seller) - sellerBal, 0, "seller gets nothing");
        (uint256 p, , , , ) = escrow.getAdvance(id);
        _assertEq(p, 1_600_000 - (985_000 - 128_000), "remaining principal 0.743");
        _assertEq(escrow.advanceDebt(id), 743_000, "debt after partial");

        uint256 deskBal2 = usdc.balanceOf(desk);
        uint256 sellerBal2 = usdc.balanceOf(seller);

        vm.warp(block.timestamp + 365 days); // second accrual period
        vm.prank(buyer);
        escrow.approve(id, 1);

        // interest = 0.743 × 8% = 0.05944; debt = 0.80244 ≤ payout 0.985
        _assertEq(usdc.balanceOf(desk) - deskBal2, 743_000 + 59_440, "desk repaid in second period");
        _assertEq(usdc.balanceOf(seller) - sellerBal2, 985_000 - 802_440, "seller remainder");
        _assertEq(escrow.advanceDebt(id), 0, "debt cleared");

        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "escrow Complete");
    }

    function test_RepayAdvance_DirectThenPlainRelease() public {
        uint256 id = _activeEscrow();
        _submitBoth(id);
        _accept(id, 800_000, 600);

        vm.warp(block.timestamp + 365 days);
        uint256 debt = escrow.advanceDebt(id);
        _assertEq(debt, 848_000, "live debt after one year");

        uint256 deskBal = usdc.balanceOf(desk);
        uint256 sellerBal = usdc.balanceOf(seller);
        vm.prank(seller);
        escrow.repayAdvance(id, 1_000_000_000); // overpays — capped at debt

        _assertEq(usdc.balanceOf(desk) - deskBal, 848_000, "desk repaid directly");
        _assertEq(sellerBal - usdc.balanceOf(seller), 848_000, "seller paid exact debt");
        _assertEq(escrow.advanceDebt(id), 0, "debt cleared");

        vm.prank(buyer);
        escrow.approve(id, 0);

        _assertEq(usdc.balanceOf(desk) - deskBal, 848_000, "desk gets nothing at release");
        _assertEq(usdc.balanceOf(seller) - (sellerBal - 848_000), 985_000, "plain release to seller");
    }

    function test_RefundNotRoutedToDesk() public {
        uint256 id = _activeEscrow();
        vm.prank(seller); escrow.submit(id, 0, "ipfs://att0");
        _accept(id, 800_000, 600);

        uint256 buyerBal = usdc.balanceOf(buyer);
        uint256 deskBal = usdc.balanceOf(desk);

        vm.warp(block.timestamp + 300); // inside the challenge window
        vm.prank(buyer);
        escrow.dispute(id, 0, "ipfs://reason");
        escrow.resolve(id, 0, false, "ipfs://verdict"); // arbiter = this contract

        _assertEq(usdc.balanceOf(buyer) - buyerBal, 1_000_000, "buyer refunded in FULL");
        _assertEq(usdc.balanceOf(desk) - deskBal, 0, "desk untouched by refund");
        _assertEq(escrow.advanceDebt(id), 800_000, "debt survives refund");
    }

    function test_AcceptAdvance_OfferSingleUse() public {
        uint256 id = _activeEscrow();
        _submitBoth(id);
        _accept(id, 800_000, 600);

        vm.prank(buyer);
        escrow.approve(id, 0); // no warp → interest 0; debt 0.80 ≤ payout 0.985

        _assertEq(escrow.advanceDebt(id), 0, "debt cleared");

        // A fresh desk signature for the same escrow is refused: one offer,
        // one consumption — repay-then-replay buys nothing. (Signature first:
        // the digest staticcall would otherwise consume the expectRevert.)
        uint64 expiry = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _offer(id, 500_000, 500, expiry);
        vm.expectRevert(AdvancedEscrow.OfferUsed.selector);
        vm.prank(seller);
        escrow.acceptAdvance(id, 500_000, 500, expiry, v, r, s);
    }

    function test_FeeUnchangedByRail() public {
        uint256 id = _activeEscrow();
        _submitBoth(id);
        _accept(id, 800_000, 600);

        uint256 treasuryBal = usdc.balanceOf(treasury);
        vm.prank(buyer);
        escrow.approve(id, 0);

        _assertEq(usdc.balanceOf(treasury) - treasuryBal, FEE, "fee still exactly 150 bps");

        (, uint256 released, , uint256 feesPaid, ) = escrow.getEscrowTotals(id);
        _assertEq(released, 1_000_000, "gross released accounting unchanged");
        _assertEq(feesPaid, FEE, "feesPaid accounting unchanged");
    }

    // ------------------------------------------------------------------
    // v0.2 fund-safety gates: buyer refunds vs live advances, sink-at-
    // acceptance. (Each test below is a regression: it reverts on the
    // pre-v0.2 contract.)
    // ------------------------------------------------------------------

    function test_Cancel_BlockedWhileAdvanceOutstanding() public {
        uint256 id = _activeEscrow();
        uint256 buyerBal = usdc.balanceOf(buyer);
        uint256 deskBal = usdc.balanceOf(desk); // BEFORE the advance payout
        _accept(id, 800_000, 600);

        // The drain shape: buyer cancels after the desk has paid out.
        vm.prank(buyer);
        vm.expectRevert(AdvancedEscrow.AdvanceOutstanding.selector);
        escrow.cancel(id);

        // Debt repaid → the gate opens; the desk is made whole first.
        vm.prank(seller);
        escrow.repayAdvance(id, 800_000); // no warp → interest 0
        vm.prank(buyer);
        escrow.cancel(id);

        _assertEq(usdc.balanceOf(buyer) - buyerBal, 2_000_000, "buyer refunded in full");
        _assertEq(usdc.balanceOf(desk) - deskBal, 0, "desk made whole");
        _assertEq(escrow.advanceDebt(id), 0, "no stranded debt");
    }

    function test_ExpireRefund_BlockedWhileAdvanceOutstanding() public {
        uint256 id = _activeEscrow();
        _accept(id, 800_000, 600);
        vm.warp(block.timestamp + 61 days); // past milestone 0's 30-day deadline

        vm.prank(buyer);
        vm.expectRevert(AdvancedEscrow.AdvanceOutstanding.selector);
        escrow.expireRefund(id, 0);
    }

    function test_Repay_GoesToDeskRecordedAtAcceptance() public {
        uint256 id = _activeEscrow();
        _accept(id, 800_000, 600);

        // The owner rotates the desk mid-loan.
        escrow.setDesk(address(0xBEEF));

        uint256 oldDeskBal = usdc.balanceOf(desk);
        uint256 newDeskBal = usdc.balanceOf(address(0xBEEF));

        vm.prank(seller);
        escrow.repayAdvance(id, 800_000);

        _assertEq(usdc.balanceOf(desk) - oldDeskBal, 800_000, "repaid to the desk recorded at acceptance");
        _assertEq(usdc.balanceOf(address(0xBEEF)) - newDeskBal, 0, "new desk gets nothing");
    }
}


