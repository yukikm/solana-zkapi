# オンチェーン・暗号仕様

規範語「必須」「拒否」は実装・受入試験の条件。元実装は `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。この仕様の資産・binding・transport変更以外は元の状態機械を維持する。初版は[ADR-0001](../adr/0001-proof-bound-tree-transition.md)のtree証明方式（layout 2）を採用し、[tree-transition実装契約](tree-transition.md)を併読する。

## 1. 数値と符号化

- USDC量：内部u64、演算中u128以上、上限 `9_007_199_254_740_991`。HTTPは小数点なしの10進文字列、先頭ゼロなし（0は許容）。
- note ID：u32、0から単調増加し再使用しない。割当counterのnext_note_idだけはu64で0〜2^32（満杯sentinel）を表す。next_note_id=2^32ならTreeFull、それ以外はu32へchecked変換して割当後に1増やす。最大note ID 2^32−1も一度だけ利用可能。
- timestamp：非負u64 Unix秒。Solana Clockの負値・加算overflowを拒否。
- Fr：32 bytes big-endian、`0 <= x < r`。HTTPは `0x` + 64桁小文字hex。外部入力を剰余で正規化しない。
- Schnorrのsとblind deltaも同じ32-byte hex形式だが、Baby-JubJub scalar fieldの法でcanonical検査する。Frの範囲検査だけで済ませない。Baby-JubJub scalarの法は2736030358979909402780800718157159386076813972158567259200215660948447373041（[固定Arkworks 0.5.0](https://docs.rs/ark-ed-on-bn254/0.5.0/src/ark_ed_on_bn254/fields/fr.rs.html)）。
- r（BN254 scalar field）：`21888242871839275222246405745257275088548364400416034343698204186575808495617`。
- Fq（proof座標）の法はFrと異なる。元のcompact decoderとverifier規約でcanonical・曲線・部分群を検査する。
- Pubkey/hash：32 bytes。HTTPのPubkeyはbase58、SHA-256 digestは64桁小文字hex（0xなし）。UUIDはcanonical小文字UUIDv4。
- Anchor Borshの整数はlittle-endian。Fr/proofのbyte配列はbig-endian表現のままコピーする。

### H2Fを一意に定義する

`frame(label, parts) = u16be(len(UTF8(label))) || UTF8(label) || u16be(parts.len) || concat(u32be(part.len) || part)`。
`H2F(label, parts) = OS2IP_BE(SHA256(frame(label, parts))) mod r`。すべてのlengthはbyte長、UTF-8に暗黙のUnicode正規化をしない。ラベルは仕様中のASCII文字列だけ。

- namespace：`0x534f4c`（5459788）。公式chain IDではない。
- vault_binding：H2F(`solana-zkapi-vault-v1`, `[genesis_hash_raw32, program_id_raw32, pool_pubkey_raw32, token_program_id_raw32, usdc_mint_raw32, [6]]`)。
- destination_binding：H2F(`solana-zkapi-destination-v1`, `[wallet_owner_raw32]`)。
- auth request_context：H2F(`solana-zkapi-authorization-v1`, `[authorization_bytes]`)。bytesの構造はAPI仕様。

SDKはRPC genesis hashをmanifestと比較。programは初期化済み固定configからbindingを再計算する。32-byte walletを単純にFrへ剰余変換しない。

## 2. 回路・proof

元回路の `protocol_version=2` を維持。HTTP versionはこれと独立。request proofのpublic inputは以下の12要素をこの順序でFr化する。

```text
[2, chain_namespace, vault_binding, active_root,
 state_key.x, state_key.y, request_time, solvency_bound,
 request_nullifier, authorization_tag, anonymous_commitment.x, anonymous_commitment.y]
```

withdrawal proofは14要素。

```text
[2, chain_namespace, vault_binding, active_root,
 state_key.x, state_key.y, clearance_key.x, clearance_key.y,
 note_id, final_balance, destination_binding, withdrawal_nullifier,
 has_clearance_0_or_1, withdrawal_tag]
```

`authorization_tag = H_auth(N, request_context)`、`withdrawal_tag = H_withdraw(N,destination_binding,B,has_clearance)`。ドメインとPoseidon spongeは元実装の `zkapi-core/src/v2.rs` と一致させる。request_contextはprivate witnessだが、受信サーバーがquote等から再計算したtagとpublic inputを比較することで認可内容を固定する。

元wireのproofはbase64で表した256 bytes。非圧縮8座標 `A.x,A.y,B.x.c0,B.x.c1,B.y.c0,B.y.c1,C.x,C.y`、各32 bytes BE。コメントにcompressedとあっても実装 `compact.rs::proof_to_wire` が基準。Solana側のG2係数順とAの符号は変換crateだけで調整し、二重反転を拒否するtest vectorを持つ。VKはrequest/withdrawal別、programに埋め込み、manifestにSHA-256を記録。汎用accountから任意VKを受け取らない。

残高状態は `E=B·G+r·H+L·J`、`N=H_null(secret,anchor)`。genesisはB=D、anchor=1。再乱数化したEだけを送信し、note ID・元残高・secret・元anchor・署名は通常認可で公開しない。後継は `E_next=E_anon−charge·G+blind_delta·H`。利用者が後継署名・点・整数残高を検証してからjournalを進める。状態署名はBaby-JubJubのまま、walletのEd25519へ置換しない。

初回G1試験は元のsetup artifactで互換性を確認する。本番artifactの要件はoperations仕様参照。回路制約の変更が必要なら circuit_id/VK/setupを新しくし、移植元とのdiffを保存する。

## 3. Accountsと権限

PDA seedは下表。整数seedは指定サイズのLE。Anchorのaccount discriminatorは型名から生成する8 bytes、各account先頭にlayout_version:u8を持つ。全accountは当該program所有で、USDC token accountだけSPL Token Program所有。

| 型 | seed（prefixはASCII） | 主要field |
|---|---|---|
| PoolConfig | `["pool", pool_id_32]` | bump, genesis_hash, mint, token_program, decimals=6, vault_binding, admin, treasury_owner, state/clearance pubkey各64B, TTL:u64, challenge:u64, cap:u64, paused:bool, tree_backend:u8=1, tree_tag_policy:u8=1, circuit_profile_hash:32B |
| TreeState | `["tree", pool]` | bump, root:Fr32, next_note_id:u64, sequence:u64, outstanding_deposits:u64 |
| VaultAuthority | `["vault", pool]` | PDA signerのみ。USDC ATAのauthority |
| Note | `["note", pool, note_id_u32le]` | bump, note_id:u32, commitment:Fr32, deposit:u64, expiry:u64, status:u8 |
| PendingWithdrawal | `["pending", pool, note_id_u32le]` | bump, exists:bool, old_root:Fr32, nullifier:Fr32, balance:u64, destination_owner:Pubkey, deadline:u64 |
| ExitNullifier | `["exit", pool, nullifier_32be]` | bump, consumed:bool。永久tombstone、closeしない |
| PayloadBuffer | `["payload", pool, uploader, nonce_32]` | bump, uploader, op:u8, payload_len:u32, digest32, next_offset:u32, sealed:bool, expires:u64, rent_payer, payload bytes |

PoolConfigはmint・鍵・TTL等を初期化後変更しない。可変なのはadmin管理下のtreasury_ownerとpaused。admin自体の変更は初版に含めず、外部multisigの構成変更で運用する。Poolの異なるaccount混在、PDA bump/seed不一致、任意program accountへのCPI、token authority/delegateの差し替えを拒否。

layout_version=2。tree backend/tag policy/profile hashは埋込み定数と一致必須、初期化後変更不可。layout 1は研究用の旧形式であり初版poolでは受理しない。Note.statusはActive=1、PendingWithdrawal=2、Closed=3（0は有効Noteに使わない）。initialize_poolはttl>0、challenge>0、0<cap<=MAX、admin/treasuryがdefault Pubkeyでないことを必須とする。初期profileはttl=2,592,000秒、challenge=86,400秒、cap=1,000,000 micro-USDC。

USDC mint：mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`、devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`。原SPL Token Programを固定し、Token-2022や転送手数料tokenを初版で受理しない。release前に実mintのowner/decimals/freeze authorityを記録する。

USDC vaultはVaultAuthorityのATA、受取先は証明に結合したwallet ownerのUSDC ATA。受取walletの追加署名は不要、payerは任意の支援者でもよい。ATA作成費はpayer負担でdepositから引かない。finalizeはPendingに保存済みownerだけへ送る。treasuryは実行時のPoolConfigを使う（元挙動と同じ）。

`vault.amount >= outstanding_deposits` を各資金遷移後に確認する。depositで+D、close/finalize/expiryで−D、escape開始/challengeは不変。直接送られた余剰USDCにnoteを発行せず、初版には余剰引出命令を設けない。checked arithmeticを使用する。

### ビルドに固定する署名公開鍵

[ADR-0002](../adr/0002-build-validated-signing-keys.md)により、初期の単一pool profileはstate/clearance公開鍵をprogram buildへ固定する。build時に元Arkworksでcanonical座標・曲線・部分群・非単位点を検査し、initialize_poolは同じ役割の検証済み公開鍵との完全一致を必須とする。各命令でもPoolConfigの鍵をビルド設定と照合する。任意の別鍵は受理しない。鍵を変える場合は対応buildと新poolが必要で、既存poolの鍵は変更しない。manifestの公開鍵、実PoolConfig、program buildのpinも一致させる。この固定比較はSBFで約1,274万CUを要した2鍵の汎用部分群計算を置き換えるが、accepted keyの暗号条件は維持する。

## 4. 命令契約

Anchor命令discriminatorは `sha256("global:"+snake_case_name)[0..8]`。各命令のargsはBorsh。`F= [u8;32]`, `Proof=[u8;256]`, `TP=[F;11]`, `TreeUpdate={public:TP, proof:Proof}`, `WP=[F;14]`, `RP=[F;12]`。配列長のprefixは付けない。下表のinline argsの順序を固定する。

| 命令 / args | signer | writable account | 検査・結果 |
|---|---|---|---|
| initialize_pool(pool_id32, genesis32, state_key64, clearance_key64, ttl:u64, challenge:u64, cap:u64, admin, treasury) | deployment authority, admin, payer | pool, tree, vault ATA | build時に固定したdeployment authority署名、固定mint、元hashで検証済みの埋込み空tree root・circuit profile、鍵の曲線/部分群/非単位点、値域。登録済みpoolは拒否 |
| deposit(expected_id:u32, expected_root:F, expiry:u64, commitment:F, amount:u64, tree:TreeUpdate) | token owner, payer | tree,note,source ATA,vault ATA | !paused、次ID・root一致、0<amount<=MAX、C!=0、expiry=ceil((Clock+TTL)/86400)*86400。zero→L、TransferChecked |
| mutual_close(public:WP,proof:Proof,tree:TreeUpdate) | payer | tree,note,exit,vault ATA,destination ATA,treasury ATA | !paused、has_clearance=1、current root、固定binding/keys、実proof。Active、B<=D、N未使用。L→0、Closed、N消費、B/D−B転送 |
| initiate_escape(public:WP,proof:Proof,tree:TreeUpdate) | payer | tree,note,exit,pending | !paused、has_clearance=0、current root、実proof、Active、B<=D、N未使用。L→0、Pending、N消費、deadline=Clock+challenge |
| challenge_escape(note_id:u32,public:RP,proof:Proof,tree:TreeUpdate) | payer | tree,note,pending | Pending、Clock<deadline、N=保存済みN、固定binding/keys、過去の実request proof。current rootのzero→L、Active。exitは維持 |
| finalize_escape(note_id:u32) | payer | note,pending,tree,vault ATA,destination ATA,treasury ATA | Pending、Clock>=deadline。root不変、Closed、保存B/D−B転送 |
| claim_expired(note_id:u32,tree:TreeUpdate) | payer | tree,note,vault ATA,treasury ATA | Active、Clock>=expiry。L→0、Closed、D全額をtreasuryへ |
| set_treasury(new_owner:Pubkey) | admin | pool | new_owner!=default、既存Pendingにも将来の支払時に適用 |
| pause() / unpause() | admin | pool | paused変更。challenge/finalize/expiryはpause非対象 |

treeの11公開入力とWP/RP/Noteを結合する比較、op対応、固定wireは[tree-transition §2–3](tree-transition.md)を必須とする。leaf/path/tagをprogramで再計算しない。

各命令は上表に加えてpool（read-only、管理命令はwritable）、必要なSystem/Token/ATA program、Clockを検証する。close/escapeのdestination_owner accountはWPのbindingと一致必須。Pendingはchallenge/finalize成功後exists=falseとし再利用可能、NoteはClosed tombstoneを残す。nullifierはclearanceとrequestの共通namespace。withdrawalに元実装にないexpiry制約を足さない。

challengeのRP.active_rootをcurrent rootへ書き換えてはいけない。提出されたRPとproofを当時のまま検証し、treeを復元する追加証明のold_rootだけcurrent rootと照合する。RP.active_rootとPending.old_rootの一致も要求しない。API側のquote freshnessやrequest_time鮮度をon-chain challengeへ適用しない。

すべてのtoken transferとtree更新は同じinstruction内で行う。CPI失敗・口座凍結・残高不足・不正proofでは全状態をrollback。tree.sequenceは成功したdeposit/close/escape/challenge/finalize/expiryごとに1増加する。finalizeではroot不変でもsequenceを進める。イベントは後述のVaultTransitionV1を使い、曖昧なamount fieldを設けない。公開イベントにnote secret・prompt・runtime keyを含めない。

error名：`Paused`, `InvalidBinding`, `InvalidMint`, `InvalidTokenAccount`, `InvalidField`, `InvalidProof`, `StaleRoot`, `StaleNoteId`, `InvalidExpiry`, `TreeFull`, `InvalidBalance`, `ReplayedNullifier`, `NoteNotActive`, `NotPending`, `ChallengeExpired`, `ChallengeNotExpired`, `NotExpired`, `InvalidBuffer`, `ArithmeticOverflow`。Anchorの6000番台へ順序固定で割当て、IDLに記録。


### Indexerが再現するイベントと履歴

各成功遷移はAnchor event `VaultTransitionV1` を1件emitする。Borsh field順は `event_version:u8=1, pool:Pubkey, sequence:u64, op:u8, note_id:u32, status:u8, old_root:F, new_root:F, commitment:F, deposit:u64, expiry:u64, exit_nullifier:Option<F>, final_balance:Option<u64>, destination_owner:Option<Pubkey>, deadline:Option<u64>`。OptionはBorshの0/1 tag。opはdeposit=0、mutual_close=1、initiate_escape=2、challenge_escape=3、finalize_escape=4、claim_expired=5で、buffer/tree opとは別enum。

deposit/expiryではOptionを全てNone。mutual_closeはN/B/ownerがSome、deadlineだけNone。initiate_escapeは作成済みPending、challenge/finalizeは消去前のPendingに対応するN/B/owner/deadlineがすべてSome。C/D/expiryは常に元Noteの値。initialize_poolの初期sequenceは0、資金遷移以外の管理・buffer操作はsequenceを増やさない。

indexerはmeta.err=nullの成功transactionだけを、block内transaction順・CPIを含む実行順で適用し、program IDとinvocation stackを検証する。sequenceの欠落・重複内容不一致を拒否する。ログ欠落時はinline args、またはbufferのcreate/append/seal/execute/closeの成功履歴からpayloadを復元する。bufferはPDAだけでなく作成transactionを世代識別子にし、digest・offset・executeのexpected_digestを照合する。実行後にcloseされたaccountをRPCで読めるとは仮定しない。archiveが必要履歴を提供できなければpath配信を止める。

## 5. Transactionサイズと一時buffer

初版の必須・既定経路はv0 transaction＋payload buffer（各送信1232 bytes以内）。ALTなしでも成立させ、walletのv0署名を検証する。全proof・tree更新・転送は最後のexecute一命令で成立させる。inlineは最終IDLで実serializeして収まる場合のみ同じhandlerへ渡す。

v1 inlineは追加能力。対象cluster/RPC/SDK/walletと4096 bytes等の実limitを確認し、I04の実送信が成功したmanifestだけにadvertiseする。v1ではCU/data limitをmessage configへ設定しpriority feeは総lamportsとして扱う。未対応を推測で有効にせずv0_bufferを使用する。indexerのmaxSupportedTransactionVersionは対象deploymentで実証した値（初版は0）とする。[Solana v1資料](https://solana.com/upgrades/larger-transaction-sizes)

buffer手順：`create_payload(op,len,digest,nonce,expires)` → `append_payload(offset,bytes)` → `seal_payload()` → `execute_payload(expected_digest:[u8;32])` → `close_payload()`。

buffer op:u8はdeposit=0、mutual_close=1、initiate_escape=2、challenge_escape=3、claim_expired=4。他の値は拒否（tree-transition回路のopとは別enum）。create argsは順にu8/u32/[u8;32]/[u8;32]/u64、appendはu32 offsetとBorsh Vec<u8>、seal/closeはargsなし。executeはexpected_digest:[u8;32]を署名対象instruction dataに含める。

- len<=4096、expires<=作成時+3600秒。opはdeposit/close/escape/challenge/expiryだけ。
- appendはuploader署名、offset=next_offset、範囲内。既存byteの書換え不可。sealは全byte受領とSHA256一致を確認。
- executeはuploader署名、expected_digest=buffer.digest、pool・op・seal・期限を検査。payloadはlayout 2の対象inline命令のargsそのもの（discriminatorを除く）、固定長はtree-transition §3どおり。opから命令を一意に選び、旧path形式・余分な末尾byteを拒否。account条件はinlineと同じ。depositでは元token owner署名も必須。
- 署名はbuffer accountとinstruction data内のexpected_digestに結合する。同じPDAをclose後に再作成して別内容をsealしても、以前のexecute署名はInvalidBufferで拒否する。封印だけでは資金・root・noteを変更しない。
- execute成功時にbuffer accountをcloseし、rentは保存済みrent_payerへ返す。失敗なら封印状態を保つ。close_payloadはuploaderによる中止または期限後の回収用。成功後に不要なcloseを送らない。account不在だけでexecute成功とは判断せずsignature/状態で確認する。
- 同じpayloadの別buffer再実行は、note ID/root/status/nullifierで拒否。stale rootは新path/proofで新bufferを作り、古いbufferをcloseする。

## 6. 採用tree方式とG1計算量判定

[ADR-0001](../adr/0001-proof-bound-tree-transition.md)により追加tree Groth16証明（`transition_proof`）、`proof_bound` tag検証、layout 2を採用する。元のrequest/withdrawal回路・Poseidon・32段treeは維持する。tree回路がleaf、旧新root、同じpath、op、値域、transition_tagを制約し、programは固定VKで全11公開入力を検証する。programによるtag/leaf/pathのPoseidon再計算は要求しない。実状態・命令・認可proofとの照合は[tree-transition仕様](tree-transition.md)に定義する。

[I02の実測](../evidence/I02.md)ではtag再計算を省く研究用案が365,907〜671,266 CU。その後[I02-B](../evidence/I02B.md)で現仕様へ標準化し、実SBFの257ケース、最大317,443 CUを確認した。[I03](../evidence/I03.md)ではVault account/ATA/PDA/CPI/eventを統合して最大426,765 CUを確認。I04の全transportは未完了でG1は未合格。元tree直接計算・tag再計算付きfallbackのCU超過は比較用の履歴として保持する。

release目標は**全命令のworst-case <=1,000,000 CU**、実transactionが採用format内。100万CUはprotocolの余裕を含む設計目標でありSolanaの絶対上限ではない。I03/I04では全PDA/ATA作成、proof binding、status/nullifier、Token CPI、event、buffer処理込みで測る。予算超過時に検査を省いたり目標を無断に引き上げたりしない。

追加回路のsource/constraints/VK/setupとclient証明生成・root競合の受入条件は固定済み。I03は共通codec/binding/proverを統合し、全Vaultの実SBF 366取引、最大426,765 CU、863 bytesと元EVMの7シナリオ比較を完了した。I04の全upload/wallet/buffer経路とtarget clusterは未検証で、G1は未合格。新poolのみlayout 2を使い、既存poolのVK/backend/署名公開鍵を上書きしない。production setup・全機能同等性の未検証項目も公開gateとして残す。
