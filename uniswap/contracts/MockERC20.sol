// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice A simple mintable ERC20 for testing on Sepolia.
 *         Anyone can mint — it's a testnet token.
 */
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /** Public mint — anyone can mint on testnet */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
