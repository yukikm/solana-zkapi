# Solana zkAPI

Ethereum zkAPIの現行機能を、Solanaで本番運用できる形に移植するプロジェクト。

基準ソース：`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。

**実装開始点：[実装開始仕様](docs/implementation-ready.md)**。命令・API・状態遷移・DB・運用・受入試験はこの仕様から参照する。[Production parity design](docs/production-parity.md)はEthereum版との対応表、[Ethereum reference](docs/ethereum-reference.json)は機械可読の参照情報。

利用者の最新方針に従い、Solana上のCircle発行USDCを入金・残高・精算・出金の基本資産にする。認可・精算・出金・復旧・SDK・ローカルクライアント・運用機能は本番運用を前提に設計する。SOLはネットワーク手数料・account作成費に使い、native SOLによるAPI料金決済は初期必須要件から外す。

OpenAI・Claudeの利用を優先し、Ollama互換は初期対象外。既存の直接接続方式と、第三者が既存APIを中継するproxy方式の両方を初回productionの必須機能とする。proxyはOpenAI Chat Completions/Responses、Anthropic Messagesに対応する設計。モデル対応、API互換、直接接続の可否は個別に確認する。

**I03 Anchor Vault完了、次はI04 buffer・SDK transaction・indexer**。全Vault命令、PDA/ATA/権限、USDC会計、永続nullifier、イベント、IDLを実装し、実SBF 366取引と固定Ethereum版の7シナリオを照合した。最大426,765 CU、863 bytes。[I03完了記録](docs/evidence/I03.md)を参照。元Poseidon・認可回路を維持し、[ADR-0002](docs/adr/0002-build-validated-signing-keys.md)で署名公開鍵をビルド時検証・役割別固定とした。I04全buffer lifecycle、G1全体、本番setup・配備は未完了。

開発開始：`git submodule update --init --recursive` → `python3 scripts/check_upstream.py` → `cargo test --locked --workspace`。TypeScriptは固定Node/npmで `npm ci --ignore-scripts && npm run typecheck && npm test`。Rust toolchainは `rust-toolchain.toml` に固定。

検証記録のartifact hash照合：`python3 scripts/check_evidence.py`。回路ソースとprofileの再現性：`python3 scripts/check_i02_reproducibility.py`。ファイル権限・mtime・作成順が異なる3条件で同じarchiveを確認する。baselineのremote CI成功とレビュー変更のローカル成功は証跡で区別し、push後にremote CIを確認する。

設計の構造チェック：`python3 scripts/check_design.py`。これはOpenAPI参照、document links、schemaとテストベクトルの整合性の確認であり、実proof検証やDB migration試験ではない。

追加の設計契約検証：`python3 work/design/generate_contracts.py --check`（生成物一致）、`python3 scripts/check_ledger_contract.py`（ローカルPostgreSQLの使い捨てDBだけでDDL/制約を確認）。後者はinitdb/pg_ctl/psqlが必要。runtimeのG1〜G4とは別の検証。

OpenAPIの追加検証は `python3 scripts/check_openapi_contract.py`。検証専用環境にopenapi-spec-validator==0.7.2が必要（今回のjsonschemaは4.26.0）。provider互換試験の代替ではない。
