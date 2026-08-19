// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal example contract: an owner-controlled counter.
contract Counter {
    address public immutable owner;
    uint256 public count;

    event Incremented(address indexed caller, uint256 newCount);
    event Reset(address indexed caller);

    error NotOwner();
    error InvalidAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function increment() external {
        count += 1;
        emit Incremented(msg.sender, count);
    }

    function incrementBy(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        count += amount;
        emit Incremented(msg.sender, count);
    }

    function reset() external onlyOwner {
        count = 0;
        emit Reset(msg.sender);
    }
}
