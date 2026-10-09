// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReputationAnchor} from "../src/ReputationAnchor.sol";

/// @title DeployAnchor — ReputationAnchor deployer (spec §7 anchoring).
/// @notice Usage:
///         ANCHOR_ANCHORER=0x… forge script script/DeployAnchor.s.sol \
///           --rpc-url $BASE_SEPOLIA_RPC --broadcast --skip-simulation
interface AnchorDeployVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata key) external returns (address);
}

contract DeployAnchor {
    AnchorDeployVm constant vm = AnchorDeployVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external {
        address anchorer = vm.envAddress("ANCHOR_ANCHORER"); // registry operator key
        vm.startBroadcast();
        new ReputationAnchor(anchorer);
        vm.stopBroadcast();
    }
}
