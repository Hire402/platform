// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title BondVault — staking and slashing for the machine economy's courts.
/// @notice Hire402 Protocol Spec v0.1 §8 (bonds) + §6 (courts).
///         Verifiers stake the settlement asset; authorized slashers (courts)
///         punish incorrect verdicts: 50% of the slash to the harmed
///         counterparty, 50% to the verifier pool.
/// @dev    Self-contained. No admin path can move unstaked funds; slashes
///         are capped at the verifier's stake; state changes precede all
///         external calls (checks-effects-interactions).
interface IBondToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract BondVault {
    error NotOwner();
    error NotSlasher();
    error InvalidAddress();
    error InvalidAmount();

    address public owner;            // admin: slasher set + pool
    address public immutable token;  // settlement asset
    address public pool;             // verifier-pool share of slashes (50%)
    mapping(address => uint256) public stakeOf;
    mapping(address => bool) public slasher;
    uint256 public totalStaked;
    uint256 public totalSlashed;

    event Staked(address indexed verifier, uint256 amount);
    event Unstaked(address indexed verifier, uint256 amount);
    event Slashed(address indexed verifier, address indexed beneficiary, uint256 amount, string reason);
    event SlasherUpdated(address indexed slasher, bool allowed);
    event PoolUpdated(address oldPool, address newPool);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }
    modifier onlySlasher() {
        if (!slasher[msg.sender]) revert NotSlasher();
        _;
    }

    constructor(address token_, address pool_) {
        if (token_ == address(0) || pool_ == address(0)) revert InvalidAddress();
        owner = msg.sender;
        token = token_;
        pool = pool_;
    }

    /// @notice A verifier stakes the settlement asset.
    function stake(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        stakeOf[msg.sender] += amount;
        totalStaked += amount;
        emit Staked(msg.sender, amount);
        _safeTransferFrom(IBondToken(token), msg.sender, address(this), amount);
    }

    /// @notice A verifier unstakes. (v0.1: no lock — a dispute window lock is
    ///         the Phase 2.1 upgrade; slashing at resolution time makes the
    ///         demo safe.)
    function unstake(uint256 amount) external {
        uint256 s = stakeOf[msg.sender];
        if (amount == 0 || s < amount) revert InvalidAmount();
        stakeOf[msg.sender] = s - amount;
        totalStaked -= amount;
        emit Unstaked(msg.sender, amount);
        _safeTransfer(IBondToken(token), msg.sender, amount);
    }

    /// @notice Authorizes a court (or the arbiter) to slash.
    function setSlasher(address who, bool allowed) external onlyOwner {
        slasher[who] = allowed;
        emit SlasherUpdated(who, allowed);
    }

    function setPool(address newPool) external onlyOwner {
        if (newPool == address(0)) revert InvalidAddress();
        emit PoolUpdated(pool, newPool);
        pool = newPool;
    }

    /// @notice Slashes a verifier: 50% to `beneficiary` (the harmed
    ///         counterparty), 50% to the verifier pool. Amount is capped at
    ///         the verifier's stake.
    function slash(address verifier, address beneficiary, uint256 amount, string calldata reason)
        external
        onlySlasher
    {
        uint256 s = stakeOf[verifier];
        uint256 amt = amount > s ? s : amount;
        if (amt == 0) revert InvalidAmount();
        stakeOf[verifier] = s - amt;
        totalStaked -= amt;
        totalSlashed += amt;
        uint256 half = amt / 2;
        emit Slashed(verifier, beneficiary, amt, reason);
        _safeTransfer(IBondToken(token), beneficiary, half);
        _safeTransfer(IBondToken(token), pool, amt - half);
    }

    function _safeTransfer(IBondToken t, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = address(t).call(abi.encodeWithSelector(IBondToken.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(IBondToken t, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            address(t).call(abi.encodeWithSelector(IBondToken.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    error TransferFailed();
}
