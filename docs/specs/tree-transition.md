# Tree transition — layout 2実装契約

[ADR-0001](../adr/0001-proof-bound-tree-transition.md)の採用方式。初版は`transition_proof / proof_bound / layout_version=2`を固定する。本書はtree回路・入力結合・wire・proverの正本。[protocol](protocol-solana.md)の一般account/権限/資金/状態条件もすべて適用する。

## 1. 回路とprogramの責務

元request/withdrawal回路は不変。tree回路のIDは`solana.zkapi.tree.v1`、Groth16 BN254、Arkworks 0.5系列、32段。元`zkapi-core::v2`と同じPoseidon定数・width=3/rate=2/capacity=1、8 full/57 partial、alpha=5、domain・吸収・出力規則を使う。標準Poseidon syscallへ置換しない。

公開入力は以下の**11 Frを0-basedの順序で全て検証**する。各入力はcanonical 32-byte BE、外部入力をmod rで正規化して受理しない。

| index | 名称 | 回路の拘束 / programが照合する正本 |
|---|---|---|
| 0 | vault_binding | tagに拘束。PoolConfigと実pool/program/genesis/mint/token programから得たbindingと一致 |
| 1 | old_root | 同じpathのold_leafから導出。命令実行時のTreeState.rootと一致 |
| 2 | new_root | 同じpathのnew_leafから導出。検証成功後に書くrootはこの値のみ |
| 3 | note_id | u32のbit decompositionと一致。depositのnext IDまたは命令が指すNote IDと一致 |
| 4 | old_leaf | opで選択した0またはL。programでLを再計算しない |
| 5 | new_leaf | opで選択したLまたは0。programでLを再計算しない |
| 6 | commitment | L/tagに拘束。deposit argsまたはNote.commitmentと一致 |
| 7 | deposit | u64 witnessと一致、L/tagに拘束。deposit argsまたはNote.depositと一致 |
| 8 | expiry | u64 witnessと一致、L/tagに拘束。deposit argsまたはNote.expiryと一致 |
| 9 | op | 0/1/2だけ。呼ばれた命令から決めるtree opと一致 |
| 10 | transition_tag | `H([Fr(BE("solana.zkapi.tree.v1")), p0,…,p9])`と一致。固定VKの検証に含め、programは再計算しない |

private witnessは32 canonical Fr siblingsのみ。`L=H([Fr(BE("zkapi.v2.leaf")), id,C,D,expiry])`。op=0 insertとop=2 restoreは`(old_leaf,new_leaf)=(0,L)`、op=1 removeは`(L,0)`。各levelでidのLE bitに従い左右を選び、`H([Fr(BE("zkapi.v2.node")), left,right])`を計算する。old/newに**同じsiblingsと同じid**を使用する。秘密note・残高・署名はこの回路の入力に含めない。

programはp4/p5のうちopで0となる側を0と比較してよいが、L側の正当性は証明で保証する。hashが0となる値を新たに拒否する規則は追加しない。金額のprotocol上限、D>0、C!=0、expiry日丸め、next ID、status、署名権限はprogramの責務。u64をFrへ変換する前に整数条件を検査する。

初期empty rootは元hashで`z0=0; z[i+1]=H_node(zi,zi)`のz32。I02-Bで元Rust・EVMの両方と照合した定数とSHAを生成し、programへ埋め込む。initialize_poolで32段のPoseidonをSBF再計算しない。client/indexerでは同じ定数を検証できる。

## 2. 命令との結合

TPをtree public inputs、WPを元withdrawal、RPを元requestとする。比較はcanonical decode後に行う。全accountは同じpoolの正しいPDA/owner/layoutであることが前提。

| 命令 | tree op / leaf | 必須の結合・状態条件 |
|---|---|---|
| deposit | 0 / 0→L | expected_root=TP1=current root、expected_id=TP3=next_note_id（2^32ならTreeFull）。C/D/expiry=args=TP6/7/8。amount>0/上限、expiry=ceil((Clock+TTL)/86400)*86400。token owner署名。Noteは未作成 |
| mutual_close | 1 / L→0 | WP8=Note.id=TP3、WP3=TP1=current root、WP2=TP0=pool binding。WP0=2、WP1=namespace、WP4..7=config keys、WP12=1。Active、WP9<=D、WP11未使用、WP10=H2F(実destination owner)。元WP proof検証 |
| initiate_escape | 1 / L→0 | closeと同じNote/root/binding/keys/宛先/額/N条件、WP12=0。Active→Pending、Nを消費。WP9/10の実宛先owner・WP11・旧root・deadlineをPendingに保存。転送なし |
| challenge_escape | 2 / 0→L | 命令note_id=Note.id=TP3、TP1=current root、TP0=RP2=pool binding。RP0=2、RP1=namespace、RP4..5=config state key、RP8=Pending.nullifier。PendingかつClock<deadline、元RP proof検証。認可時のRP3を変更/現在rootと比較しない |
| claim_expired | 1 / L→0 | 命令note_id=Note.id=TP3、TP1=current root、TP0=pool binding。ActiveかつClock>=Note.expiry。元request/withdrawal proofは不要、D全額をtreasuryへ |
| finalize_escape | なし | PendingかつClock>=deadline。保存されたB/ownerへ転送、root不変。新tree proofや新withdrawal proofを要求しない |

deposit以外のTP6/7/8は**保存済みNote**と一致させる。TP4/5の自己申告値やuploaderが作った別Noteを正本にしない。tree removeを共用するclose/escape/expiryでも、入口ごとの権限・時刻・clearanceを省略しない。`op=1`のtree proofだけでは出金権限にならない。

challengeのRPは過去の正常認可の証拠。`RP3 == current_root`も`RP3 == Pending.old_root`も要求しない。requestには公開note IDがないため、RP8とPending.nullifierの一致で結び付ける。現在treeの復元対象Noteは命令/PDA/Pendingから確定する。APIのquote期限/request_time freshnessをchallengeへ持ち込まない。成功してもExitNullifier tombstoneを消さない。

WP13とRP9は元のwithdrawal/authorization tagであり、元proofの公開入力として従来どおり検証する。Solana向けTP10との取り違えを禁止する。

### 実行順序と原子性

1. 命令/長さ/field/座標をdecodeし、固定programとaccount owner/PDA/layout/mint/token program、signer、bufferのpool/op/uploader/digest/seal/期限を確認。
2. Clockと現在のPoolConfig/TreeState/Note/Pendingを読み、上表の整数・状態・公開入力結合を確認。事前simulationの値だけを信頼しない。
3. 必要な元request/withdrawal proofとtree proofを固定VKで検証。両方の成功前に有効なroot/Note/exitを公開しない。
4. 全状態更新、必要なPDA/ATA作成、PDA署名Token CPI、outstanding_deposits不変条件、sequence/event、buffer消費を同じinstructionで行う。どのCPI/検査の失敗でもtransaction全体がrollbackする。

buffer経路とinline経路は同じ内部handlerと検査関数を呼ぶ。片方だけbinding/statusチェックを省略しない。harnessの固定転送額・payer authority・opcodeをVaultの仕様に持ち込まない。

## 3. Layoutとwire

初版の全program accountsは8-byte Anchor discriminatorの直後に`layout_version:u8=2`を持つ。旧layout=1を受け付けず、既存poolの書換えmigrationを実装しない。protocol_version=2、HTTP `/zkapi/v1`、tree circuit IDのv1は別のversion軸。

PoolConfigは既存fieldsに`tree_backend:u8=1`（transition_proof）、`tree_tag_policy:u8=1`（proof_bound）、`circuit_profile_hash:[u8;32]`を追加し、初期化後immutable。これらは埋込み定数から設定し、利用者がVKやpolicyを指定する引数を設けない。全命令でaccount profileとprogram埋込みprofileの一致を検査する。

型：`TP=[F;11]`、`TreeUpdate={public:TP, proof:Proof}`。Borsh field順は**publicの352 bytes→proofの256 bytes**、合計608 bytes。Vec lengthやtag prefixは付けない。proofは元と同じ非圧縮256-byte wire、canonical Fq・無限遠・曲線・subgroup・A符号・G2係数順の変換規約を共用する。

layout 2 inline argsは[protocol §4](protocol-solana.md)の順で、最後のsiblingsをTreeUpdateへ置換したもの。`destination_owner`はWPに結合する実accountであり、TreeUpdateに宛先を重複追加しない。

| 命令 | args（discriminatorを除く） | args bytes / discriminator込み |
|---|---|---:|
| deposit | expected_id:u32, expected_root:F, expiry:u64, commitment:F, amount:u64, tree:TreeUpdate | 692 / 700 |
| mutual_close | public:WP, proof:Proof, tree:TreeUpdate | 1,312 / 1,320 |
| initiate_escape | public:WP, proof:Proof, tree:TreeUpdate | 1,312 / 1,320 |
| challenge_escape | note_id:u32, public:RP, proof:Proof, tree:TreeUpdate | 1,252 / 1,260 |
| claim_expired | note_id:u32, tree:TreeUpdate | 612 / 620 |
| finalize_escape | note_id:u32 | 4 / 12 |

bufferのpayloadは**上表のargsのみ**で、Anchor discriminatorを含めない。buffer.opから一意に命令を選ぶ。opはdeposit=0/close=1/escape開始=2/challenge=3/expiry=4。tree op 0/1/2とは別enum。固定長と末尾一致を必須とし、古い1024-byte pathを受け付けない。hashは正確なpayload bytesに対するSHA256。create/execute署名とdigest、account pool/uploader/opを結合する既存buffer規則を維持する。

これらはinstruction dataの値でありtransaction全体のサイズではない。最終IDLのaccount list・独立payer/owner・ComputeBudget込みで各v0 transaction<=1232 bytesをI04で確認する。appendの最大chunkはserialize結果から決め、測定の900 bytesを無条件に固定しない。versioned transactionにはv0を使い、ALTを必須にしない。全命令はbuffer経路を必須とし、収まるinline命令は同じ検証で許可する。

研究harnessのpayloadはproof→public順で、account/opcodeも異なる。本wireの実SBF検証・CU再測定は[I02-B](../evidence/I02B.md)で完了した。I03では全Vault account処理を含めて再測定する。既存fixtureの`proof_wire_hex`と`public_inputs`はフィールド値として再利用し、harness transactionを本番payloadとして流用しない。

## 4. Proof生成、競合、公開情報

SDK/CLI内部APIを以下に固定する。通常の利用認可APIへtree proofを追加しない。専用の公開proving HTTP serviceは初版の必須にしない。

```text
prepare_tree_transition(snapshot, pool_config, note_or_deposit_args, operation, siblings)
  -> TreeWitness { public[11], siblings[32] }
prove_tree_transition(witness, pinned_tree_pk, rng) -> TreeUpdate
verify_tree_transition(update, pinned_tree_vk) -> Result
encode_layout2_args(operation, auth_inputs_and_proof, update) -> bytes
```

prepareはpathの旧root・leaf・op・整数範囲を元hashで検査する。PKをhash照合してからproveし、得たproofを固定VKでローカル検証、全公開入力を作成時の期待値と照合してからアップロードする。暗号RNGを用いる。test-onlyの固定RNGを配布proverへ持ち込まない。

tree proverへの入力は公開のpool/Note/path/操作だけ。workerを使う場合もsecret・残高blinding・state/clearance署名・通常認可のnote ID対応を追加で渡さない。通常認可のrequest証明は引き続き端末で生成する。tree生成/アップロードにはnote IDが伴い、これを通常認可のsessionへ結び付けるログを作らない。workerの正しさはproof検証で確認し、workerの稼働を退出の唯一の前提にしない。

生成/送信journalにpool、対象命令、expected id/root、snapshot sequence/slot、全payload bytes/digest、buffer pubkey、blockhash/lastValidBlockHeight、transaction signatureを保存する。tree状態を予約したとは扱わない。

- 送信結果不明：まずsignatureとchainの成功記録・Note/root/status/Nを照会。結果不明のまま別入金・別exitを送らない。
- 未成立と確定したstale root：最新pathで再生成し、新digest/新bufferにする。close/escapeはWP.active_rootも現在rootに対応させて元withdrawal proofを再生成する。clearance/nullifierの取得状態は保持する。
- challenge：過去RP/proofを保持し、現在のzero pathに対するtree proofだけ作り直す。nullifierやrequest_timeを書き換えない。
- deposit：next IDとClockのexpiry日境界を再検査し、変わればtree proofを作り直す。SDKは入金確定前にnote IDを確定済みとしてjournalへ登録しない。
- buffer seal後もpath/rootが失効し得る。execute失敗時はbufferを保持し、uploaderがcloseしてrentを回収できる。TTLを超えたbufferの回収条件はprotocol §5のまま。

root復帰（remove→restore）により、同じ公開遷移が再び正当となる場合がある。tree proof自体をone-time tokenとは扱わず、current root・status・next ID・exit N・認可条件で再実行の可否を決める。正当な再復元までsequenceをproofへ追加して禁止しない。

## 5. Circuit profileとsetup

Manifestは`protocol_layout_version=2`、`tree_backend=transition_proof`、`tree_tag_policy=proof_bound`、`transaction_formats`に`v0_buffer`を必須とする。`tree_proof_artifacts`はnull不可で、tree circuit ID、公開入力数11、回路ソースbundle hash、PK/VK hash、verifier constants hash、setup transcript hashを持つ。`setup_profile=test_only`ではtranscript hashをnull、`ceremony_verified`では3回路すべてのtranscript hashを必須とする。

`circuit_profile_hash = SHA256(JCS({ protocol_layout_version, tree_backend, tree_tag_policy, circuit_id, request_pk_hash, request_vk_hash, withdrawal_pk_hash, withdrawal_vk_hash, tree_proof_artifacts, setup_profile, setup_transcript_hashes }))`。フィールド名・型はOpenAPI Manifestに一致させ、`manifest_hash`やprofile hash自身は入れない。PK/VK hashは配布ファイル全bytes、verifier constants hashはprogramに埋め込むtree VKの決定的wire bytesのhash。wireは`alpha G1(64) || beta G2(128) || gamma G2(128) || delta G2(128) || IC[0..11] G1(12*64)`、BE/canonical、G2 c1,c0のSolana順、alpha/ICは非反転。ソースbundle hashは配布するexact archive bytesのSHA256（回路ソース・Cargo.lock・hash定数を含む）。

同じprofileをprogramへ埋込み、PoolConfigへ保存する。SDK/serverは署名manifest、実PoolConfig、埋込みVKに対応する配布artifactを照合し、不一致なら起動/利用を拒否する。固定回路でVKだけを無言に更新しない。新setup/VK/profileは新pool・対応program buildとして配備する。既存poolをupgradeで別profileへ変更しない。

現在のtree fixturesは`solana.zkapi.tree.v1/test-only-arkworks-0.5`というテストartifact名で、33,198 constraints。意味上の回路IDとartifactのテスト表示を区別する。I02-Bでは制約差分・同一witness結果・相互VK検証を照合し、回路をcrateへ移すだけでも同一setup流用を推測しない。制約が変われば新artifact版と再setupを必要とする。

productionはrequest/withdrawal/treeの3回路でレビュー済みsetup/contribution/transcript検証を行う。`setup_profile=test_only`、既知test key hash、未検証transcriptをproduction manifest/build/deployの検査で拒否する。環境名を変更するだけでtest artifactを昇格させない。実chain IDや秘密鍵が未発行でもlocal実装には着手できる。本番のsetup完了はI11/G4で判定する。

## 6. 受入条件と担当境界

| ID | 実装担当・必須の検証 |
|---|---|
| TT01 | I02-B：全11公開入力・各siblings・u32/u64境界・op・旧新path不一致を拒否。元hash vectors、tag、empty rootを独立実装と照合 |
| TT02 | I02-B/I03：単体で有効な別Note/Vault/rootのWPとTP、別PendingのRPとTPの組合せを拒否。byte改変試験だけで代用しない |
| TT03 | I03：deposit、close、escape開始、challenge、finalize、expiryの成功/拒否条件を固定EVMと比較。比較詳細は下記 |
| TT04 | I03：偽account/別pool/layout/profile/VK、宛先・key・clearance・status・TTL・N・最大ID、2回目CPI失敗で状態/残高/sequence全rollback |
| TT05 | I04：上表のwire、payload length/op、public/proof順、全buffer段階、seal後stale、同PDA別digestへの旧署名、再送/rollback/rentを検査 |
| TT06 | I03/I04：全資金命令の最大負荷と通常失敗経路で<=1,000,000 CU、署名/実accounts付きv0各送信<=1232 bytes。ATA/PDA作成、イベント、buffer closeも含む |
| TT07 | I08/I09：native prover必須、browser workerの時間/メモリーを記録。worker停止でもローカル出金/challenge生成可能、root競合・expiry日境界・送信不明を復旧 |
| TT08 | I11：test key/mainnet設定・改変PK/VK・profile/hash不一致・欠落transcriptを拒否。3回路のsetupとproduction SBFで再測定 |

EVM比較は同じ整数D/B/id/時刻/操作列・元hashを使い、root、leaf集合、next ID、Note status、PendingのB/N/deadline、nullifier消費、利用者/treasuryの増減を照合する。資産単位を対応させ、EVM addressとSolana owner/bindingは各環境で正しく証明する。同じproof bytesのchain間受理は求めない。全成功ケースは実proofを使い、mock版の状態機械試験は補助と明記する。

必須trace：入金→署名付き利用/精算→合意出金、escape→deadlineでfinalize、認可A→別入金Bでroot変更→Aのescape→保存した過去RPでchallenge、Activeの期限切れ、pause中のchallenge/finalize/expiry、challenge後の同N再利用拒否。双方でroot等号だけでなく拒否条件を比較する。既存の意図した差分（USDC/H2F、counterだけu64で最大u32 IDを利用可能）を比較レポートへ明記する。

研究harnessの37〜67万CUに続き、採用方式の[I02-B](../evidence/I02B.md)では約15〜32万CUを実測した。いずれも記録したmeasurement account範囲の値。性能目標は全命令100万CUのままで、基準を緩めて設計Readyにしない。native tree prove＋送信がchallengeの5分目標に収まるかをI08/I09で測り、root競合下の再試行も含める。browser性能の実測が不足してもnative経路を隠さず提供し、UIを無限待ちにしない。
