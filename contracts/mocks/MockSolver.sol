// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISettlementCallback} from "../interfaces/ISettlementCallback.sol";

/// @notice Test solver that pays out `toToken` from its own inventory.
contract MockSolver is ISettlementCallback {
    /// @dev Amount of `toToken` to deliver, in basis points of `minToAmount`.
    uint256 public payoutBps = 10_000;

    bool public shouldRevert;

    /// @dev When set, the callback asserts it already holds `fromAmount` of `fromToken`,
    /// which is only true if settlement forwards the sell token before calling back. It is
    /// the difference between a solver that funds the buy side from the user's money and
    /// one that fronts it from inventory.
    bool public requireSellTokenReceived;

    error SolverFailure();
    error SellTokenNotReceived(uint256 held, uint256 expected);

    function setPayoutBps(uint256 bps) external {
        payoutBps = bps;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setRequireSellTokenReceived(bool value) external {
        requireSellTokenReceived = value;
    }

    function settlementCallback(
        address fromToken,
        uint256 fromAmount,
        address toToken,
        uint256 minToAmount,
        bytes calldata /* data */
    ) external override {
        if (shouldRevert) revert SolverFailure();
        if (requireSellTokenReceived) {
            uint256 held = IERC20(fromToken).balanceOf(address(this));
            if (held < fromAmount) revert SellTokenNotReceived(held, fromAmount);
        }
        IERC20(toToken).transfer(
            msg.sender,
            (minToAmount * payoutBps) / 10_000
        );
    }
}
