// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Development assets. Public deployment must identify these as test assets.
contract DemoUSDC is ERC20 {
    mapping(address => uint256) public lastFaucet;

    constructor() ERC20("Strata Demo USDC", "dUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        require(block.timestamp >= lastFaucet[msg.sender] + 1 hours, "Faucet cooldown");
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, 10000e6);
    }

    function mint(address receiver, uint256 amount) external {
        require(block.chainid == 31337, "Local only");
        _mint(receiver, amount);
    }
}

contract WrappedMON is ERC20 {
    constructor() ERC20("Wrapped Test MON", "WMON") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "Native transfer failed");
    }
}
