# Provenance for four unchanged upstream setup files

This note was added by the Solana zkAPI project on 2026-10-07. It is our
distribution record, not a purported upstream NOTICE file. It applies only to
the exact four byte sequences listed below.

The original source is `mingyech/zkAPI`, revision
`8b2d4e3da921f956e1eb6b93afbf722a877c060c`, directory `setup/v2/`.
`ethereum/zkapi` imported these files unchanged into `protocol/setup/v2/`;
the reviewed Ethereum revision is `045b444ea1b52538d1b40273c7cb6ed09468a052`.

The original repository's root README declares `MIT OR Apache-2.0` in its
License section. For these four unchanged files, this distribution selects
the Apache-2.0 option. Preserve the original declaration in the accompanying
README and the complete standard text in `Apache-2.0.txt`. No separate
original LICENSE, COPYING or NOTICE file was found in the reviewed
original tree. No copyright holder is invented or reassigned by this note.
The license's appendix remains unmodified standard boilerplate.

| Original filename | Distribution filename | Bytes | SHA-256 | Git blob SHA-1 |
|---|---|---:|---|---|
| `request.pk` | `requestPk.bin` | 5935783 | `c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584` | `5fb7bd7e5c8db0426f293228187c16ce994b341d` |
| `request.vk` | `requestVk.bin` | 671 | `8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97` | `33666441aa6d5553d174f64df62874dd5f1f77d5` |
| `withdrawal.pk` | `withdrawalPk.bin` | 7783719 | `8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668` | `5f8e4cb5e8086215f6f7d6a26616ee4834b9e393` |
| `withdrawal.vk` | `withdrawalVk.bin` | 735 | `2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679` | `3f0dc9b5652989e327293627e53641b865b73c0a` |

The included source documents are exact, unmodified bytes:

| Included filename | Original source | Bytes | SHA-256 |
|---|---|---:|---|
| `mingyech-README-8b2d4e3.md` | [Original root README](https://github.com/mingyech/zkAPI/blob/8b2d4e3da921f956e1eb6b93afbf722a877c060c/README.md) | 3301 | `f93dcf61244ca2c3de783aa68355cb263024f5b5da3ec9fd40ac26cbee157846` |
| `mingyech-setup-README-8b2d4e3.md` | [Original setup README](https://github.com/mingyech/zkAPI/blob/8b2d4e3da921f956e1eb6b93afbf722a877c060c/setup/v2/README.md) | 894 | `22b8ab79c6e8c985447c2a20b55d9253b5c2dab932cbd50927538f3571ffcf5d` |
| `ethereum-VENDORED-045b444.md` | [Ethereum import provenance](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/VENDORED.md) | 2208 | `12e597fefcdb430f28a1ca16c1fe917e0bd2513958aa8523e1e1610bb947fce3` |
| `Apache-2.0.txt` | [Standard license text](https://github.com/spdx/license-list-data/blob/31ba1a50e5397e00a304dbadc76531740e89ee48/text/Apache-2.0.txt) | 10280 | `074e6e32c86a4c0ef8b3ed25b721ca23aca83df277cd88106ef7177c354615ff` |

Read the accompanying setup README. The keys came from a single-party
development setup with OS randomness, not an independently reviewed setup
ceremony. Matching bytes establish identity, not destruction of setup secrets.
They require their matching circuit/verifier. Distribution does not justify
replacing live deployment pins or changing existing wallet recovery data.

This four-file decision does not license unrelated bundle components or
approve an arbitrary release. The complete bundle must retain each component's
own provenance and applicable notices. Descriptor schema 2 binds the hashes
of these accompanying documents and requires clients to retrieve and verify
them. The SHA-256 of this added note is recorded in the separate distribution
decision and bundle descriptor; the original source documents are unchanged.
