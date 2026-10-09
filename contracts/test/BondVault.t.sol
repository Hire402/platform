// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BondVault} from "../src/BondVault.sol";
import {MockUSDC} from "./MockUSDC.sol";
import {Hire402Escrow} from "../src/Hire402Escrow.sol";

/// @dev Minimal Foundry cheatcode surface (no forge-std dependency).
interface BondTestVm {
    function prank(address) external;
    function expectRevert(bytes4 selector) external;
    function addr(uint256 privateKey) external returns (address);
}

/// @title BondVaultTest — spec §8 acceptance tests (self-contained).
contract BondVaultTest {
    BondTestVm constant vm = BondTestVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    uint256 constant OWNER_KEY = 0xA11CE;
    uint256 constant VERIFIER_KEY = 0xFEED5;
    uint256 constant BAD_VERIFIER_KEY = 0x0BAD5;
    uint256 constant BENEFICIARY_KEY = 0xBEEF5;

    BondVault vault;
    MockUSDC usdc;

    address owner;
    address verifier;
    address badVerifier;
    address beneficiary;

    function setUp() public {
        owner = vm.addr(OWNER_KEY);
        verifier = vm.addr(VERIFIER_KEY);
        badVerifier = vm.addr(BAD_VERIFIER_KEY);
        beneficiary = vm.addr(BENEFICIARY_KEY);

        usdc = new MockUSDC(); // mints 1M USDC to this test contract
        vm.prank(owner);
        vault = new BondVault(address(usdc), owner); // pool = owner for tests
    }

    function _stake(address who, uint256 amount) private {
        vm.prank(who);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(who);
        vault.stake(amount);
    }

    function _fund(address who, uint256 amount) private {
        usdc.transfer(who, amount);
    }

    function test_StakeAndUnstake() public {
        _fund(verifier, 1_500_000);
        _stake(verifier, 1_500_000);

        assertEq(vault.stakeOf(verifier), 1_500_000, "stake recorded");
        assertEq(vault.totalStaked(), 1_500_000, "total staked");
        assertEq(usdc.balanceOf(address(vault)), 1_500_000, "vault holds bond");

        vm.prank(verifier);
        vault.unstake(500_000);
        assertEq(vault.stakeOf(verifier), 1_000_000, "unstake reduces stake");
        assertEq(usdc.balanceOf(verifier), 500_000, "unstake pays out");
    }

    function test_SlashSplitsAndCaps() public {
        _fund(badVerifier, 1_500_000);
        _stake(badVerifier, 1_500_000);

        // owner must be an authorized slasher
        vm.prank(owner);
        vault.setSlasher(owner, true);

        uint256 beneficiaryBefore = usdc.balanceOf(beneficiary);
        uint256 poolBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        vault.slash(badVerifier, beneficiary, 500_000, "incorrect verdict");

        assertEq(vault.stakeOf(badVerifier), 1_000_000, "stake reduced");
        assertEq(vault.totalSlashed(), 500_000, "total slashed");
        assertEq(usdc.balanceOf(beneficiary) - beneficiaryBefore, 250_000, "harmed counterparty share");
        assertEq(usdc.balanceOf(owner) - poolBefore, 250_000, "verifier pool share");

        // slash more than stake → capped
        vm.prank(owner);
        vault.slash(badVerifier, beneficiary, 9_000_000, "second offense");
        assertEq(vault.stakeOf(badVerifier), 0, "stake exhausted");
        assertEq(usdc.balanceOf(beneficiary) - beneficiaryBefore, 750_000, "capped split to beneficiary");
    }

    function test_OnlySlasherCanSlash() public {
        _fund(badVerifier, 1_000_000);
        _stake(badVerifier, 1_000_000);

        vm.prank(verifier);
        vm.expectRevert(BondVault.NotSlasher.selector);
        vault.slash(badVerifier, beneficiary, 100_000, "unauthorized");
    }

    function test_UnstakeTooMuchReverts() public {
        _fund(verifier, 1_000_000);
        _stake(verifier, 1_000_000);

        vm.prank(verifier);
        vm.expectRevert(BondVault.InvalidAmount.selector);
        vault.unstake(2_000_000);
    }

    function _assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string(abi.encodePacked("assertion failed: ", what)));
    }

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        _assertEq(a, b, what);
    }
}
