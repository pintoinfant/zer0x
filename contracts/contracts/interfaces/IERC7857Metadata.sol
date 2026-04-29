// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC7857Metadata {
    /// @dev This emits when data is updated
    event Updated(
        uint256 indexed _tokenId,
        bytes32[] _oldDataHashes,
        bytes32[] _newDataHashes
    );

    /// @notice Get the name of the NFT collection
    function name() external view returns (string memory);

    /// @notice Get the symbol of the NFT collection
    function symbol() external view returns (string memory);

    /// @notice Get the metadata URI for a specific token
    function tokenURI(uint256 tokenId) external view returns (string memory);

    /// @notice Update data
    function update(uint256 _tokenId, bytes[] calldata _proofs) external;

    /// @notice Get the data hash of a token
    function dataHashesOf(
        uint256 _tokenId
    ) external view returns (bytes32[] memory);

    /// @notice Get the data description of a token
    function dataDescriptionsOf(
        uint256 _tokenId
    ) external view returns (string[] memory);
}
