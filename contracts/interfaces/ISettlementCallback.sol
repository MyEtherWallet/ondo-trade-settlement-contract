// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Implemented by solvers that source liquidity for a settlement.
interface ISettlementCallback {
    /// @dev Called by the settlement contract once `fromAmount` of `fromToken` has been
    /// transferred to this contract, so the implementation can source the buy side with
    /// the user's own funds. It must transfer at least `minToAmount` of `toToken` to
    /// `msg.sender` (the settlement contract) before returning; otherwise settlement
    /// reverts and the `fromToken` transfer unwinds with it.
    function settlementCallback(
        address fromToken,
        uint256 fromAmount,
        address toToken,
        uint256 minToAmount,
        bytes calldata data
    ) external;
}
