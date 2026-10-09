// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BondVault} from "../src/BondVault.sol";

/// @title DeployBondVault — courts staking vault (Base Sepolia).
/// @notice Usage:
///         BOND_TOKEN=0x… BOND_POOL=0x… forge script contracts/script/DeployBondVault.s.sol \
///           --rpc-url $BASE_SEPOLIA_RPC --broadcast
interface BondDeployVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata key) external returns (address);
}

contract DeployBondVault {
    BondDeployVm constant vm = BondDeployVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external {
        address token = vm.envAddress("BOND_TOKEN"); // settlement asset for bonds
        address pool = vm.envAddress("BOND_POOL");   // verifier-pool share of slashes

        vm.startBroadcast();
        new BondVault(token, pool);
        vm.stopBroadcast();
    }
}
