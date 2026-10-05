# OA鍵のクライアント検証 — 2026-10-05

対象は `work@785fad8c49af97fef063cacd72ee40f33a56709d` に対する修正。
結果は **fixed（下記のlocal検証範囲）**。実OAサービス、公開devnet、SBFの再受入を意味しない。

## 問題と修正

従来は `services/control/src/direct/oa.rs` が発行鍵を検証しても、初回HTTP応答が検証証拠を捨てていた。
SDKの `ControlClient.accept` はinference baseの一致だけでOA鍵を返却・保存し、
保存済み鍵も `sendDirectOperation` から独立検証なしで使えた。
悪意あるcontrol serverによる未検証鍵の差し替えをクライアント自身で拒否できない境界だった。

- 初回OA鍵配信に既存の署名証拠 `provider_key_verification` を添える。サーバー検証は維持し、GET・再送では鍵も証拠も返さない。
- SDKは独立設定 `oaVerifier: { base, stationId }`、provider base、署名形式、有効期限を確認し、固定した `/submit_key` に実際の鍵と証拠をPOSTする。`verified` 成功まで鍵を返却・保存しない。
- 検証要求にcontrol token・note識別子・promptを含めない。応答内URLによる送信先選択、redirect、credential転送を許可しない。
- 暗号化journalには証拠を保存する。信頼結果は同一client instance内で正確な鍵・証拠・期限・設定に結合してcacheし、再起動後の初回利用では再検証する。
- 証拠がない旧OA鍵、検証拒否、通信失敗、期限切れでは鍵を破棄してclosingを先に永続化する。同じsessionをclose・精算し、推論再送・鍵の再発行・proxyへの変更を行わない。verifierが利用不能でもclose・署名後継の検証は可能。
- clientdとdevnet実行クライアントの両生成箇所へ独立設定を渡す。devnet transportは固定verifierのPOSTだけを通常のTLS検証で許可する。

Ethereumの固定参照 `045b444ea1b52538d1b40273c7cb6ed09468a052` の独立verifier確認に沿う。
既存Solana issuer adapterの最大65秒の期限差許容を維持する。回路や支払い認可のwireは変更していない。

## レビューと互換性

実装前に独立したread-only調査、実装後に履歴を渡さないread-only差分レビューを実施した。
差分レビューは1件の具体的な互換性問題を指摘した。
provider期限から残りTTLを計算してからDB・チェーン確認が遅れると、DBの有効化時刻＋古いTTLが署名済みprovider期限を超えていた。

`resolve_direct_key` に絶対provider期限を渡し、同一DB時刻で有効性を判定するよう修正した。
保存する期限は `min(DB時刻 + TTL, provider期限)` とし、既に期限切れならDRAININGとする。
1.1秒の最終確認遅延を入れたPostgreSQLテストで、正常鍵の期限上限と期限切れ鍵の非有効化を確認した。
変更後の全呼び出し元とSQLを親担当が確認し、関連回帰を再実行した。レビューで挙がった指摘に未対応項目はない。

OAのserver・SDK/clientdは同時に更新する。旧SDKは追加応答fieldを拒否し、新SDKは証拠のない旧serverのOA鍵を拒否する。
GET・close・精算の既存形式は継続し、OpenRouter/proxyの正常系も関連テストで維持を確認した。

## 検証

Node 24.19.0、npm 11.9.0、Rust 1.90.0、独立した使い捨てPostgreSQL 16を使用。
OA発行・verifier・推論とRPCはlocal fixture。新OA HTTP試験のPoolConfigは明示的な合成fixtureで、実request proof・既存chain account検証・PostgreSQLを通す。
既存SBF試験の `target/i05/chain.json` は置換・生成していない。

1. **構文・型・静的検査：成功**
   - `npm run typecheck`
   - `node node_modules/typescript/bin/tsc --noEmit -p apps/clientd/tsconfig.json`
   - `cargo test --locked --manifest-path services/control/Cargo.toml --no-run`
   - `cargo fmt --manifest-path services/control/Cargo.toml -- --check`
   - `cargo clippy --locked --manifest-path services/control/Cargo.toml --all-targets -- -D warnings`
   - `git diff --check`
2. **元の問題と別の不正入力：成功**
   - base commitのSDKを一時コピーで実行すると、追加した「OA key without independently verifiable evidence」テストは `unattested-key` の返却で失敗し、既存OpenRouter正常系は成功した。
   - 修正後は同じOAテストが成功。URL差し替え、別station、欠落/不正署名、重複JSON field、期限形式/上限、検証中の期限切れ、HTTP失敗、timeout、保存鍵/証拠/期限の変更も拒否した。
3. **正常系・関連回帰：成功、159 tests、失敗/skip 0**
   - 次のJavaScript試験140件を実行：

     ```sh
     node --test packages/sdk/test/control.test.ts packages/sdk/test/clientd.test.ts \
       packages/sdk/test/journal.test.ts packages/sdk/test/journal-browser.test.ts \
       packages/sdk/test/wallet-clearance.test.ts packages/sdk/test/wallet-recovery.test.ts \
       packages/sdk/test/trust.test.ts scripts/i10_devnet_provider_config.test.ts \
       scripts/i10_devnet_transport.test.ts
     ```

     browser journalは実Chromiumで確認した。このcontainerではChromium起動用の一時wrapperに `--no-sandbox --disable-dev-shm-usage` が必要だった。製品コードのbrowser保護設定は変更していない。
   - Rust direct adapter 12件・ledger 5件：

     ```sh
     cargo test --locked --manifest-path services/control/Cargo.toml \
       --test direct_adapters --test ledger_runtime -- \
       --include-ignored --nocapture --test-threads=1
     ```

   - OA初回HTTP配信・server verifier拒否の2件：

     ```sh
     cargo test --locked --manifest-path services/control/Cargo.toml \
       --test provider_http_runtime oa_http_ -- --ignored --nocapture --test-threads=1
     ```

   - Rust試験には使い捨てDBの `ZKAPI_TEST_DATABASE_URL` と `RAYON_NUM_THREADS=4` を設定。
4. **契約・参照元：成功**
   - `python3 work/design/generate_contracts.py --check`
   - `python3 scripts/check_design.py`
   - `python3 scripts/check_upstream.py`
   - `docs/contracts/ledger.sql` と `scripts/ledger_contract_checks.sql` を別の使い捨てDBに `psql -v ON_ERROR_STOP=1` で適用し、18件の拒否条件と正常精算/receipt/clearanceを確認。

## 実行しなかった範囲・環境履歴

初回の `npm test` は168件中160件成功、8件が未配置のfixtureで失敗した。
うち3件の上流PK/VK欠落はsubmodule導入後、上記trust回帰で解消を確認した。
残る5件は未変更のwallet-chain試験で、I05 public manifest/SBF exportと後続wallet生成artifactを必要とする。
今回のOA境界に関する試験ではないため、全SBF・wallet生成工程は再実行していない。全SDK一括回帰の成功とは記録しない。
`check_ledger_contract.py` はhostのinitdb欠落で停止したため、同じSQLを使い捨てPostgreSQL containerで実行して成功した。

実OAの署名サービス/CORS・実Tor・Chrome拡張wallet・公開provider/devnetの再受入、本番setup・監査は今回の検証対象外。
既存I10の実受入結果や未完了gateを書き換えない。
