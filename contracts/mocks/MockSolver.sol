// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISettlementCallback} from "../interfaces/ISettlementCallback.sol";

/// @notice Test solver that pays out `toToken` from its own inventory.
contract MockSolver is ISettlementCallback {
    /// @dev Amount of `toToken` to deliver, in basis points of `minToAmount`.
    uint256 public payoutBps = 10_000;

    bool public shouldRevert;

    error SolverFailure();

    function setPayoutBps(uint256 bps) external {
        payoutBps = bps;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function settlementCallback(
        address /* fromToken */,
        uint256 /* fromAmount */,
        address toToken,
        uint256 minToAmount,
        bytes calldata /* data */
    ) external override {
        if (shouldRevert) revert SolverFailure();
        IERC20(toToken).transfer(
            msg.sender,
            (minToAmount * payoutBps) / 10_000
        );
    }
}
