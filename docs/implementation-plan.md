# 実装タスクと受入条件

[I01](evidence/I01.md) baseline完了、[I02](evidence/I02.md) 基盤レビュー修正済み（2026-10-03 JST）。次の実装はI02のSBF/SVM/CU・tree backend決定。I03/I05の依存条件はまだ未達で、I03以降は未着手。担当は作業componentを示し、外部の人員を割り当てたことは意味しない。各完了時に `docs/evidence/Ixx.md` へ実行command、version、artifact hash、結果、未解決事項を残す。mock結果と実proof/provider結果を区別する。

## 1. タスク

| ID | 担当component / 変更箇所 | 依存 | 完了条件 |
|---|---|---|---|
| I01 | workspace・vendor・CI | なし | 固定upstreamをlicense付き取得、manifest SHA再照合、元テストbaseline記録、exact toolchain lock、crate/Go/TS CI起動 |
| I02 | crypto・SBF検証harness | I01 | H2Fのfield数/順序vectors、元Poseidon vectors、実request/withdrawal proof生成、Solana検証、全public inputの改変拒否、CU/bytes計測、tree backend確定。G1の暗号部分 |
| I03 | Anchor Vault / USDC | I02 | 全命令、PDA/ATA/authorityチェック、元Vaultとの差分シナリオ、転送失敗rollback、イベント、IDL。P01/P02/P03/P16〜P21 |
| I04 | buffer・SDK transaction・indexer | I03 | expected_digest署名結合付きv1/v0 buffer経路、wallet対応、finalized path、snapshot再構築、blockhash切れ/重複送信/競合試験。P22/P28 |
| I05 | Postgres ledger・quote・signer | I02 | schema適用、N/clearance排他、quote/proof binding、row lock予算、署名対象一意、schema migration・dispatch attempt fencing・署名明細試験。P05〜P10/P14/P15 |
| I06 | OA-org / OpenRouter direct adapters | I05,I04 | 元のissuer/verifier検証、key発行/disable/usage/delete、unknown recovery、実usage精算。P11〜P13 |
| I07 | proxy / 3 provider adapters | I05,I04 | OpenAI Chat/Responses、Anthropic Messages、OpenRouter Chat、SSE、tool call、metering、cap、UNKNOWN waiver。P32〜P36 |
| I08 | SDK/WASM・Go clientd | I04,I05 | 秘密storage、proof worker、note journal、local API、mode選択、expiry表示、Tor、native配布。P04/P23〜P27 |
| I09 | challenger・ops・dashboard | I03,I04,I05 | 過去proof+現在zero path、期限再送、signer/DB復旧、secret redaction、監視、ダッシュボード。P29〜P31 |
| I10 | E2E・負荷・障害注入 | I06,I07,I08,I09 | G1全体/G2、全modeで入金→利用→精算→出金、実providerでG3。二重署名・二重課金・cap超過転嫁なし |
| I11 | setup・review・release | I10 | ceremony/transcript、第三者review、実mint/manifest、multisig、restore演習、G4。配布物再現build |
| I12 | mainnet配備手順の実行 | I11 | 別途配備作業として実アドレスとreceiptを記録。初回の設計作業では実行しない |

I02のtree CUが不合格ならprotocol仕様のtree-transition回路をI02内で実装・setup・計測してからI03へ進む。仕様変更を必要とする失敗を隠して後続を本番完了にしない。I06とI07の実provider権限はG3の外部依存。コード実装は権限取得を待たずmock/test環境で進められる。

## 2. 必須テスト

| ID | 対象 | シナリオ / 判定 |
|---|---|---|
| T01 | crypto | upstream real proofをnativeとSVMで同じ結果。各public field、proof座標、VK、A符号、G2順を改変すると拒否 |
| T02 | binding | cluster/program/pool/mint/token program/destinationの1byte差でbinding変化。quote/mode/credential差で認可拒否 |
| T03 | tree | 32段path、zero挿入、除去・復元、最大ID 2^32−1とcounter=2^32のTreeFull、異なるroot/path、expiry日境界 |
| T04 | token | 偽mint/Token-2022/別ATA/別authority/凍結/不足/overflow拒否。資金とroot/statusが同時rollback |
| T05 | exits | 合意/escape/challenge/finalize/expiry/pause全遷移。deadline等号、historical root、N tombstone維持 |
| T06 | transactions | v1の制限、v0のbuffer全段階crash、封印後改変・同PDA別digest再作成への旧署名・第三者実行・再実行拒否、rent返却、blockhash再送 |
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

## 4. 実装担当へ渡す開始指示

> docs/implementation-ready.mdとspecs/、contracts/を読み、I01から実装する。最初にupstreamを固定commitで取得し、ライセンス・原テスト結果を残す。I02で実proofのSolana検証とtree更新CUを測るまで回路・hashを独自置換しない。USDCは固定mint、proxyを必須とし、金額は整数で扱う。失敗した推論を自動再実行しない。各タスクで意味のある正常系・異常系試験と証拠を保存し、G1〜G4の未検証項目を合格にしない。購入・provider契約・mainnet配備はこの開始指示に含まれない。

実装開始前のユーザーへの追加質問は必須ではない。provider credential、production鍵、program ID等は後続の環境設定で入力する。設計上の選択と、配備時の秘密・実測値を区別する。
