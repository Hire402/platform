// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReputationAnchor} from "../src/ReputationAnchor.sol";

/// @dev Minimal Foundry cheatcode surface — no forge-std dependency.
interface AnchorTestVm {
    function prank(address) external;
    function expectRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external returns (address);
}

/// @title ReputationAnchorTest — spec §7 anchoring acceptance (self-contained).
/// @notice Covers: consecutive anchoring (no gaps), gap reversion, duplicate
///         epoch reversion, anchorer-only authority, empty-root rejection,
///         views, and anchorer rotation.
contract ReputationAnchorTest {
    AnchorTestVm constant vm = AnchorTestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 constant ANCHORER_KEY = 0xA11CE;
    uint256 constant OTHER_KEY = 0xB0B00;

    ReputationAnchor anchor;
    address anchorer;
    address other;

    function setUp() public {
        anchorer = vm.addr(ANCHORER_KEY);
        other = vm.addr(OTHER_KEY);
        anchor = new ReputationAnchor(anchorer);
    }

    function _anchor(uint256 epoch, bytes32 root) internal {
        vm.prank(anchorer);
        anchor.anchor(epoch, root, 3);
    }

    function test_SequenceStartsAtOne() public {
        bytes32 root = keccak256("epoch-1");
        _anchor(1, root);
        (bytes32 r, uint256 leaves, bool anchored) = anchor.epochAt(1);
        _assertEq(uint256(r), uint256(root), "epoch 1 root stored");
        _assertEq(leaves, 3, "epoch 1 leaf count");
        _assertEq(anchored ? 1 : 0, 1, "epoch 1 anchored flag");
        _assertEq(anchor.latestEpoch(), 1, "latest epoch");
    }

    function test_ConsecutiveAnchoringNoGaps() public {
        _anchor(1, keccak256("e1"));
        _anchor(2, keccak256("e2"));
        _anchor(3, keccak256("e3"));
        _assertEq(anchor.latestEpoch(), 3, "three consecutive epochs");
        _assertEq(uint256(anchor.roots(3)), uint256(keccak256("e3")), "latest root");
    }

    function test_GapReverts() public {
        _anchor(1, keccak256("e1"));
        vm.expectRevert(ReputationAnchor.InvalidEpoch.selector);
        vm.prank(anchorer);
        anchor.anchor(3, keccak256("skip"), 1); // 1 → 3 is a gap
    }

    function test_DuplicateEpochReverts() public {
        _anchor(1, keccak256("e1"));
        vm.expectRevert(ReputationAnchor.InvalidEpoch.selector);
        vm.prank(anchorer);
        anchor.anchor(1, keccak256("again"), 1); // same epoch is also invalid
    }

    function test_OnlyAnchorer() public {
        vm.expectRevert(ReputationAnchor.NotAnchorer.selector);
        vm.prank(other);
        anchor.anchor(1, keccak256("e1"), 1);
    }

    function test_EmptyRootReverts() public {
        vm.expectRevert(ReputationAnchor.EmptyRoot.selector);
        vm.prank(anchorer);
        anchor.anchor(1, bytes32(0), 1);
    }

    function test_AnchorerRotation() public {
        vm.prank(other);
        vm.expectRevert(ReputationAnchor.NotOwner.selector);
        anchor.setAnchorer(other); // not the owner

        anchor.setAnchorer(other); // owner (this test contract) rotates
        vm.prank(other);
        anchor.anchor(1, keccak256("e1"), 1); // the new anchorer works
        _assertEq(anchor.latestEpoch(), 1, "new anchorer anchored");
    }

    function _assertEq(uint256 got, uint256 want, string memory what) internal pure {
        if (got != want) revert(string(abi.encodePacked(what, ": got ", _str(got), " want ", _str(want))));
    }
    function _str(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 n = v; uint256 len;
        while (n > 0) { len++; n /= 10; }
        bytes memory b = new bytes(len);
        for (uint256 i = len; i > 0; i--) { b[i - 1] = bytes1(uint8(48 + (v % 10))); v /= 10; }
        return string(b);
    }
}
