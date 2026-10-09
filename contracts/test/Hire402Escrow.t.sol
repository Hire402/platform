// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Hire402Escrow} from "../src/Hire402Escrow.sol";
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

/// @title Hire402EscrowTest — spec §13 acceptance tests (self-contained).
/// @notice Covers creation validation; happy path with fee; optimistic
///         timeout claim; signed claim within the window + replay block;
///         signature expiry; dispute/resolve both ways; arbiter authority;
///         window-close enforcement; expiry refund; cancels; and the
///         Genesis Run fee economics end-to-end.
contract Hire402EscrowTest {
    TestVm constant vm = TestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    // Deterministic test identities for the agent wallets.
    uint256 constant BUYER_KEY = 0xA11CE;
    uint256 constant SELLER_KEY = 0xB0B00;
    uint256 constant ARBITER_KEY = 0xC0DE00;
    uint256 constant VERIFIER_KEY = 0xD1CE00;

    // Production-mirroring fee config: min 150 bps, cap 300 bps.
    uint16 constant FEE_BPS = 150;
    uint32 constant CHALLENGE = 600; // 10 minutes
    uint128 constant AMOUNT = 2_000_000; // 2.00 USDC (6 dp)
    uint128 constant FEE = 30_000; // 150 bps of 2.00 = 0.03 USDC
    uint128 constant PAYOUT = 1_970_000; // 1.97 USDC

    Hire402Escrow escrow;
    MockUSDC usdc;

    address buyer;
    address seller;
    address arbiter;
    address verifier;
    address treasury = address(0xFEE); // fee sink

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        arbiter = vm.addr(ARBITER_KEY);
        verifier = vm.addr(VERIFIER_KEY);

        usdc = new MockUSDC(); // mints 1,000,000 USDC to this test contract
        escrow = new Hire402Escrow(treasury, 150, 300);

        usdc.transfer(buyer, 100_000_000); // 100.00 USDC working balance
        vm.prank(buyer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    function _assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string(abi.encodePacked("assertion failed: ", what)));
    }

    function _assertTrue(bool b, string memory what) internal pure {
        if (!b) revert(string(abi.encodePacked("assertion failed: ", what)));
    }

    function _params() internal view returns (Hire402Escrow.CreateParams memory p) {
        Hire402Escrow.MilestoneInit[] memory ms = new Hire402Escrow.MilestoneInit[](1);
        ms[0] = Hire402Escrow.MilestoneInit({
            amount: AMOUNT,
            deadline: uint64(block.timestamp + 1 days),
            descriptionURI: "ipfs://task"
        });
        p = Hire402Escrow.CreateParams({
            token: address(usdc),
            seller: seller,
            verifier: verifier,
            arbiter: arbiter,
            feeBps: FEE_BPS,
            challengeSeconds: CHALLENGE,
            milestones: ms
        });
    }

    /// Creates → funds → starts a one-milestone escrow with the given deadline.
    function _createActive(uint64 deadline) internal returns (uint256 id) {
        Hire402Escrow.CreateParams memory p = _params();
        p.milestones[0].deadline = deadline;
        vm.prank(buyer);
        id = escrow.create(p);
        vm.prank(buyer);
        escrow.fund(id);
        vm.prank(seller);
        escrow.start(id);
    }

    // ------------------------------------------------------------------
    // Creation validation (spec §5.3 guards)
    // ------------------------------------------------------------------
    function test_CreateValidation() public {
        Hire402Escrow.CreateParams memory p = _params();

        p.seller = address(0);
        vm.expectRevert(Hire402Escrow.InvalidAddress.selector);
        escrow.create(p);

        p = _params();
        p.feeBps = 301; // above the deploy cap
        vm.expectRevert(Hire402Escrow.FeeCapExceeded.selector);
        escrow.create(p);

        p = _params();
        p.feeBps = 100; // below the deploy minimum
        vm.expectRevert(Hire402Escrow.FeeTooLow.selector);
        escrow.create(p);

        p = _params();
        p.challengeSeconds = 30; // below MIN_CHALLENGE
        vm.expectRevert(Hire402Escrow.InvalidParams.selector);
        escrow.create(p);

        p = _params();
        delete p.milestones;
        vm.expectRevert(Hire402Escrow.TooManyMilestones.selector);
        escrow.create(p);
    }

    // ------------------------------------------------------------------
    // Happy path: fund → start → submit → on-chain approve → release
    // ------------------------------------------------------------------
    function test_FundStartSubmitApproveRelease() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));

        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        vm.prank(buyer);
        escrow.approve(id, 0);

        _assertEq(usdc.balanceOf(seller), PAYOUT, "seller payout");
        _assertEq(usdc.balanceOf(treasury), FEE, "treasury fee");
        _assertEq(usdc.balanceOf(buyer), 100_000_000 - AMOUNT, "buyer funded");

        (, uint256 released, , uint256 feesPaid, ) = escrow.getEscrowTotals(id);
        _assertEq(released, AMOUNT, "gross released");
        _assertEq(feesPaid, FEE, "fees paid");

        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }

    // ------------------------------------------------------------------
    // Optimistic release: window elapses undisputed → seller claims, no signature
    // ------------------------------------------------------------------
    function test_OptimisticTimeoutClaim() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        vm.warp(block.timestamp + CHALLENGE + 1); // window elapsed, no dispute

        vm.prank(seller);
        escrow.claim(id, 0, 0, bytes32(0), bytes32(0), 0);

        _assertEq(usdc.balanceOf(seller), PAYOUT, "seller payout");
        _assertEq(usdc.balanceOf(treasury), FEE, "treasury fee");
        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }

    // ------------------------------------------------------------------
    // Signed claim within the window; replay blocked after release
    // ------------------------------------------------------------------
    function test_SignedClaimWithinWindowAndReplayBlocked() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        uint64 sigExpiry = uint64(block.timestamp + 1 hours);
        bytes32 digest = escrow.approvalDigest(id, 0, AMOUNT, sigExpiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);

        vm.prank(seller);
        escrow.claim(id, 0, v, r, s, sigExpiry);
        _assertEq(usdc.balanceOf(seller), PAYOUT, "seller payout");
        _assertEq(usdc.balanceOf(treasury), FEE, "treasury fee");

        // Replay is impossible: the escrow already transitioned to Complete.
        vm.prank(seller);
        vm.expectRevert(Hire402Escrow.InvalidState.selector);
        escrow.claim(id, 0, v, r, s, sigExpiry);
    }

    // ------------------------------------------------------------------
    // In-window claims require a valid, unexpired buyer signature
    // ------------------------------------------------------------------
    function test_ClaimWithinWindowNeedsValidSignature() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        // No signature while the window is open (sigExpiry=0 → expired check
        // fires first; the milestone cannot be claimed either way).
        vm.prank(seller);
        vm.expectRevert(Hire402Escrow.SignatureExpired.selector);
        escrow.claim(id, 0, 0, bytes32(0), bytes32(0), 0);

        // Expired signature.
        uint64 sigExpiry = uint64(block.timestamp - 1);
        bytes32 digest = escrow.approvalDigest(id, 0, AMOUNT, sigExpiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        vm.prank(seller);
        vm.expectRevert(Hire402Escrow.SignatureExpired.selector);
        escrow.claim(id, 0, v, r, s, sigExpiry);
    }

    // ------------------------------------------------------------------
    // Disputes and arbiter resolution
    // ------------------------------------------------------------------
    function test_DisputeThenResolve_Release() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        vm.prank(buyer);
        escrow.dispute(id, 0, "ipfs://complaint");
        (, , , Hire402Escrow.MStatus status, ) = escrow.getMilestone(id, 0);
        _assertEq(uint8(status), uint8(Hire402Escrow.MStatus.Disputed), "Disputed");

        vm.prank(arbiter);
        escrow.resolve(id, 0, true, "ipfs://verdict-release");
        _assertEq(usdc.balanceOf(seller), PAYOUT, "seller paid after verdict");
        _assertEq(usdc.balanceOf(treasury), FEE, "fee on release");

        (, , , , bool resolvedRelease) = escrow.getMilestone(id, 0);
        _assertTrue(resolvedRelease, "resolved as release");
        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }

    function test_DisputeThenResolve_Refund() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        vm.prank(verifier); // the optional third party may dispute too
        escrow.dispute(id, 0, "ipfs://complaint");

        vm.prank(arbiter);
        escrow.resolve(id, 0, false, "ipfs://verdict-refund");
        _assertEq(usdc.balanceOf(buyer), 100_000_000, "buyer refunded in full");
        _assertEq(usdc.balanceOf(seller), 0, "seller nothing");
        _assertEq(usdc.balanceOf(treasury), 0, "refunds are fee-free");
        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }

    function test_ResolveOnlyByArbiter() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");
        vm.prank(buyer);
        escrow.dispute(id, 0, "ipfs://complaint");

        vm.prank(seller);
        vm.expectRevert(Hire402Escrow.NotArbiter.selector);
        escrow.resolve(id, 0, true, "ipfs://fake-verdict");
    }

    function test_DisputeAfterWindowClosed() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");
        vm.warp(block.timestamp + CHALLENGE + 1);

        vm.prank(buyer);
        vm.expectRevert(Hire402Escrow.WindowClosed.selector);
        escrow.dispute(id, 0, "ipfs://too-late");
    }

    // ------------------------------------------------------------------
    // Expiry refund and cancels (all fee-free)
    // ------------------------------------------------------------------
    function test_ExpireRefundAfterDeadline() public {
        uint256 id = _createActive(uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 101);

        vm.prank(buyer);
        escrow.expireRefund(id, 0);
        _assertEq(usdc.balanceOf(buyer), 100_000_000, "buyer refunded");
        _assertEq(usdc.balanceOf(treasury), 0, "no fee on refund");
        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }

    function test_CancelFundedRefundsBuyer() public {
        Hire402Escrow.CreateParams memory p = _params();
        vm.prank(buyer);
        uint256 id = escrow.create(p);
        vm.prank(buyer);
        escrow.fund(id);

        vm.prank(buyer);
        escrow.cancel(id);
        _assertEq(usdc.balanceOf(buyer), 100_000_000, "full refund");
        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Cancelled), "Cancelled");
    }

    function test_CancelActiveBlockedAfterSubmit() public {
        uint256 id = _createActive(uint64(block.timestamp + 1 days));
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation");

        vm.prank(buyer);
        vm.expectRevert(Hire402Escrow.CannotCancel.selector);
        escrow.cancel(id);
    }

    // ------------------------------------------------------------------
    // Genesis Run fee economics (roadmap §2): two milestones totalling
    // 2.00 USDC at 150 bps → seller nets 1.97 USDC, treasury earns 0.03.
    // ------------------------------------------------------------------
    function test_GenesisRunFeeEconomicsE2E() public {
        Hire402Escrow.MilestoneInit[] memory ms = new Hire402Escrow.MilestoneInit[](2);
        ms[0] = Hire402Escrow.MilestoneInit({
            amount: 1_200_000,
            deadline: uint64(block.timestamp + 1 days),
            descriptionURI: "ipfs://research-task"
        });
        ms[1] = Hire402Escrow.MilestoneInit({
            amount: 800_000,
            deadline: uint64(block.timestamp + 1 days),
            descriptionURI: "ipfs://verify-task"
        });

        vm.prank(buyer);
        uint256 id = escrow.create(Hire402Escrow.CreateParams({
            token: address(usdc),
            seller: seller,
            verifier: verifier,
            arbiter: arbiter,
            feeBps: FEE_BPS,
            challengeSeconds: CHALLENGE,
            milestones: ms
        }));
        vm.prank(buyer);
        escrow.fund(id);
        vm.prank(seller);
        escrow.start(id);

        // Milestone 0: submit → buyer approves on-chain.
        vm.prank(seller);
        escrow.submit(id, 0, "ipfs://attestation-0");
        vm.prank(buyer);
        escrow.approve(id, 0);

        // Milestone 1: submit → buyer signs off-chain → seller claims in-window.
        vm.prank(seller);
        escrow.submit(id, 1, "ipfs://attestation-1");
        uint64 sigExpiry = uint64(block.timestamp + 1 hours);
        bytes32 digest = escrow.approvalDigest(id, 1, 800_000, sigExpiry);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(BUYER_KEY, digest);
        vm.prank(seller);
        escrow.claim(id, 1, v, r, s, sigExpiry);

        // Genesis Run economics: $2.00 gross − 150 bps → $1.97 net + $0.03 fee.
        _assertEq(usdc.balanceOf(seller), 1_970_000, "genesis net");
        _assertEq(usdc.balanceOf(treasury), 30_000, "protocol fee");
        _assertEq(usdc.balanceOf(buyer), 98_000_000, "buyer spent exactly 2.00");

        (, uint256 released, , uint256 feesPaid, ) = escrow.getEscrowTotals(id);
        _assertEq(released, 2_000_000, "gross released");
        _assertEq(feesPaid, 30_000, "fees paid");

        (, , , , , , , Hire402Escrow.EscrowState state) = escrow.getEscrowCore(id);
        _assertEq(uint8(state), uint8(Hire402Escrow.EscrowState.Complete), "state Complete");
    }



}
