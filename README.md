# Solana zkAPI

2026-10-05 03:57 UTC（12:57 JST）更新：**OpenRouter proxy Chat toolsの実受入1caseが成功**。[HTTP 200・推論送信1回/再送0・`PROXY_USAGE`・18 micro-USDC請求・署名後継検証](docs/evidence/I10-openrouter-tools-case-results.json)を確認し、[10,000,000 micro-USDCのdevnet入金→利用→mutual close](docs/evidence/I10-openrouter-tools-runtime-results.json)も9 finalized取引・最大360,266 CU/1,232 bytesで完了した。wallet所有者がtreasury所有者を兼ねるため最終wallet 38,010,000/Vault 0となるが、明細の18 micro-USDC請求は別に検証した。[共通予算](docs/evidence/I10-openrouter-tools-acceptance-results.json)は3case計57,831 micro-USDC予約・残り9,942,169。SSEはquote段階の失敗で未予約のまま。**全I10/G3と実Chrome＋Phantomは未完了**。

2026-10-05 JST、それまでの経緯：provider総額上限 **10 USDC** と **Chrome＋Phantom** は承認済み。[OpenAIモデル読取](docs/evidence/I10-openai-model-access-node-results.json)と[OpenRouter通常キー読取](docs/evidence/I10-openrouter-key-access-results.json)は認証HTTP 200を確認した。管理キー権限や実推論成功を示す結果ではない。最初の[OpenAI Responses試行](docs/evidence/I10-openai-native-auth-initial-failure-results.json)は推論前のAUTHが不明となり、19,277 micro-USDCの試験予約を保持した。同じjournalの署名clearance→mutual closeで[10,000,000 micro-USDCのdevnet入金を全額回収](docs/evidence/I10-openai-native-auth-recovery-results.json)した（9 finalized取引、最大338,395 CU/1,232 bytes、再送0）。OpenRouter plainは[実生成metadata](docs/evidence/I10-openrouter-generation-usage-results.json)でnative入力14・出力2 token、実費0.0000033 USDを確認したが、計量受入は失敗し、署名済み`UNKNOWN_OPERATOR_LOSS`の利用者請求0と19,277 micro-USDC予約を維持した。原因は未確定で、推論再送・遡及課金はない。[通常SDK mutual close](docs/evidence/I10-openrouter-native-withdrawal-results.json)で10,000,000 micro-USDCを全額回収した（9 finalized取引、最大355,063 CU/1,232 bytes、wallet 38,010,000・Vault 0）。これはprovider受入成功ではない。OpenRouter SSEは[quote 503](docs/evidence/I10-openrouter-sse-quote-failure-results.json)で予算予約・AUTH・推論より前に停止し、未予約のまま[全額回収](docs/evidence/I10-openrouter-sse-withdrawal-results.json)した（9 finalized取引、最大338,227 CU/1,232 bytes、wallet 38,010,000・Vault 0）。SSE回収時点の共通予算予約は既存2caseの38,554 micro-USDCだった。Chromeは2026-10-05 03:25 UTCにも[`ERR_BLOCKED_BY_CLIENT`](docs/evidence/I10-chrome-current-block-results.json)を再確認した。**I10全体、G3、実Phantom受入は未完了**。

[SDK回復55件](docs/evidence/I10-sdk-unaccepted-auth-race-results.json)、[UI local 39件](docs/evidence/I10-wallet-ui-provider-local-results.json)、[表示改善後12件](docs/evidence/I10-wallet-ui-provider-phase-results.json)は各source時点のoffline検証であり、合成proof/providerやWallet Standard fixtureを含む。実Phantom・実provider受入へ読み替えない。[18ケースの準備手順](docs/provider-acceptance.md)の最大予約合計3.833884 USDCと、全profile共通の不変予算を維持する。[7段階回帰498.224秒](docs/evidence/I10-provider-wallet-local-regression-results.json)は後続の選択profile・UI・AUTH回復変更前の履歴で、当時のsource409項目/I04入力不変とreport hash一致を保存した。

Ethereum zkAPIの現行機能を、Solanaで本番運用できる形に移植するプロジェクト。

基準ソース：`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。

**実装開始点：[実装開始仕様](docs/implementation-ready.md)**。命令・API・状態遷移・DB・運用・受入試験はこの仕様から参照する。[Production parity design](docs/production-parity.md)はEthereum版との対応表、[Ethereum reference](docs/ethereum-reference.json)は機械可読の参照情報。

利用者の最新方針に従い、Solana上のCircle発行USDCを入金・残高・精算・出金の基本資産にする。認可・精算・出金・復旧・SDK・ローカルクライアント・運用機能は本番運用を前提に設計する。SOLはネットワーク手数料・account作成費に使い、native SOLによるAPI料金決済は初期必須要件から外す。

OpenAI・Claudeの利用を優先し、Ollama互換は初期対象外。既存の直接接続方式と、第三者が既存APIを中継するproxy方式の両方を初回productionの必須機能とする。proxyはOpenAI Chat Completions/Responses、Anthropic Messagesに対応する設計。モデル対応、API互換、直接接続の可否は個別に確認する。

**I01〜I09のlocal実装・受入を基盤に、I10の統合・負荷・障害試験を拡張**。[I08/I09のlocal受入](docs/evidence/I08-I09-local-acceptance.md)と[レビュー修正](docs/evidence/I08-I09-local-review.md)を再利用し、5 mode/provider・28 API case・同じnoteの実Vault退出競合・反復faultを検証する。提供されたtest keypairと公開devnetでは専用Vaultの実配備・Pool初期化・管理3命令と、1,000,000 micro-USDCの入金→escape→finalizeを確認した。10取引finalized、最大343,021 CU/1,232 bytes、入金ACK喪失後のfresh process復旧・再送0とwallet/Vault残高の復元を[I10 devnet結果](docs/evidence/I10-devnet-wallet-escape-results.json)に保存した。[I10記録](docs/evidence/I10.md)、[要件対応表](docs/i10-local-coverage.md)、[外部受入の準備](docs/i10-acceptance.md)を参照。別の[mutual close受入](docs/evidence/I10-devnet-wallet-mutual-results.json)も実control/PG/signerdのclearance署名を経て9取引finalized、最大347,571 CU/1,232 bytes、残高復元に成功した。native daemon challengeの最新成功は次段落に記録する。実provider・wallet UI・hosted CI・G1〜G4全体の受入は未完了。devnet差分後の[journal batching前の一括回帰](docs/evidence/I10-devnet-local-regression-results.json)は7段階すべて成功、438.686秒（後続journal batching差分は別検証）。devnet差分前458.202秒、I04回帰25.972秒（前回41.984秒）、各差分試験とtoolchain設定失敗を別source/hashで保持する。

2026-10-05 JST更新：新しいchallenge-liveで受理済AUTH・zero-use精算→stale SDK escape→独立native daemon challenge→検証済後継のmutual closeが成功した。[wallet report](docs/evidence/I10-devnet-challenge-wallet-results.json)は14finalized取引・最大353,022CU/1,232bytes・入金1,000,000micro-USDCの残高復元とexact-signature再送0、[native collector](docs/evidence/I10-devnet-native-challenge-results.json)は別の5finalized取引・最大323,571CU/1,232bytesと正確なAUTH/payload/event/root結合を確認した。native再送回数は未計測で、検出から初execute送信まで173秒は単一jobの観測。停止は強制cleanup後clean_shutdown=falseを保持し、[同journal再読込](docs/evidence/I10-devnet-challenge-restart-results.json)の成功をgraceful停止に読み替えない。先のchallenge-batched失敗と[資金回収](docs/evidence/I10-devnet-uncertain-auth-recovery-results.json)は別履歴として保持する。実provider/G3とwallet UIの受入が残り、I10全体は未完了。追加provider/Phantom/停止修正前の[7段階local回帰](docs/evidence/I10-final-local-regression-results.json)は399.016秒ですべて成功し、source/I04入力の不変を確認した。component別結果は`I10-final-local-components/`へ保存。438.686秒はjournal batching/回収helper追加前、458.202秒はdevnet差分前の履歴として保持する。

I04のbuffer全5操作、SDK署名v0、finalized indexerとsnapshot・復旧は再利用する。I04の実SBFのbuffer 161取引・SDK統合53取引・既存I03回帰366取引、最大426,830 CU / 1,232 bytesは[I04完了記録](docs/evidence/I04.md)に保持する。元回路・Poseidon・固定profileを維持。[I05実装契約](docs/i05-implementation-ready.md)と[controlの実行手順](services/control/README.md)を参照し、I05 runtime検証は `bash scripts/run_i05.sh` で再現する。

開発開始：`git submodule update --init --recursive` → `python3 scripts/check_upstream.py` → `cargo test --locked --workspace`。TypeScriptは固定Node/npmで `npm ci --ignore-scripts && npm run typecheck && npm test`。Rust toolchainは `rust-toolchain.toml` に固定。

検証記録のartifact hash照合：`python3 scripts/check_evidence.py`。回路ソースとprofileの再現性：`python3 scripts/check_i02_reproducibility.py`。ファイル権限・mtime・作成順が異なる3条件で同じarchiveを確認する。baselineのremote CI成功とレビュー変更のローカル成功は証跡で区別し、push後にremote CIを確認する。

設計の構造チェック：`python3 scripts/check_design.py`。これはOpenAPI参照、document links、schemaとテストベクトルの整合性の確認であり、実proof検証やDB migration試験ではない。

追加の設計契約検証：`python3 work/design/generate_contracts.py --check`（生成物一致）、`python3 scripts/check_ledger_contract.py`（ローカルPostgreSQLの使い捨てDBだけでDDL/制約を確認）。後者はinitdb/pg_ctl/psqlが必要。runtimeのG1〜G4とは別の検証。

OpenAPIの追加検証は `python3 scripts/check_openapi_contract.py`。検証専用環境にopenapi-spec-validator==0.7.2が必要（今回のjsonschemaは4.26.0）。provider互換試験の代替ではない。
