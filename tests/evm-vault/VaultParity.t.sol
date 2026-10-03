// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ZkApiVault} from "upstream/ZkApiVault.sol";
import {Groth16ProofAdapter} from "upstream/adapters/Groth16ProofAdapter.sol";
import {Types} from "upstream/libraries/Types.sol";
import {Errors} from "upstream/libraries/Errors.sol";
import {Bn254Poseidon} from "upstream/libraries/Bn254Poseidon.sol";
import {NoteLeafLib} from "upstream/libraries/NoteLeafLib.sol";

/// Real Groth16 verification against the unchanged pinned upstream Vault.
/// Each successful snapshot is compared with an actual Solana SBF snapshot.
contract VaultParityTest is Test {
    uint64 constant NOW = 3_000_000_000;
    uint64 constant CHALLENGE = 86_400;
    uint128 constant D = 5_000_000;
    uint128 constant B = 4_900_000;
    address constant DEPLOYER = address(0xf00d);
    address constant USER = 0x1111111111111111111111111111111111111111;
    address constant TREASURY = address(0xbeef);
    ZkApiVault vault;
    Groth16ProofAdapter adapter;
    string fixture;
    string trace;
    uint256[32] empty;
    uint256 initialUser;
    uint256 initialTreasury;
    uint256 nullifier;

    function setUp() public {
        vm.chainId(31_337);
        vm.warp(NOW);
        fixture = vm.readFile("fixtures.json");
        uint256 zero;
        for (uint256 i; i < 32; ++i) {
            empty[i] = zero;
            zero = Bn254Poseidon.hash3(0x7a6b6170692e76322e6e6f6465, zero, zero);
        }
        adapter = new Groth16ProofAdapter();
        (Types.WithdrawalPublicInputs memory p,) = _withdrawal("escape");
        vm.setNonce(DEPLOYER, 0);
        vm.prank(DEPLOYER);
        vault = new ZkApiVault(TREASURY, 30 days, CHALLENGE, 1_000_000, address(adapter),
            p.stateSigningKeyX, p.stateSigningKeyY, p.clearanceSigningKeyX, p.clearanceSigningKeyY, address(this));
        assertEq(address(vault), p.contractAddress);
        nullifier = p.withdrawalNullifier;
        vm.deal(USER, 2 * uint256(D) * 1 gwei);
        initialUser = USER.balance;
        initialTreasury = TREASURY.balance;
        assertEq(vault.currentRoot(), uint256(vm.parseJsonBytes32(fixture, ".root_empty")));
    }

    function test_signedUseSettlementMutualClose() public {
        _record();
        _depositA(); _record();
        (Types.RequestPublicInputs memory request, bytes memory requestProof) = _request();
        adapter.assertValidRequest(request, requestProof);
        // The witness contains the real signature over the paid, non-genesis B state.
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("withdrawal");
        assertEq(p.finalBalance, B);
        vault.mutualClose(p, proof, empty); _record();
        assertEq(USER.balance, initialUser - uint256(D - B) * 1 gwei);
        assertEq(TREASURY.balance - initialTreasury, uint256(D - B) * 1 gwei);
        assertTrue(vault.usedNullifiers(nullifier));
        _finish("signed_close");
    }

    function test_escapeFinalizesExactlyAtDeadline() public { _finalize(false); }
    function test_pausedFinalizeStillPays() public { _finalize(true); }
    function test_historicalRequestChallengePreservesConsumedNullifier() public { _challenge(false); }
    function test_pausedHistoricalChallengeStillRestores() public { _challenge(true); }
    function test_activeExpiryAtBoundary() public { _expiry(false); }
    function test_pausedExpiryStillPays() public { _expiry(true); }

    function test_pauseBlocksNewDepositCloseAndEscape() public {
        _depositA(); vault.pause();
        bytes32 beforeState = _stateHash();
        vm.expectRevert(Errors.Paused.selector);
        vault.deposit{value: uint256(D) * 1 gwei}(bytes32(uint256(1)), D, empty);
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("withdrawal");
        vm.expectRevert(Errors.Paused.selector); vault.mutualClose(p, proof, empty);
        (p, proof) = _withdrawal("escape");
        vm.expectRevert(Errors.Paused.selector); vault.initiateEscapeWithdrawal(p, proof, empty);
        assertEq(_stateHash(), beforeState);
        _reject("paused_deposit", "Paused");
        _reject("paused_close", "Paused");
        _reject("paused_escape", "Paused");
    }

    function test_validProofWrongClearanceRouteRejected() public {
        _depositA(); bytes32 beforeState = _stateHash();
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("escape");
        vm.expectRevert(Errors.InvalidDeploymentBinding.selector); vault.mutualClose(p, proof, empty);
        (p, proof) = _withdrawal("withdrawal");
        vm.expectRevert(Errors.InvalidDeploymentBinding.selector); vault.initiateEscapeWithdrawal(p, proof, empty);
        assertEq(_stateHash(), beforeState);
        _reject("escape_proof_for_close", "InvalidDeploymentBinding");
        _reject("close_proof_for_escape", "InvalidDeploymentBinding");
    }

    function test_validProofStaleRootRejected() public {
        _depositA(); _depositB(); bytes32 beforeState = _stateHash();
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("escape");
        vm.expectRevert(Errors.StaleRoot.selector); vault.initiateEscapeWithdrawal(p, proof, empty);
        assertEq(_stateHash(), beforeState);
        _reject("stale_root_escape", "StaleRoot");
    }

    function test_documentedMaximumNoteIdDifference() public {
        // Pinned upstream storage-layout: nextNoteId is slot 3, uint32.
        // This isolated boundary setup skips allocating 2^32 earlier notes.
        vm.store(address(vault), bytes32(uint256(3)), bytes32(uint256(type(uint32).max)));
        assertEq(vault.nextNoteId(), type(uint32).max);
        bytes32 beforeState = _stateHash();
        bytes32 c = vm.parseJsonBytes32(fixture, ".commitment_a");
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", uint256(0x11)));
        vm.prank(USER); vault.deposit{value: uint256(D) * 1 gwei}(c, D, empty);
        assertEq(_stateHash(), beforeState);
        (,,,Types.NoteStatus s) = vault.notes(type(uint32).max);
        assertEq(uint256(s), uint256(Types.NoteStatus.Uninitialized));
    }

    function _finalize(bool paused) private {
        _record(); _depositA(); _record();
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("escape");
        vault.initiateEscapeWithdrawal(p, proof, empty); _record();
        if (paused) vault.pause();
        vm.warp(NOW + CHALLENGE - 1);
        bytes32 beforeState = _stateHash();
        vm.expectRevert(Errors.ChallengeNotExpired.selector); vault.finalizeEscapeWithdrawal(0);
        assertEq(_stateHash(), beforeState);
        _reject("finalize_before_deadline", "ChallengeNotExpired");
        vm.warp(NOW + CHALLENGE);
        uint256 rootBefore = vault.currentRoot();
        vault.finalizeEscapeWithdrawal(0); _record();
        assertEq(vault.currentRoot(), rootBefore);
        beforeState = _stateHash();
        vm.expectRevert(Errors.NotPendingWithdrawal.selector); vault.finalizeEscapeWithdrawal(0);
        assertEq(_stateHash(), beforeState);
        _reject("repeated_finalize", "NotPendingWithdrawal");
        _finish(paused ? "paused_finalize" : "escape_finalize");
    }

    function _challenge(bool paused) private {
        _record(); _depositA(); _record();
        (Types.RequestPublicInputs memory request, bytes memory requestProof) = _request();
        adapter.assertValidRequest(request, requestProof);
        uint256 historicalRoot = vault.currentRoot();
        _depositB(); _record();
        uint256 restoredRoot = vault.currentRoot();
        assertNotEq(historicalRoot, restoredRoot);
        (Types.WithdrawalPublicInputs memory p, bytes memory proof) = _withdrawal("escape_with_b");
        uint256[32] memory siblings = _siblings(1);
        vault.initiateEscapeWithdrawal(p, proof, siblings); _record();
        (,uint256 pendingRoot,,,,) = vault.pendingWithdrawals(0);
        assertNotEq(historicalRoot, pendingRoot);
        assertNotEq(historicalRoot, vault.currentRoot());
        if (paused) vault.pause();
        // Probe the rejected deadline branch, then restore the clock for the
        // independent successful branch, exactly as in the SBF harness.
        vm.warp(NOW + CHALLENGE);
        bytes32 beforeState = _stateHash();
        vm.expectRevert(Errors.ChallengeExpired.selector);
        vault.challengeEscapeWithdrawal(0, request, requestProof, siblings);
        assertEq(_stateHash(), beforeState);
        _reject("challenge_at_deadline", "ChallengeExpired");
        vm.warp(NOW + CHALLENGE - 1);
        beforeState = _stateHash();
        request.activeRoot = vault.currentRoot();
        vm.expectRevert(Errors.InvalidProof.selector);
        vault.challengeEscapeWithdrawal(0, request, requestProof, siblings);
        assertEq(_stateHash(), beforeState);
        _reject("rewritten_historical_root", "InvalidProof");
        request.activeRoot = historicalRoot;
        vault.challengeEscapeWithdrawal(0, request, requestProof, siblings); _record();
        assertEq(vault.currentRoot(), restoredRoot);
        assertTrue(vault.usedNullifiers(nullifier));
        beforeState = _stateHash();
        vm.expectRevert(Errors.NotPendingWithdrawal.selector);
        vault.challengeEscapeWithdrawal(0, request, requestProof, siblings);
        assertEq(_stateHash(), beforeState);
        _reject("repeated_challenge", "NotPendingWithdrawal");
        if (paused) vault.unpause();
        beforeState = _stateHash();
        vm.expectRevert(Errors.ReplayedNullifier.selector);
        vault.initiateEscapeWithdrawal(p, proof, siblings);
        assertEq(_stateHash(), beforeState);
        _reject("escape_consumed_nullifier", "ReplayedNullifier");
        _finish(paused ? "paused_challenge" : "historical_challenge");
    }

    function _expiry(bool paused) private {
        _record(); _depositA(); _record();
        if (paused) vault.pause();
        uint256 expiry = vm.parseJsonUint(fixture, ".expiry");
        vm.warp(expiry - 1); bytes32 beforeState = _stateHash();
        vm.expectRevert(Errors.NoteNotExpired.selector); vault.claimExpired(0, empty);
        assertEq(_stateHash(), beforeState);
        _reject("expiry_before_deadline", "NoteNotExpired");
        vm.warp(expiry); vault.claimExpired(0, empty); _record();
        assertEq(TREASURY.balance - initialTreasury, uint256(D) * 1 gwei);
        beforeState = _stateHash();
        vm.expectRevert(Errors.NoteNotActive.selector); vault.claimExpired(0, empty);
        assertEq(_stateHash(), beforeState);
        _reject("repeated_expiry", "NoteNotActive");
        _finish(paused ? "paused_expiry" : "active_expiry");
    }

    function _depositA() private {
        bytes32 c = vm.parseJsonBytes32(fixture, ".commitment_a");
        vm.prank(USER); vault.deposit{value: uint256(D) * 1 gwei}(c, D, empty);
        assertEq(vault.currentRoot(), uint256(vm.parseJsonBytes32(fixture, ".root_a")));
    }
    function _depositB() private {
        bytes32 c = vm.parseJsonBytes32(fixture, ".commitment_b");
        uint256[32] memory siblings = _siblings(0);
        vm.prank(USER); vault.deposit{value: uint256(D) * 1 gwei}(c, D, siblings);
        assertEq(vault.currentRoot(), uint256(vm.parseJsonBytes32(fixture, ".root_ab")));
    }
    function _siblings(uint32 other) private view returns (uint256[32] memory siblings) {
        siblings = empty;
        (bytes32 c, uint128 d, uint64 e,) = vault.notes(other);
        siblings[0] = NoteLeafLib.computeLeaf(other, c, d, e);
    }
    function _request() private view returns (Types.RequestPublicInputs memory, bytes memory) {
        return (abi.decode(vm.parseJsonBytes(fixture, ".auth.request.inputs_abi"), (Types.RequestPublicInputs)), vm.parseJsonBytes(fixture, ".auth.request.proof_wire_hex"));
    }
    function _withdrawal(string memory name) private view returns (Types.WithdrawalPublicInputs memory, bytes memory) {
        string memory prefix = string.concat(".auth.", name);
        return (abi.decode(vm.parseJsonBytes(fixture, string.concat(prefix, ".inputs_abi")), (Types.WithdrawalPublicInputs)), vm.parseJsonBytes(fixture, string.concat(prefix, ".proof_wire_hex")));
    }
    function _stateHash() private view returns (bytes32) {
        (bytes32 c0,uint128 d0,uint64 e0,Types.NoteStatus s0) = vault.notes(0);
        (bytes32 c1,uint128 d1,uint64 e1,Types.NoteStatus s1) = vault.notes(1);
        (bool exists,uint256 oldRoot,uint256 n,uint128 b,address dest,uint64 deadline) = vault.pendingWithdrawals(0);
        return keccak256(abi.encode(vault.currentRoot(),vault.nextNoteId(),c0,d0,e0,s0,c1,d1,e1,s1,exists,oldRoot,n,b,dest,deadline,vault.usedNullifiers(nullifier),USER.balance,TREASURY.balance,address(vault).balance));
    }
    function _record() private {
        uint256[] memory statuses = new uint256[](2);
        bool[] memory exists = new bool[](2);
        uint256[] memory balances = new uint256[](2);
        uint256[] memory deadlines = new uint256[](2);
        bytes32[] memory leaves = new bytes32[](2);
        bytes32[] memory nullifiers = new bytes32[](2);
        for (uint32 i; i<2; ++i) {
            (bytes32 c,uint128 d,uint64 e,Types.NoteStatus s) = vault.notes(i);
            statuses[i] = uint256(s);
            if (s == Types.NoteStatus.Active) leaves[i] = bytes32(NoteLeafLib.computeLeaf(i,c,d,e));
            (bool pending,,uint256 n,uint128 b,,uint64 deadline) = vault.pendingWithdrawals(i);
            exists[i] = pending; balances[i]=b; deadlines[i]=deadline; nullifiers[i]=bytes32(n);
        }
        string memory key = "snapshot";
        vm.serializeBytes32(key,"root",bytes32(vault.currentRoot()));
        vm.serializeUint(key,"time",block.timestamp);
        vm.serializeUint(key,"next_id",vault.nextNoteId());
        vm.serializeUint(key,"statuses",statuses);
        vm.serializeBool(key,"pending_exists",exists);
        vm.serializeUint(key,"pending_balance",balances);
        vm.serializeUint(key,"pending_deadline",deadlines);
        vm.serializeBytes32(key,"active_leaves",leaves);
        vm.serializeBytes32(key,"pending_nullifier",nullifiers);
        vm.serializeBool(key,"nullifier_used",vault.usedNullifiers(nullifier));
        vm.serializeInt(key,"user_delta",(int256(USER.balance)-int256(initialUser))/int256(1 gwei));
        vm.serializeUint(key,"treasury_delta",(TREASURY.balance-initialTreasury)/1 gwei);
        string memory entry = vm.serializeUint(key,"vault_units",address(vault).balance/1 gwei);
        trace = string.concat(trace, bytes(trace).length == 0 ? "[" : ",", entry);
    }
    function _finish(string memory name) private {
        vm.writeFile(string.concat("../../target/i03/evm-traces/",name,".json"),string.concat(trace,"]"));
    }
    function _reject(string memory name, string memory errorName) private {
        vm.writeFile(string.concat("../../target/i03/evm-traces/reject-",name,".json"),
            string.concat('{"error":"',errorName,'","unchanged":true}'));
    }
}
