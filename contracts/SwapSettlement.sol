// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ISettlementCallback} from "./interfaces/ISettlementCallback.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/// @title SwapSettlement
/// @notice Settles a user-signed swap intent against solver-provided liquidity.
/// @dev The user approves Permit2 once and signs a Permit2 `PermitWitnessTransferFrom`
/// whose witness commits to the buy side of the trade. A solver calls {settle}, which
/// pulls the sell token through Permit2, hands control to the solver's callback to
/// source the buy token, then pays the user and the solver atomically.
///
/// Permit2 owns signature verification, expiry, and replay protection: the signature is
/// bound to this contract as the spender, so it cannot be redirected to another
/// settlement contract.
contract SwapSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Buy-side terms committed to by the user's Permit2 signature.
    struct SwapWitness {
        address toToken;
        uint256 minToAmount;
        address solver;
    }

    /// @notice EIP-712 type hash of {SwapWitness}.
    bytes32 public constant WITNESS_TYPEHASH =
        keccak256("SwapWitness(address toToken,uint256 minToAmount,address solver)");

    /// @notice Witness type string appended to Permit2's `PermitWitnessTransferFrom` stub.
    /// @dev Referenced struct types must follow EIP-712 alphabetical ordering.
    string public constant WITNESS_TYPE_STRING =
        "SwapWitness witness)SwapWitness(address toToken,uint256 minToAmount, address solver)TokenPermissions(address token,uint256 amount)";

    error UnauthorizedSolver(address caller, address expected);

    /// @notice The Permit2 deployment used to pull the sell token.
    ISignatureTransfer public immutable PERMIT2;

    event Settled(
        address indexed user,
        address indexed solver,
        uint256 indexed nonce,
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 toAmount
    );

    error InvalidPermit2();
    error InvalidOrder();
    error InvalidCallbackTarget();
    error InsufficientUserBalance(uint256 available, uint256 required);
    error InsufficientPermit2Allowance(uint256 available, uint256 required);
    error SellTransferShortfall(uint256 received, uint256 expected);
    error InsufficientOutput(uint256 received, uint256 minimum);

    constructor(ISignatureTransfer permit2) {
        if (address(permit2) == address(0)) revert InvalidPermit2();
        PERMIT2 = permit2;
    }

    /// @notice Returns the EIP-712 struct hash of `witness`, as committed to by the user.
    function hashWitness(
        SwapWitness calldata witness
    ) public pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    WITNESS_TYPEHASH,
                    witness.toToken,
                    witness.minToAmount,
                    witness.solver
                )
            );
    }

    /// @notice Settles a Permit2-signed swap using liquidity supplied by `callbackTarget`.
    /// @param permit Permit2 sell-side terms: token, amount, nonce, and deadline.
    /// @param user The order signer, who receives `toToken`.
    /// @param witness Buy-side terms bound to the same signature.
    /// @param signature The user's Permit2 `PermitWitnessTransferFrom` signature.
    /// @param callbackTarget Solver contract that delivers `toToken` to this contract.
    /// @param callbackData Opaque data forwarded to `callbackTarget`.
    /// @return toAmount Amount of `toToken` delivered to the user.
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address user,
        SwapWitness calldata witness,
        bytes calldata signature,
        address callbackTarget,
        bytes calldata callbackData
    ) external nonReentrant returns (uint256 toAmount) {
        _validate(permit, user, witness, callbackTarget);

        IERC20 fromToken = IERC20(permit.permitted.token);
        IERC20 toToken = IERC20(witness.toToken);

        _checkUserFunds(fromToken, user, permit.permitted.amount);

        uint256 fromBalanceBefore = fromToken.balanceOf(address(this));
        uint256 toBalanceBefore = toToken.balanceOf(address(this));

        // Permit2 enforces the deadline, the nonce, and signature validity.
        PERMIT2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted.amount
            }),
            user,
            hashWitness(witness),
            WITNESS_TYPE_STRING,
            signature
        );

        uint256 fromAmount = fromToken.balanceOf(address(this)) -
            fromBalanceBefore;
        if (fromAmount < permit.permitted.amount) {
            revert SellTransferShortfall(fromAmount, permit.permitted.amount);
        }

        ISettlementCallback(callbackTarget).settlementCallback(
            address(fromToken),
            fromAmount,
            address(toToken),
            witness.minToAmount,
            callbackData
        );

        toAmount = toToken.balanceOf(address(this)) - toBalanceBefore;
        if (toAmount < witness.minToAmount) {
            revert InsufficientOutput(toAmount, witness.minToAmount);
        }

        toToken.safeTransfer(user, toAmount);
        fromToken.safeTransfer(msg.sender, fromAmount);

        emit Settled(
            user,
            msg.sender,
            permit.nonce,
            address(fromToken),
            address(toToken),
            fromAmount,
            toAmount
        );
    }

    function _validate(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address user,
        SwapWitness calldata witness,
        address callbackTarget
    ) private view {
        if (
            user == address(0) ||
            permit.permitted.token == address(0) ||
            witness.toToken == address(0) ||
            witness.solver == address(0) ||
            permit.permitted.token == witness.toToken ||
            permit.permitted.amount == 0 ||
            witness.minToAmount == 0
        ) {
            revert InvalidOrder();
        }
        if (msg.sender != witness.solver) {
            revert UnauthorizedSolver(msg.sender, witness.solver);
        }
        // A callback that is this contract, Permit2, or either token would let a solver
        // hijack settlement balances or the user's Permit2 approvals.
        if (
            callbackTarget == address(0) ||
            callbackTarget == address(this) ||
            callbackTarget == address(PERMIT2) ||
            callbackTarget == permit.permitted.token ||
            callbackTarget == witness.toToken
        ) {
            revert InvalidCallbackTarget();
        }
    }

    function _checkUserFunds(
        IERC20 token,
        address user,
        uint256 amount
    ) private view {
        uint256 balance = token.balanceOf(user);
        if (balance < amount) revert InsufficientUserBalance(balance, amount);

        uint256 allowance = token.allowance(user, address(PERMIT2));
        if (allowance < amount)
            revert InsufficientPermit2Allowance(allowance, amount);
    }
}
