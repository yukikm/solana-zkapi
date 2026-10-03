# Solana zkAPI

Ethereum zkAPIの現行機能を、Solanaで本番運用できる形に移植するプロジェクト。

基準ソース：`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。

**実装開始点：[実装開始仕様](docs/implementation-ready.md)**。命令・API・状態遷移・DB・運用・受入試験はこの仕様から参照する。[Production parity design](docs/production-parity.md)はEthereum版との対応表、[Ethereum reference](docs/ethereum-reference.json)は機械可読の参照情報。

利用者の最新方針に従い、Solana上のCircle発行USDCを入金・残高・精算・出金の基本資産にする。認可・精算・出金・復旧・SDK・ローカルクライアント・運用機能は本番運用を前提に設計する。SOLはネットワーク手数料・account作成費に使い、native SOLによるAPI料金決済は初期必須要件から外す。

OpenAI・Claudeの利用を優先し、Ollama互換は初期対象外。既存の直接接続方式と、第三者が既存APIを中継するproxy方式の両方を初回productionの必須機能とする。proxyはOpenAI Chat Completions/Responses、Anthropic Messagesに対応する設計。モデル対応、API互換、直接接続の可否は個別に確認する。

**I02完了、I03 Vault実装へ着手Ready**。採用したlayout 2 / tree証明方式を実装し、実SBFの257ケース、実証明同士のbinding、Token CPI失敗rollbackを検証した。5経路は約15〜32万CUで100万CU以内。[I02-B完了記録](docs/evidence/I02B.md)と[実測結果](docs/evidence/I02B-summary.json)を参照。元Poseidon・認可回路を維持し、全Vault/I04 buffer lifecycleのG1、本番setup・配備は後続で確認する。

開発開始：`git submodule update --init --recursive` → `python3 scripts/check_upstream.py` → `cargo test --locked --workspace`。TypeScriptは固定Node/npmで `npm ci --ignore-scripts && npm run typecheck && npm test`。Rust toolchainは `rust-toolchain.toml` に固定。

検証記録のartifact hash照合：`python3 scripts/check_evidence.py`。baselineのremote CI成功とレビュー変更のローカル成功は証跡で区別している。レビュー変更・追加contracts jobはpush後にremote CIを再確認する。

設計の構造チェック：`python3 scripts/check_design.py`。これはOpenAPI参照、document links、schemaとテストベクトルの整合性の確認であり、実proof検証やDB migration試験ではない。

追加の設計契約検証：`python3 work/design/generate_contracts.py --check`（生成物一致）、`python3 scripts/check_ledger_contract.py`（ローカルPostgreSQLの使い捨てDBだけでDDL/制約を確認）。後者はinitdb/pg_ctl/psqlが必要。runtimeのG1〜G4とは別の検証。

OpenAPIの追加検証は `python3 scripts/check_openapi_contract.py`。検証専用環境にopenapi-spec-validator==0.7.2が必要（今回のjsonschemaは4.26.0）。provider互換試験の代替ではない。
