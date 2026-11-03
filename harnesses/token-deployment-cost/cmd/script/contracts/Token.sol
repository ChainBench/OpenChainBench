// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// The OpenZeppelin Contracts Wizard default fungible token: a name, a
// symbol, 18 decimals, and the whole supply minted to the deployer in the
// constructor. Nothing else (no Ownable, no Permit, no burn).
contract Token is ERC20 {
    constructor() ERC20("OpenChainBench Token", "OCBT") {
        _mint(msg.sender, 1_000_000_000 * 10 ** decimals());
    }
}
