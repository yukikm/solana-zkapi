# Solana zkAPI

Ethereum zkAPIの現行機能を、Solanaで本番運用できる形に移植するプロジェクト。

基準ソース：`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`。

**実装開始点：[実装開始仕様](docs/implementation-ready.md)**。命令・API・状態遷移・DB・運用・受入試験はこの仕様から参照する。[Production parity design](docs/production-parity.md)はEthereum版との対応表、[Ethereum reference](docs/ethereum-reference.json)は機械可読の参照情報。

利用者の最新方針に従い、Solana上のCircle発行USDCを入金・残高・精算・出金の基本資産にする。認可・精算・出金・復旧・SDK・ローカルクライアント・運用機能は本番運用を前提に設計する。SOLはネットワーク手数料・account作成費に使い、native SOLによるAPI料金決済は初期必須要件から外す。

OpenAI・Claudeの利用を優先し、Ollama互換は初期対象外。既存の直接接続方式と、第三者が既存APIを中継するproxy方式の両方を初回productionの必須機能とする。proxyはOpenAI Chat Completions/Responses、Anthropic Messagesに対応する設計。モデル対応、API互換、直接接続の可否は個別に確認する。

状態は**I01/I02実装中**。固定upstream、Rust/TS workspace・CI、binding/整数会計、実proofのnative互換性検証を追加した。結果と未完了項目は [I01 evidence](docs/evidence/I01.md)、[I02 evidence](docs/evidence/I02.md) を参照。Solanaプログラム、SBF/SVM/CU計測、本番デプロイは未実施。暗号/SVM・復旧・実provider・公開準備の4 gateを満たしてからリリースする。

開発開始：`git submodule update --init --recursive` → `python3 scripts/check_upstream.py` → `cargo test --locked --workspace`。TypeScriptは固定Node/npmで `npm ci --ignore-scripts && npm run typecheck && npm test`。Rust toolchainは `rust-toolchain.toml` に固定。

設計の構造チェック：`python3 scripts/check_design.py`。これはOpenAPI参照、document links、schemaとテストベクトルの整合性の確認であり、実proof検証やDB migration試験ではない。
