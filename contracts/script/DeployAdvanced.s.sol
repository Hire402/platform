// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdvancedEscrow} from "../src/AdvancedEscrow.sol";

/// @title DeployAdvanced — AdvancedEscrow deployer (capital desk rail, spec §8).
/// @notice Self-contained (no forge-std dependency).
/// @dev    Usage:
///         ADV_TREASURY=0x… ADV_MIN_FEE_BPS=150 ADV_MAX_FEE_BPS=300 ADV_DESK=0x… \
///         forge script script/DeployAdvanced.s.sol --rpc-url $BASE_SEPOLIA_RPC \
///           --broadcast --skip-simulation
interface AdvDeployVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata key) external returns (address);
    function envUint(string calldata key) external returns (uint256);
}

contract DeployAdvanced {
    AdvDeployVm constant vm = AdvDeployVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external {
        address treasury = vm.envAddress("ADV_TREASURY");
        uint256 minFeeBps = vm.envUint("ADV_MIN_FEE_BPS"); // protocol take, e.g. 150
        uint256 maxFeeBps = vm.envUint("ADV_MAX_FEE_BPS"); // hard cap, e.g. 300
        address desk = vm.envAddress("ADV_DESK");          // capital desk (repayment sink)

        vm.startBroadcast();
        new AdvancedEscrow(treasury, uint16(minFeeBps), uint16(maxFeeBps), desk);
        vm.stopBroadcast();
    }
}
