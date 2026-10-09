// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ReputationAnchor — on-chain anchoring of the registry's reputation
///         Merkle roots (spec §7: "aggregates merkle-anchored on-chain each
///         6h epoch").
/// @notice The registry operator ("anchorer") commits one root per epoch.
///         The chain enforces the GAPLESS SEQUENCE: `epoch` must be exactly
///         `latestEpoch + 1` — an unanchored epoch is a gap and reverts.
///         Epoch ids are sequence numbers anchored on the registry's 6h
///         cadence (EPOCH_SECONDS documents the cadence; wall-clock time is
///         in the anchor tx's block). A restart anchors latestEpoch + 1 with
///         the then-current root, so the sequence never lies and never gaps.
///         Anyone can verify an agent's reputation against an anchored root
///         using a Merkle proof from the registry (GET /v1/anchor/proof/:a).
contract ReputationAnchor {
    error NotAnchorer();
    error NotOwner();
    error InvalidAddress();
    error InvalidEpoch();
    error EmptyRoot();

    event ReputationAnchored(uint256 indexed epoch, bytes32 root, uint256 leafCount);
    event AnchorerUpdated(address oldAnchorer, address newAnchorer);

    uint256 public constant EPOCH_SECONDS = 6 hours; // registry-side cadence (spec §7)

    address public owner = msg.sender;
    address public anchorer;     // the registry operator key
    uint256 public latestEpoch; // strictly consecutive from 1 — no gaps
    mapping(uint256 => bytes32) public roots;
    mapping(uint256 => uint256) public leafCounts;

    constructor(address anchorer_) {
        if (anchorer_ == address(0)) revert InvalidAddress();
        anchorer = anchorer_;
    }

    /// @notice Anchor the next epoch's root. Reverts on any gap.
    function anchor(uint256 epoch, bytes32 root, uint256 leafCount) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (epoch != latestEpoch + 1) revert InvalidEpoch();
        roots[epoch] = root;
        leafCounts[epoch] = leafCount;
        latestEpoch = epoch;
        emit ReputationAnchored(epoch, root, leafCount);
    }

    function setAnchorer(address newAnchorer) external {
        if (msg.sender != owner) revert NotOwner();
        if (newAnchorer == address(0)) revert InvalidAddress();
        emit AnchorerUpdated(anchorer, newAnchorer);
        anchorer = newAnchorer;
    }

    /// @notice Anchored root + leaf count for an epoch (0,0 if never anchored).
    function epochAt(uint256 epoch) external view returns (bytes32 root, uint256 leafCount, bool anchored) {
        bytes32 r = roots[epoch];
        return (r, leafCounts[epoch], r != bytes32(0));
    }
}
