// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BudgetGuard} from "../src/BudgetGuard.sol";

/// @title DeployBudgetGuard — BudgetGuard deployer (Base Sepolia first, then Base).
/// @notice Self-contained (no forge-std dependency). The broadcasting
///         account MUST be GUARD_HOLDER — it constructs the guard and
///         calls setCaps in the same broadcast (holder-only function).
/// @dev    Usage:
///         GUARD_TOKEN=0x… GUARD_ESCROW=0x… GUARD_HOLDER=0x… GUARD_SPENDER=0x… \
///         GUARD_CAP_PER_COUNTERPARTY=… GUARD_CAP_PER_DAY=… GUARD_CAP_TOTAL=… \
///         forge script script/DeployBudgetGuard.s.sol --rpc-url $BASE_SEPOLIA_RPC \
///           --broadcast --verify
interface DeployBudgetVm {
    function startBroadcast() external;
    function stopBroadcast() external;
    function envAddress(string calldata key) external returns (address);
    function envUint(string calldata key) external returns (uint256);
}

contract DeployBudgetGuardScript {
    DeployBudgetVm constant vm = DeployBudgetVm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);

    function run() external {
        address token = vm.envAddress("GUARD_TOKEN");           // settlement asset (USDC)
        address escrow = vm.envAddress("GUARD_ESCROW");          // the escrow it funds through
        address holder = vm.envAddress("GUARD_HOLDER");         // the account holder (= broadcaster)
        address spender = vm.envAddress("GUARD_SPENDER");       // the agent; 0 = spends disabled
        uint256 capPerCounterparty = vm.envUint("GUARD_CAP_PER_COUNTERPARTY"); // 0 = uncapped
        uint256 capPerDay = vm.envUint("GUARD_CAP_PER_DAY");
        uint256 capTotal = vm.envUint("GUARD_CAP_TOTAL");

        vm.startBroadcast();
        BudgetGuard guard = new BudgetGuard(token, escrow, holder, spender);
        guard.setCaps(capPerCounterparty, capPerDay, capTotal);
        vm.stopBroadcast();
    }
}
