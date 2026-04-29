// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "./IERC7857DataVerifier.sol";

interface IERC7857 {
    /// @dev This emits when a new functional NFT is minted
    event Minted(
        uint256 indexed _tokenId,
        address indexed _creator,
        address indexed _owner,
        bytes32[] _dataHashes,
        string[] _dataDescriptions
    );

    /// @dev This emits when a user is authorized to use the data
    event Authorization(
        address indexed _from,
        address indexed _to,
        uint256 indexed _tokenId
    );

    /// @dev This emits when data is transferred with ownership
    event Transferred(
        uint256 _tokenId,
        address indexed _from,
        address indexed _to
    );

    /// @dev This emits when data is cloned
    event Cloned(
        uint256 indexed _tokenId,
        uint256 indexed _newTokenId,
        address _from,
        address _to
    );

    /// @dev This emits when a sealed key is published
    event PublishedSealedKey(
        address indexed _to,
        uint256 indexed _tokenId,
        bytes16[] _sealedKeys
    );

    /// @notice The verifier interface that this NFT uses
    function verifier() external view returns (IERC7857DataVerifier);

    /// @notice Mint new functional NFT with functional data ownership proof
    function mint(
        bytes[] calldata _proofs,
        string[] calldata _dataDescriptions,
        address _to
    ) external payable returns (uint256 _tokenId);

    /// @notice Transfer data with ownership
    function transfer(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external;

    /// @notice Clone data
    function clone(
        address _to,
        uint256 _tokenId,
        bytes[] calldata _proofs
    ) external returns (uint256 _newTokenId);

    /// @notice Add authorized user to group
    function authorizeUsage(uint256 _tokenId, address _user) external;

    /// @notice Get token owner
    function ownerOf(uint256 _tokenId) external view returns (address);

    /// @notice Get the authorized users of a token
    function authorizedUsersOf(
        uint256 _tokenId
    ) external view returns (address[] memory);
}
