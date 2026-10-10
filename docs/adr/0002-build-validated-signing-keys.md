# ADR-0002: Pin validated signing keys in the program build

The single-pool profile fixes state and clearance public keys in the program
build. Baby-JubJub, signature rules, circuits, tree hashes and VKs remain unchanged.

## Reason

Generic on-chain validation of both keys exceeds the 1,000,000 CU design budget.
Validating fixed keys at build time preserves the accepted-key invariants without
repeating expensive subgroup checks for every initialization.

## Decision

1. Build configuration contains separate 64-byte state and clearance public
   keys. Private keys are never build inputs.
2. `build.rs` uses the pinned Arkworks implementation to check canonical
   coordinates, curve membership, prime-order subgroup membership and nonidentity.
   Invalid keys fail the build; modular normalization and cofactor clearing must
   not substitute different keys.
3. `initialize_pool` retains its signatures and wire format. Each supplied key
   must exactly match the validated key for its role; swapping the roles fails.
4. Every instruction compares the PoolConfig keys with the build constants.
   Manifest keys, actual PoolConfig and program build pins must agree.
5. Different signing keys require a corresponding validated build and a new
   pool. An upgrade must not replace keys in an existing pool. There is no
   in-place key rotation API.

This deliberately limits a build to one key pair rather than accepting every
otherwise valid key. A deployment needing arbitrary keys requires a separately
verified design. Public fixture keys are for tests; production setup, key
management, review and manifest verification follow the
[operations contract](../specs/operations.md).
