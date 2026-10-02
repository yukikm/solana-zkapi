# 運用・復旧・公開条件

## 1. 配備単位

初回は1 deployment / 1 USDC pool / 1認可writer。proxy frontendは水平拡張できるが、operation受付・予算予約・署名対象決定は単一writerとprimary PostgreSQLで直列化する。indexer/challenger/proxy/signerは別process。Redis等を残高・nullifierの正本にしない。

DBは同期replicaを別障害区画へ置き、認可・clearance・DISPATCHING・署名対象のcommitは同期replicaへの永続化後にackする。primaryだけにackしてRPO=0を名乗らない。promote時は旧writerと旧primaryを停止・fenceしてから新writerを起動。split brain試験を必須にする。

公開設定manifestはdeployment ID、Solana genesis/program/pool/mint/token program、keys、VK/PK hash、回路ID、tree backend、IDL hash、quote key、HTTPS origins、API対応表、料金表hash、TTL/cap、binary/image digest、DB schema versionを持つ。manifest_hashはmanifest_hashとmanifest_signatureを除いたJCS objectのSHA256、署名はそのraw32 bytesに対する配布用Ed25519署名。clientは配布物にpinされた鍵または信頼済みmanifest hashから起動し、manifest自身の公開鍵だけを信頼の根拠にしない。サーバーが返す別のpoolや鍵を自動承認しない。各provider credentialはsecret managerの参照名だけを配備設定に置く。

## 2. セキュリティ境界

| 事象 | 必須の対策・保証の範囲 |
|---|---|
| 同じnoteを複数sessionで使う | pool/N unique、clearanceとの同一ロック、on-chain exit tombstone、challenger |
| 予算超過・parallel racing | session row lock、最大額予約、整数会計、cap越え運営負担 |
| proof/quote/cross-pool replay | deployment/asset/mode/request ID/credential binding、canonical parser |
| token漏えい | 短期・用途分離、ログredaction、失効、TLS。侵害期間内の利用は完全に防げるとしない |
| signer compromise | 隔離service、鍵の用途分離、署名対象を永続的に一意化、pool移行。既存鍵を同poolで黙って交換しない |
| proxyの虚偽usage | 計算根拠公開・監査。ZKによる実usage保証とはしない |
| 上流の不正/遅延請求 | receiptの証拠区分、最終性確認、cap超過吸収、proxy unknown waiver |
| IP/本文/時刻の相関 | 本文を保存しない、Tor対応、限界を表示。完全匿名とはしない |
| USDC凍結・相場乖離 | 固定mint検査、運営負担条件、転送失敗時rollback。プロトコルで発行体権限を消せない |
| 悪意あるserverの署名保留 | 元escape/challenge条件を継承。無条件退出保証と説明しない |
| 期限切れ | expiry前の明示・警告・出金導線。元仕様ではActive元本全額がtreasuryへ移る |

Baby-JubJub署名は一般のEd25519用KMS signing APIに差し替えない。初版はisolated Rust signerを使い、鍵seedをKMS envelope encryptionで保管し、起動時に限定メモリーへ展開する。swap/core dump/debug endpointを無効化し、RPCは相互TLS、署名要求はprimary ledgerから再照合する。state/clearance/quote/program admin/provider keyは別の鍵。

program upgrade authorityとadminは別の2-of-3 multisigで運用する。実装時に選定したmultisigのprogram IDと構成をmanifestへ固定。任意upgradeが可能である信頼条件を利用者に表示する。既存poolのimmutable鍵/VKをupgradeで差し替える運用は禁止し、新poolへ移行する。

## 3. Finalityとchallenge

入金認可と通常rootはfinalizedのみ。新規認可時のexitチェックは独立2 RPCのconfirmed状態も参照し、片方でもtombstone/Pendingを観測すれば新規キー・proxy利用を止める。2 RPCが同じbackendを使っていないことを設定で管理。RPCのcontext slotが最新finalized slotより遅い応答を採用しない。RPCエラー・slot不一致を「未使用」と解釈しない。

checkとoff-chain発行はchainと原子的にはできない。この競合は保存済みrequest proofとchallengeで処理する。challengerはconfirmedで早期準備し、finalized状態でcanonical evidenceとcurrent zero pathを検証して送る。deadlineの残りに応じて再送・priority feeを上げる。24時間challengeに対し5分以内の検出・送信を運用目標とし、遅延60秒で警告、5分で当番通知、deadline残り1時間で緊急扱い。

checkpointはslot、blockhash、transaction signature、instruction index、tree sequence。indexerはarchive RPCから再走査可能。rootをsequence順に再構築し、program TreeStateと照合する。provider receiptはrequest transcriptと結合し、challengeに必要なRP/proofを精算後も保持する。

## 4. 保存期間・復旧

秘密note・wallet seed・prompt/response・生tokenはサーバーログ/DB/backupに保存しない。request transcript（proof/public inputs/quote/credential hash）とCLEARANCE予約、署名journal、N tombstoneはpool稼働中保持する。匿名requestから個別noteの終了を判定できないため、単にTTL経過で削除しない。全noteがClosedで、pool受付が永久停止し、challengeが終了したことをchainで確認した後にだけ、定めたretentionに従って削除する。

raw IPはアクセスログに残さず、rate limit用salted keyは24時間で廃棄。provider error本文の無制限保存は禁止。監査ログは状態遷移・deployment・request/operation ID・額・hashを中心にし、権限を限定する。tracingへHTTP bodyやAuthorizationを自動収集しない。

| 障害 | 復旧手順 |
|---|---|
| client応答喪失 | 同じrequest ID/secret/proofで照会。同じNで別認可を作らない |
| direct発行timeout | ISSUANCE_UNKNOWNを保存。キー存在/usageを照会し、失効・精算。新規キー再発行しない |
| proxy送信後crash | DISPATCHINGをUNKNOWNへ。再dispatchなし。usage照会または900秒後運営損失 |
| 署名後DB応答喪失 | signer journalの同一messageを照合・再取得。charge/anchorを再計算しない |
| DB failover | 旧primary/writerをfence、同期済みLSNを確認、未精算状態とsigner journal照合後再開 |
| snapshotからの災害復旧 | WALを最後のackまで再生。ack済み予約を復元できない場合は新規認可を再開しない。chainだけでオフチェーンNは復元できない |
| root競合・blockhash期限 | chain結果を先に照会。未成立ならcurrent root/path/proofで再作成。depositはnext IDも照合 |
| RPC/indexer不一致 | 新規認可/path配信停止、別RPCで再構築。確実なPending finalize/challengeを優先 |
| provider障害 | 該当provider新規認可停止。既存精算・出金・他providerは継続 |
| USDC transfer失敗 | chain状態はrollback。token accountの状態を確認し、同じ宛先/証明条件で再試行 |

暗号化snapshotを毎日、WALを継続保存。月1回、隔離環境でrestoreしnullifier件数・予約・署名journal・未精算operationを照合する。RPOはack済み認可/課金予約に対して0、RTOの初期目標は1時間。実測で満たせなければ達成済みSLOと公表しない。

## 5. Setupとビルド

移植試験は元のsingle-party setupを使って回路互換性を切り分ける。新しいproduction poolでは、採用したrequest/withdrawal（必要ならtree-transition）回路について、レビュー済みのGroth16 setup/contribution手順と公開transcript検証をrelease条件にする。運営者以外を含む複数の独立参加者を想定し、少なくとも1参加者が秘密を破棄したという信頼仮定を明記する。単発のローカルsetupをproduction ceremony完了として扱わない。既存artifactをそのまま採用する変更には、その信頼モデルを別ADRで明示する。

toolchain、Anchor、Agave、groth16-solana、TypeScript SDKはI01/I02で実際に解決・buildしたexact version/commitをlockする。Arkworksはupstream lockを基準に0.5系列を維持する。v1対応に必要なSolana/SDK versionを公式matrixで確認し、SBF側依存とRPC側依存は別crateに隔離する。「latest」の可変tagでCI/production buildしない。

全配布物にhashと署名、SBOM、license、upstream commit、circuit/VK/PK manifestを含める。ブラウザproving keyは取得後hash照合。CIはnative/wasm/SBFで同じtest vectorを検証する。

## 6. Release gate

| Gate | 合格条件 | 現在 |
|---|---|---|
| G1 暗号・SVM | 元実proof、12/14 public inputsの各改変拒否、H2F/Poseidon一致、worst CU/bytes、wallet/buffer経路 | 未実施 |
| G2 会計・復旧 | 並列予算予約、全crash point、client復旧、出金競合、DB failoverで二重署名/課金なし | 未実施 |
| G3 実provider | OA-org、OpenRouter direct、OpenAI/Anthropic/OpenRouter proxyの実credential・usage・streaming試験 | 未実施 |
| G4 公開準備 | setup検証、鍵/multisig、第三者review/audit、restore演習、監視当番、正しいmanifest | 未実施 |

devnet/localでG1/G2を先に満たす。実provider試験は利用料金を発生させるので、実装段階で利用可能なtest account/予算を設定する。現時点では契約・購入・mainnet署名を行わない。OA-org credential等が得られない場合、その経路をmockで合格にせずG3未合格として明記する。

監視必須項目：root/slot lag、challenge残り時間、認可/出金失敗率、nullifier conflict、cap超過吸収額、usage unknown率、session精算待ち時間、USDC escrow不変条件、signer重複message拒否、DB replica lag、SOL fee残高。pool全停止とprovider新規受付停止を別操作にする。

## 7. 一次資料

- [固定Vault](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/contracts/src/ZkApiVault.sol)
- [固定Arkworks回路](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/rust/crates/zkapi-proof/src/groth16.rs)
- [元setup説明](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/setup/v2/README.md)
- [Solana v1](https://solana.com/upgrades/larger-transaction-sizes)、[Token転送](https://solana.com/docs/tokens/basics/transfer-tokens)
- [Circle mint一覧](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Light Protocol verifier](https://github.com/Lightprotocol/groth16-solana)
- [OpenAI Chat API](https://developers.openai.com/api/reference/resources/chat)、[Responses API](https://developers.openai.com/api/reference/resources/responses)
- [Claude API](https://platform.claude.com/docs/en/api/overview)、[SSE](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [OpenRouter key管理](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)

外部APIのschema/pricingは実装時に再取得してsnapshotを残す。本仕様は対応機能と失敗時の契約を固定するもので、providerの全API schemaを複製していない。
