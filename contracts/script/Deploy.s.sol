// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Hire402Escrow} from "../src/Hire402Escrow.sol";

/// @title Deploy — Hire402Escrow deployer (Base Sepolia first, then Base).
/// @notice Self-contained (no forge-std dependency).
/// @dev    Usage:
///         ESCROW_TREASURY=0x… ESCROW_MIN_FEE_BPS=150 ESCROW_MAX_FEE_BPS=300 \
///         forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC \
///           --broadcast --verify
interface DeployVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata key) external returns (address);
    function envUint(string calldata key) external returns (uint256);
}

contract Deploy {
    DeployVm constant vm = DeployVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external {
        address treasury = vm.envAddress("ESCROW_TREASURY");
        uint256 minFeeBps = vm.envUint("ESCROW_MIN_FEE_BPS"); // protocol take, e.g. 150
        uint256 maxFeeBps = vm.envUint("ESCROW_MAX_FEE_BPS"); // hard cap, e.g. 300

        vm.startBroadcast();
        new Hire402Escrow(treasury, uint16(minFeeBps), uint16(maxFeeBps));
        vm.stopBroadcast();
    }
}
