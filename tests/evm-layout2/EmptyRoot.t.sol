// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {Bn254Poseidon} from "upstream/libraries/Bn254Poseidon.sol";
contract EmptyRootTest {
    function test_emptyRoot32MatchesEmbeddedRustConstant() public pure {
        uint256 root;
        for (uint256 i; i < 32; ++i) {
            root = Bn254Poseidon.hash3(uint256(uint104(bytes13("zkapi.v2.node"))), root, root);
        }
        require(root == 0x2bb43759c24665d98a33afa8d5094817d359d5e4c72a45b45a2a563176d37933, "empty root mismatch");
    }
}
