// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./base/BaseVerifier.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

enum VerifierType {
    TEE,
    ZKP
}

/// @title PayAgentVerifier
/// @notice Simplified ERC-7857 verifier for PayAgent iNFT.
///         In production, this would verify TEE/ZKP proofs.
///         Currently performs hash-based validation following the
///         same pattern as the official 0G reference implementation.
contract PayAgentVerifier is BaseVerifier {
    address public immutable attestationContract;
    VerifierType public immutable verifierType;

    constructor(address _attestationContract, VerifierType _verifierType) {
        attestationContract = _attestationContract;
        verifierType = _verifierType;
    }

    /// @notice Verify preimage of data. For hackathon: accepts bytes32 hashes directly.
    ///         In production, would verify TEE attestation of data ownership.
    function verifyPreimage(
        bytes[] calldata proofs
    ) external pure override returns (PreimageProofOutput[] memory) {
        PreimageProofOutput[] memory outputs = new PreimageProofOutput[](
            proofs.length
        );
        for (uint256 i = 0; i < proofs.length; i++) {
            require(proofs[i].length == 32, "Invalid data hash length");
            bytes32 dataHash = bytes32(proofs[i]);
            outputs[i] = PreimageProofOutput(dataHash, true);
        }
        return outputs;
    }

    /// @notice Verify transfer validity. Simplified: extracts signature + hashes from proof bytes.
    ///         In production, would verify TEE re-encryption proof.
    function verifyTransferValidity(
        bytes[] calldata proofs
    ) public virtual override returns (TransferValidityProofOutput[] memory) {
        TransferValidityProofOutput[]
            memory outputs = new TransferValidityProofOutput[](proofs.length);

        for (uint256 i = 0; i < proofs.length; i++) {
            outputs[i] = _processTransferProof(proofs[i]);

            // Replay protection
            bytes32 proofNonce = keccak256(proofs[i]);
            _checkAndMarkProof(proofNonce);
        }

        return outputs;
    }

    /// @dev Process a single transfer proof. Simplified for hackathon:
    ///      proof layout = [1 byte indicator][32 bytes oldHash][32 bytes newHash][20 bytes receiver]
    function _processTransferProof(
        bytes calldata proof
    ) private pure returns (TransferValidityProofOutput memory output) {
        require(proof.length >= 85, "Proof too short");

        output.oldDataHash = bytes32(proof[1:33]);
        output.newDataHash = bytes32(proof[33:65]);
        output.receiver = address(bytes20(proof[65:85]));
        output.sealedKey = bytes16(0);
        output.isValid = true;

        return output;
    }
}
