// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Subset of Uniswap Permit2's SignatureTransfer interface used by this project.
/// @dev Matches the canonical deployment at 0x000000000022D473030F116dDEE9F6B43aC78BA3.
interface ISignatureTransfer {
    error SignatureExpired(uint256 signatureDeadline);
    error InvalidNonce();
    error InvalidAmount(uint256 maxAmount);
    error LengthMismatch();
    error InvalidSignatureLength();
    error InvalidSignature();
    error InvalidSigner();
    error InvalidContractSignature();

    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /// @notice Bitmap of consumed unordered nonces, keyed by owner and word position.
    function nonceBitmap(
        address owner,
        uint256 word
    ) external view returns (uint256);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Transfers tokens using an owner signature that also commits to `witness`.
    /// @dev The signature is bound to `msg.sender` as the spender.
    function permitWitnessTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;

    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external;
}
