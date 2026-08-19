// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Implemented by solvers that source liquidity for a settlement.
interface ISettlementCallback {
    /// @dev Called by the settlement contract after it has custody of `fromAmount` of
    /// `fromToken`. The implementation must transfer at least `minToAmount` of `toToken`
    /// to `msg.sender` (the settlement contract) before returning. The `fromToken` is
    /// paid out to the settlement caller only after this call succeeds.
    function settlementCallback(
        address fromToken,
        uint256 fromAmount,
        address toToken,
        uint256 minToAmount,
        bytes calldata data
    ) external;
}
