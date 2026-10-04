# 実装タスクと受入条件

2026-10-04：**I08/I09のlocal実装・受入を追加**。[対応表](evidence/I08-I09-local-acceptance.md)、[I08](evidence/I08.md)、[I09](evidence/I09.md)に再現commands・runtime結果・artifact hash・制限を記録する。初期sliceの未実装項目だったWASM/wallet/Go、challenger常駐送信と復旧、dispatcher/fencing/DB復旧/運用を既存の共通部へ接続した。追加実装の[local受入後レビュー](evidence/I08-I09-local-review.md)で復旧・停止・管理APIを修正し、再検証した。

I01〜I07のlocal証跡は保持する。元回路・layout 2・mandatory v0_bufferと[ADR-0002](adr/0002-build-validated-signing-keys.md)を維持し、実provider・実wallet/公開RPC・production運用環境・hosted CI・G1〜G4は未合格のまま。I10への完了引継ぎは宣言しない。localの実暗号/SBF/process/DB結果と、公開環境のE2E・負荷/障害受入を区別する。

## 1. タスク

| ID | 担当component / 変更箇所 | 依存 | 完了条件 |
|---|---|---|---|
| I01 | workspace・vendor・CI | なし | 固定upstreamをlicense付き取得、manifest SHA再照合、元テストbaseline記録、exact toolchain lock、crate/Go/TS CI起動 |
| I02 | crypto・SBF検証harness | I01 | I02-Aの実測＋下記I02-B。採用tree回路/wire/profile、実状態とWP/RPのbinding、混合した有効proofの拒否、採用方式SBFの100万CU、proof生成/サイズ記録。全VaultのG1はI03/I04/I10で完了 |
| I03 | Anchor Vault / USDC | I02-B（scaffold/IDLは並行可） | 全命令、PDA/ATA/authorityチェック、元Vaultとの差分シナリオ、転送失敗rollback、イベント、IDL。P01/P02/P03/P16〜P21 |
| I04 | buffer・SDK transaction・indexer | I03 | expected_digest署名結合付きlayout 2/v0 buffer経路（v1は任意追加）、wallet対応、finalized path、snapshot再構築、blockhash切れ/重複送信/競合試験。P22/P28 |
| I05 | Postgres ledger・quote・signer（local完了：[証拠](evidence/I05.md)） | I02-B,I03,I04 | [実装引き継ぎ](i05-implementation-ready.md)のA〜F。schema適用、N/clearance排他、quote/proof binding、row lock予算、署名対象一意、schema migration・dispatch attempt fencing・署名明細試験。P05〜P10/P14/P15 |
| I06 | OA-org / OpenRouter direct adapters（local完了：[証拠](evidence/I06.md)） | I05,I04 | 元のissuer/verifier検証、key発行/disable/usage/delete、unknown recovery、実usage精算。P11〜P13 |
| I07 | proxy / 3 provider adapters（local完了：[証拠](evidence/I07.md)） | I05,I04 | OpenAI Chat/Responses、Anthropic Messages、OpenRouter Chat、SSE、tool call、metering、cap、UNKNOWN waiver。P32〜P36 |
| I08 | SDK/WASM・Go clientd（local受入：[証拠](evidence/I08.md)） | I04,I05,I06,I07 | 秘密storage、proof worker、note journal、local API、mode選択、expiry表示、Tor、native配布。P04/P23〜P27 |
| I09 | challenger・ops・dashboard（local受入：[証拠](evidence/I09.md)） | I03,I04,I05（運用統合はI06,I07） | 過去RP/proof+現在zero pathのtree proof、期限再送、signer/DB復旧、secret redaction、監視、ダッシュボード。P29〜P31 |
| I10 | E2E・負荷・障害注入 | I06,I07,I08,I09 | G1全体/G2、全modeで入金→利用→精算→出金、実providerでG3。二重署名・二重課金・cap超過転嫁なし |
| I11 | setup・review・release | I10 | ceremony/transcript、第三者review、実mint/manifest、multisig、restore演習、G4。配布物再現build |
| I12 | mainnet配備手順の実行 | I11 | 別途配備作業として実アドレスとreceiptを記録。初回の設計作業では実行しない |

backendは採用済み。I02-B完了を全Vault未実装のままG1合格とは呼ばない。I03/I04の完成後に全命令/transportの実測でG1を判定する。I06/I07の実provider権限とI11 production ceremonyは後続の公開条件であり、local実装はtest環境で進める。

### I02-Bの完了範囲（B1〜B4完了）

| 順序 | 成果物 | 完了条件 |
|---|---|---|
| B1 | host専用`crates/zkapi-tree-prover`へ回路/生成CLI、既存typesへTreeUpdate型を抽出 | 研究回路の制約/同じwitnessの意味を比較、元PK/VK互換は実検証、host用proverをSBFへリンクしない |
| B2 | 固定VKのSBF検証部と共通public input binding | 11 inputs・op・canonical検査、WP/RPと実状態のTT01/TT02。元proofだけ成功して別Noteを操作できない |
| B3 | layout 2 codec・profile/empty root生成・fixture | public→proof順、5命令payload長、domain不変、署名manifest/profileの一致、test/prod分離 |
| B4 | 採用方式の実SBF測定と引継ぎ | TT01/TT02、normative wireでdeposit/close/escape/challenge/expiry相当、token失敗rollback、<=100万CU。実際に測ったaccount範囲を明記 |

B1〜B4は既知test fixtureで完了した。[257ケース・CU・native CLI・EVM照合の記録](evidence/I02B.md)を参照。programs/i02-harnessの研究用opcode・proof-first payload・固定送金額・payer authorityをVaultの正本にしない。旧baseline/研究比較はそのまま再現可能に保持し、採用方式の結果を別reportへ保存する。

I03の最初にAnchor/SDK/Agaveの依存を解決しexact version/Cargo.lockを記録、最小SBFをbuildしてからVaultへ広げる。I02で実証したv0を開始点とし、未検証v2/v3やv1を必須にしない。test setupからproduction setupへの切替でもSBF/CU/profile整合を再検証する。

## 2. 必須テスト

| ID | 対象 | シナリオ / 判定 |
|---|---|---|
| T01 | crypto | upstream real proofをnativeとSVMで同じ結果。各public field、proof座標、VK、A符号、G2順を改変すると拒否 |
| T02 | binding | cluster/program/pool/mint/token program/destinationの1byte差でbinding変化。quote/mode/credential差で認可拒否 |
| T03 | tree | 追加tree証明の11 fields/同一32段path、zero挿入、除去・復元、最大ID 2^32−1とcounter=2^32のTreeFull、異なるroot/path、expiry日境界 |
| T04 | token | 偽mint/Token-2022/別ATA/別authority/凍結/不足/overflow拒否。資金とroot/statusが同時rollback |
| T05 | exits | 合意/escape/challenge/finalize/expiry/pause全遷移。deadline等号、historical root、N tombstone維持 |
| T06 | transactions | layout 2固定wire、v0各送信1232 bytes、buffer全段階crash（v1はadvertise時のみ実証）、封印後改変・同PDA別digest再作成への旧署名・第三者実行・再実行拒否、rent返却、blockhash再送 |
| T07 | authorization | 同じN同時100件は1予約、同じbody再送は同じ結果、異なるbody拒否、clearanceとの競合 |
| T08 | quote | 期限切れ未受理拒否、受理済み期限切れ復旧、改ざん署名/未知field/重複key/float金額拒否 |
| T09 | proxy cap | 4並列の予約で合計<=cap、5件目制限、上限超過usageは運営負担、cache項目重複なし、期限等号・row lock待ち中の期限超過/closeとの原子的受付競合 |
| T10 | rounding | 0、1 nano、999/1000/1001 nano、項目別有理数の合算後nano切上げ、複数operation合算、direct USD厳密変換、料金分母0/overflow、MAX近傍。micro切上げはsessionで1回 |
| T11 | proxy faults | 送信直前/直後/stream途中/usage取得後/DB commit前後crash。二重dispatchなし、切断で無料化しない、送信owner停止→waiver→旧owner再開時の送信拒否、fence不能時署名保留、waiver後の追徴なし |
| T12 | direct faults | キー発行応答喪失、usage遅延、disable/delete不明、202/切断後の遅延発行成功をdrain、SDKのkey欠落復旧close、plaintext key再送なし、0 usageで新state1つ |
| T13 | signer | SIGN_PENDING直後/署名直後/保存後crash。同一requestに別charge/anchorを署名しない |
| T14 | chain race | escapeと認可/キー返却/proxy実行の競合、RPC片側遅延、challengeで回復、claim後認可拒否 |
| T15 | privacy | E2Eログ・DB・trace・backupにseed、prompt、応答、token、provider keyなし。direct認可にprompt混入拒否 |
| T16 | compatibility | 対応APIのtext/tool call/SSE/error/usage。未対応modalities/hosted tools/Responses保存機能は送信前拒否 |
| T17 | client | 再起動・二重タブ・journal不一致・wallet拒否・WASM失敗・秘密backup復元。状態を二重に進めない |
| T18 | ops | primary/writer/dispatcher停止/fencing、backup restore、ログ欠落・buffer close/reuseを含むsnapshot/全履歴replay一致、signer journal照合、challenger遅延アラート |
| T19 | receipts | OA署名明細、OpenRouter管理usage、proxy計測を別証拠区分で署名明細APIから取得・整数再計算し実provider照合 |
| T20 | release | artifact改ざん拒否、PK/VK pinning、manifest環境混在・multisig/receipt key欠落拒否、devnet mintをmainnetで拒否 |

## 3. 追加機能の完成条件

| ID | 必須機能 | タスク | テスト |
|---|---|---|---|
| P32 | 第三者proxyのZK認可・session credential | I05,I07 | T02,T07,T08,T15 |
| P33 | OpenAI/Anthropic/OpenRouter API adapters | I07,I08 | T16,T19 |
| P34 | 同時実行・上限予約・整数精算 | I05,I07 | T09,T10 |
| P35 | SSE/切断/unknown usage復旧 | I07,I10 | T11,T13 |
| P36 | provider別対応表・料金表・privacy表示 | I07,I08,I09 | T15,T16,T20 |

P01〜P31はproduction-parity.mdの定義を継承。P32〜P36も初回productionの必須であり、後回しの候補ではない。stageの順序で最終要件を削らない。

## 4. I05完了時の開始指示（履歴）

> docs/implementation-ready.md、ADR-0001/0002、evidence/I04.md・I05.md、ledger/API仕様とi05-implementation-ready.mdを読み、I06 direct・I07 proxyのprovider adaptersへ進む。I04のbuffer・SDK transaction・indexerとI05のPostgres ledger・quote・signerを再実装せず利用する。I05のlocal test adapterを実provider対応と扱わず、直接接続の発行/失効/最終usage、proxyの推論/SSE/usage正規化を個別に検証する。N/clearance排他、整数予算予約、idempotency、sign-once settlement、送信owner停止と未知usageの再送禁止を維持する。元回路/Poseidonと固定profileを維持する。G1〜G4を未検証のまま合格にしない。購入・provider契約・mainnet配備は開始指示に含めない。

## 5. I06/I07完了後の再開位置（履歴）

この開始順序に沿って実装した現在の結果は[I08/I09 local受入](evidence/I08-I09-local-acceptance.md)を参照する。以下の着手指示を現在の未実装一覧として扱わない。

[I06/I07引き継ぎ](i06-i07-implementation-ready.md)と[I08/I09実装開始契約](i08-i09-implementation-ready.md)を読み、I08とI09へ進む。上のI06/I07開始指示は当時の受入契約として保持する。local provider HTTP fixtureの成功を実provider/G3合格としない。共通ledger・署名journal・checkpoint・native adapterを再利用する。

I08はmanifest/prover bridge → 暗号化journal/排他 → 制御API/署名receipt検証 → browser/wallet → Go clientd → Tor/配布の順。I09は独立read modelとPending監視 → 過去RP＋現在treeのchallenge/永続送信 → dispatcher分離/fencing → DB/signer復旧 → dashboard/監視の順。I08の基盤とI09のchallengerは並行着手できる。具体的な再利用path・失敗条件・受入試験は上記契約に固定し、実装完了はI08.md/I09.mdの新規runtime証拠で判定する。
