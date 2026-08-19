// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ISettlementCallback} from "./interfaces/ISettlementCallback.sol";

/// @title SwapSettlement
/// @notice Settles a user-signed swap intent against solver-provided liquidity.
/// @dev The user signs an EIP-712 `SwapOrder` and approves this contract for `fromToken`.
/// A solver calls {settle}, which pulls the sell token, hands control to the solver's
/// callback to source the buy token, then pays the user and the solver atomically.
contract SwapSettlement is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SwapOrder {
        address user;
        address fromToken;
        address toToken;
        uint256 fromAmount;
        uint256 minToAmount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 private constant SWAP_ORDER_TYPEHASH = keccak256(
        "SwapOrder(address user,address fromToken,address toToken,uint256 fromAmount,uint256 minToAmount,uint256 nonce,uint256 deadline)"
    );

    /// @notice Tracks consumed order nonces per user.
    mapping(address user => mapping(uint256 nonce => bool used)) public nonceUsed;

    event Settled(
        bytes32 indexed orderHash,
        address indexed user,
        address indexed solver,
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount
    );

    event NonceCancelled(address indexed user, uint256 nonce);

    error OrderExpired(uint256 deadline);
    error NonceAlreadyUsed(address user, uint256 nonce);
    error InvalidSignature();
    error InvalidOrder();
    error InvalidCallbackTarget();
    error InsufficientUserBalance(uint256 available, uint256 required);
    error InsufficientUserAllowance(uint256 available, uint256 required);
    error SellTransferShortfall(uint256 received, uint256 expected);
    error InsufficientOutput(uint256 received, uint256 minimum);

    constructor() EIP712("SwapSettlement", "1") {}

    /// @notice Returns the EIP-712 digest a user must sign for `order`.
    function hashOrder(SwapOrder calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SWAP_ORDER_TYPEHASH,
                    order.user,
                    order.fromToken,
                    order.toToken,
                    order.fromAmount,
                    order.minToAmount,
                    order.nonce,
                    order.deadline
                )
            )
        );
    }

    /// @notice Returns the EIP-712 domain separator used by this contract.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @notice Invalidates one of the caller's order nonces before it is settled.
    function cancelNonce(uint256 nonce) external {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(msg.sender, nonce);
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    /// @notice Settles a signed swap order using liquidity supplied by `callbackTarget`.
    /// @param order The user's swap intent.
    /// @param signature The user's EIP-712 signature over `order`.
    /// @param callbackTarget Solver contract that delivers `toToken` to this contract.
    /// @param callbackData Opaque data forwarded to `callbackTarget`.
    /// @return toAmount Amount of `toToken` delivered to the user.
    function settle(
        SwapOrder calldata order,
        bytes calldata signature,
        address callbackTarget,
        bytes calldata callbackData
    ) external nonReentrant returns (uint256 toAmount) {
        bytes32 orderHash = _validateOrder(order, signature, callbackTarget);

        nonceUsed[order.user][order.nonce] = true;

        IERC20 fromToken = IERC20(order.fromToken);
        IERC20 toToken = IERC20(order.toToken);

        _checkUserFunds(fromToken, order.user, order.fromAmount);

        uint256 fromBalanceBefore = fromToken.balanceOf(address(this));
        uint256 toBalanceBefore = toToken.balanceOf(address(this));

        fromToken.safeTransferFrom(order.user, address(this), order.fromAmount);

        uint256 fromAmount = fromToken.balanceOf(address(this)) - fromBalanceBefore;
        if (fromAmount < order.fromAmount) {
            revert SellTransferShortfall(fromAmount, order.fromAmount);
        }

        ISettlementCallback(callbackTarget).settlementCallback(
            order.fromToken, fromAmount, order.toToken, order.minToAmount, callbackData
        );

        toAmount = toToken.balanceOf(address(this)) - toBalanceBefore;
        if (toAmount < order.minToAmount) revert InsufficientOutput(toAmount, order.minToAmount);

        toToken.safeTransfer(order.user, toAmount);
        fromToken.safeTransfer(msg.sender, fromAmount);

        emit Settled(
            orderHash,
            order.user,
            msg.sender,
            order.fromToken,
            order.toToken,
            fromAmount,
            toAmount
        );
    }

    function _validateOrder(
        SwapOrder calldata order,
        bytes calldata signature,
        address callbackTarget
    ) private view returns (bytes32 orderHash) {
        if (block.timestamp > order.deadline) revert OrderExpired(order.deadline);
        if (
            order.user == address(0) || order.fromToken == address(0)
                || order.toToken == address(0) || order.fromToken == order.toToken
                || order.fromAmount == 0 || order.minToAmount == 0
        ) {
            revert InvalidOrder();
        }
        // A callback that is the contract itself or either token would let a solver
        // hijack this contract's balances and user approvals.
        if (
            callbackTarget == address(0) || callbackTarget == address(this)
                || callbackTarget == order.fromToken || callbackTarget == order.toToken
        ) {
            revert InvalidCallbackTarget();
        }
        if (nonceUsed[order.user][order.nonce]) {
            revert NonceAlreadyUsed(order.user, order.nonce);
        }

        orderHash = hashOrder(order);
        if (!SignatureChecker.isValidSignatureNow(order.user, orderHash, signature)) {
            revert InvalidSignature();
        }
    }

    function _checkUserFunds(IERC20 token, address user, uint256 amount) private view {
        uint256 balance = token.balanceOf(user);
        if (balance < amount) revert InsufficientUserBalance(balance, amount);

        uint256 allowance = token.allowance(user, address(this));
        if (allowance < amount) revert InsufficientUserAllowance(allowance, amount);
    }
}
