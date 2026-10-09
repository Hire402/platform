// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Hire402Escrow, IERC20} from "./Hire402Escrow.sol";

/// @title AdvancedEscrow — Hire402Escrow + the capital-desk advance rail.
/// @notice Reference implementation of Hire402 Protocol Spec §8 Advances.
///         Working capital against escrowed receivables, non-custodial:
///
///           desk signs AdvanceOffer (EIP-712, off-chain — the credit-score
///           gate ≥ 500 is desk policy there; the formula is public and its
///           inputs are on-chain)
///              → seller `acceptAdvance`s on-chain: principal flows desk →
///                seller DIRECTLY (this contract never holds desk funds)
///              → at each milestone release the routing becomes:
///                  fee                → treasury   (unchanged, 150 bps)
///                  min(payout, debt)  → desk       (interest first)
///                  remainder          → seller
///
///         Bounds (spec §8): APR 500–800 bps (5–8%); advance ≤ 80% of
///         remaining receivables (Pending + Submitted milestones); simple
///         interest, per-second accrual, 365-day year.
///
///         Refunds are NOT intercepted: the buyer's full refund right is
///         untouched — a refunded milestone leaves the advance as the
///         seller's outstanding debt (repayable via `repayAdvance` or
///         against later releases; the desk priced this risk at signing).
///
///         Inherited `MilestoneReleased.payout` reports the seller's ACTUAL
///         receipt (post-routing), so metabolic accounting stays truthful.
contract AdvancedEscrow is Hire402Escrow {
    // -----------------------------------------------------------------
    // Errors
    // -----------------------------------------------------------------
    error NotDesk();
    error OfferExpired();
    error AprOutOfBounds();
    error AdvanceCapExceeded();
    error AdvanceExists();
    error NoAdvance();
    error OfferUsed();           // an offer signature is consumable once
    error AdvanceOutstanding();  // buyer-side refunds blocked while debt lives

    // -----------------------------------------------------------------
    // Constants (spec §8)
    // -----------------------------------------------------------------
    uint16 public constant MIN_APR_BPS  = 500;   // 5% floor
    uint16 public constant MAX_APR_BPS  = 800;   // 8% ceiling
    uint16 public constant ADVANCE_BPS  = 8_000; // 80% of receivables
    uint64 public constant YEAR         = 365 days;

    // EIP-712 (spec §8): the desk's off-chain offer
    bytes32 public constant ADVANCE_OFFER_TYPEHASH = keccak256(
        "AdvanceOffer(uint256 escrowId,address seller,uint256 principal,uint16 aprBps,uint64 offerExpiry)"
    );
    string public constant ADV_NAME    = "Hire402AdvancedEscrow";
    string public constant ADV_VERSION = "1";

    // -----------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------
    struct Advance {
        uint256 principal;        // outstanding principal
        uint16  aprBps;            // 500–800
        uint64  lastAccrual;       // timestamp of last interest accrual
        uint256 accruedInterest;   // interest accrued, unpaid
        uint256 totalRepaid;       // lifetime principal + interest repaid
        address desk;             // repayment sink — recorded at acceptance
        bool    offerUsed;         // one offer signature, one consumption
    }

    // -----------------------------------------------------------------
    // Storage (appended after Hire402Escrow — fresh deployment)
    // -----------------------------------------------------------------
    address public desk;                    // capital desk (repayment sink)
    mapping(uint256 => Advance) private _advances; // per escrowId

    // -----------------------------------------------------------------
    // Events (indexer contract — spec §8)
    // -----------------------------------------------------------------
    event AdvanceAccepted(uint256 indexed escrowId, address indexed seller, uint256 principal, uint16 aprBps);
    event AdvanceRepaidFromRelease(
        uint256 indexed escrowId,
        uint256 indexed index,
        uint256 toDesk,
        uint256 interestPart,
        uint256 principalPart,
        uint256 remainingPrincipal
    );
    event AdvanceRepaid(
        uint256 indexed escrowId,
        address indexed payer,
        uint256 amount,
        uint256 interestPart,
        uint256 principalPart,
        uint256 remainingPrincipal
    );
    event DeskUpdated(address oldDesk, address newDesk);

    constructor(address treasury_, uint16 minFeeBps_, uint16 maxFeeBps_, address desk_)
        Hire402Escrow(treasury_, minFeeBps_, maxFeeBps_)
    {
        if (desk_ == address(0)) revert InvalidAddress();
        desk = desk_;
    }

    /// @notice Replaces the desk. Affects NEW advances only — every advance
    ///         records its repayment sink at acceptance (Advance.desk), so
    ///         a rotation can never redirect repayments of live debt.
    function setDesk(address newDesk) external onlyOwner {
        if (newDesk == address(0)) revert InvalidAddress();
        emit DeskUpdated(desk, newDesk);
        desk = newDesk;
    }

    // -----------------------------------------------------------------
    // Advance rail
    // -----------------------------------------------------------------

    /// @notice Seller accepts the desk's signed offer. Principal flows
    ///         desk → seller immediately; repayment is auto-routed at every
    ///         subsequent milestone release. One advance per escrow: the
    ///         offer signature is consumed at acceptance (a second borrowing
    ///         needs a fresh escrow).
    function acceptAdvance(
        uint256 escrowId,
        uint256 principal,
        uint16 aprBps,
        uint64 offerExpiry,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        if (msg.sender != e.seller) revert NotSeller();
        if (e.state != EscrowState.Active) revert InvalidState();
        if (principal == 0) revert InvalidParams();
        if (aprBps < MIN_APR_BPS || aprBps > MAX_APR_BPS) revert AprOutOfBounds();
        if (offerExpiry < block.timestamp) revert OfferExpired();

        bytes32 digest = _offerDigest(escrowId, e.seller, principal, aprBps, offerExpiry);
        address signer = _recover(digest, v, r, s);
        if (signer != desk) revert NotDesk();

        Advance storage a = _advances[escrowId];
        if (a.principal != 0 || a.accruedInterest != 0) revert AdvanceExists();
        if (a.offerUsed) revert OfferUsed();
        if (principal > (remainingReceivables(escrowId) * ADVANCE_BPS) / 10_000) revert AdvanceCapExceeded();

        a.principal = principal;
        a.aprBps = aprBps;
        a.lastAccrual = uint64(block.timestamp);
        a.desk = desk;      // repayment sink frozen at acceptance
        a.offerUsed = true; // the offer signature is consumed for good

        _safeTransferFrom(IERC20(e.token), desk, e.seller, principal);
        emit AdvanceAccepted(escrowId, e.seller, principal, aprBps);
    }

    /// @notice Voluntary direct repayment (anyone may pay on the seller's
    ///         behalf). Interest first; no overpayment beyond live debt.
    ///         Paid to the desk recorded at acceptance.
    function repayAdvance(uint256 escrowId, uint256 amount) external nonReentrant {
        Escrow storage e = _escrow(escrowId);
        Advance storage a = _advances[escrowId];
        if (a.principal == 0 && a.accruedInterest == 0) revert NoAdvance();
        _accrue(a);
        uint256 debt = a.principal + a.accruedInterest;
        uint256 pay = amount > debt ? debt : amount;
        if (pay == 0) revert InvalidParams();
        uint256 interestPart = pay < a.accruedInterest ? pay : a.accruedInterest;
        uint256 principalPart = pay - interestPart;
        a.accruedInterest -= interestPart;
        a.principal -= principalPart;
        a.totalRepaid += pay;
        _safeTransferFrom(IERC20(e.token), msg.sender, a.desk, pay);
        emit AdvanceRepaid(escrowId, msg.sender, pay, interestPart, principalPart, a.principal);
    }

    // -----------------------------------------------------------------
    // Buyer-side refund gates: the desk's principal must leave through
    // repayment, never through a buyer-controlled refund path (spec §8).
    // (No re-entrancy modifier here by design: the guard lives in the base
    // implementations, and re-applying it would double-lock the shared
    // storage flag. The checks below are pure views.)
    // -----------------------------------------------------------------

    /// @notice Cancel is blocked while an advance is outstanding — a
    ///         buyer who also controls the seller could otherwise take an
    ///         advance, cancel, and refund in full, stranding the desk's
    ///         debt on a Cancelled escrow. Arbiter `resolve()` refunds are
    ///         not gated: that is a third-party judgment, priced by the
    ///         desk's 80% cap.
    function cancel(uint256 escrowId) public override {
        if (advanceDebt(escrowId) != 0) revert AdvanceOutstanding();
        super.cancel(escrowId);
    }

    /// @notice Same gate on deadline-expiry refunds.
    function expireRefund(uint256 escrowId, uint256 index) public override {
        if (advanceDebt(escrowId) != 0) revert AdvanceOutstanding();
        super.expireRefund(escrowId, index);
    }

    // -----------------------------------------------------------------
    // Release routing override (the advance rail's settlement hook)
    // -----------------------------------------------------------------
    function _release(Escrow storage e, uint256 escrowId, uint256 index) internal override {
        Milestone storage m = e.milestones[index];
        m.status = MStatus.Released;
        uint256 fee = (uint256(m.amount) * e.feeBps) / 10_000;
        uint256 payout = m.amount - fee;
        e.released += m.amount;
        e.feesPaid += fee;

        // Desk first (spec §8): interest-first application of live debt.
        uint256 sellerNet = payout;
        Advance storage a = _advances[escrowId];
        if (a.principal != 0 || a.accruedInterest != 0) {
            _accrue(a);
            uint256 debt = a.principal + a.accruedInterest;
            uint256 toDesk = payout < debt ? payout : debt;
            uint256 interestPart = toDesk < a.accruedInterest ? toDesk : a.accruedInterest;
            uint256 principalPart = toDesk - interestPart;
            a.accruedInterest -= interestPart;
            a.principal -= principalPart;
            a.totalRepaid += toDesk;
            _safeTransfer(IERC20(e.token), a.desk, toDesk);
            sellerNet = payout - toDesk;
            emit AdvanceRepaidFromRelease(escrowId, index, toDesk, interestPart, principalPart, a.principal);
        }

        if (fee > 0) {
            _safeTransfer(IERC20(e.token), treasury, fee);
        }
        if (sellerNet > 0) {
            _safeTransfer(IERC20(e.token), e.seller, sellerNet);
        }
        // payout field = the seller's ACTUAL receipt (post-routing) so
        // metabolic accounting (spec §7) stays truthful.
        emit MilestoneReleased(escrowId, index, e.seller, sellerNet, fee);
        _completeIfDone(e, escrowId);
    }

    // -----------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------
    function _accrue(Advance storage a) private {
        a.accruedInterest += (a.principal * a.aprBps * (block.timestamp - a.lastAccrual)) / (10_000 * YEAR);
        a.lastAccrual = uint64(block.timestamp);
    }

    function _offerDigest(uint256 escrowId, address seller, uint256 principal, uint16 aprBps, uint64 offerExpiry)
        private
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(ADV_NAME)),
                keccak256(bytes(ADV_VERSION)),
                block.chainid,
                address(this)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(ADVANCE_OFFER_TYPEHASH, escrowId, seller, principal, aprBps, offerExpiry));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    // -----------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------
    function advanceOfferDigest(uint256 escrowId, address seller, uint256 principal, uint16 aprBps, uint64 offerExpiry)
        external
        view
        returns (bytes32)
    {
        return _offerDigest(escrowId, seller, principal, aprBps, offerExpiry);
    }

    /// @notice Live debt: principal + interest accrued to now.
    function advanceDebt(uint256 escrowId) public view returns (uint256) {
        Advance storage a = _advances[escrowId];
        if (a.principal == 0 && a.accruedInterest == 0) return 0;
        uint256 live = a.accruedInterest +
            (a.principal * a.aprBps * (block.timestamp - a.lastAccrual)) / (10_000 * YEAR);
        return a.principal + live;
    }

    /// @notice Remaining receivables: Pending + Submitted milestone amounts.
    function remainingReceivables(uint256 escrowId) public view returns (uint256) {
        Escrow storage e = _escrow(escrowId);
        uint256 total;
        for (uint256 i = 0; i < e.milestones.length; ++i) {
            MStatus s = e.milestones[i].status;
            if (s == MStatus.Pending || s == MStatus.Submitted) total += e.milestones[i].amount;
        }
        return total;
    }

    function getAdvance(uint256 escrowId)
        external
        view
        returns (uint256 principal, uint16 aprBps, uint256 accruedInterestNow, uint64 lastAccrual, uint256 totalRepaid)
    {
        Advance storage a = _advances[escrowId];
        uint256 accrued = a.accruedInterest +
            (a.principal * a.aprBps * (block.timestamp - a.lastAccrual)) / (10_000 * YEAR);
        return (a.principal, a.aprBps, accrued, a.lastAccrual, a.totalRepaid);
    }
}

