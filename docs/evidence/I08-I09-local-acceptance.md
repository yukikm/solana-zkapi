# I08/I09 local実装・受入

2026-10-04 JST。I08/I09で残っていた製品コードとlocal障害復旧を、既存SDK・ledger・signer・indexer・Vaultへ接続した。個別の実行結果と制限は[I08](I08.md)、[I09](I09.md)を正本とする。初期レビューは[I08-I09-review.md](I08-I09-review.md)に履歴として保持する。追加実装後の復旧・停止・管理API修正と再検証は[local受入後レビュー](I08-I09-local-review.md)を参照する。

## 実装の対応

| 開始契約 | 完成した経路 | 利用・復旧手順 |
|---|---|---|
| I08 A/B/C | manifest/artifact検証、暗号化note/session/transaction journal、quote/認可/receipt/後継検証、未知操作の照合 | [SDK](../../packages/sdk/README.md) |
| I08 D | 実WASM/native RP/WP/tree、Wallet Standard v0、finalized入金、clearance、合意出金/escape/finalize、stale再prove | [prover](../../apps/clientd/prover/README.md)、[SDK](../../packages/sdk/README.md) |
| I08 E/F | Go loopback API、単一SDK状態機械、権限分離、key reuse/close/SSE、passphrase custody、SOCKS5、全配布file hash pin | [clientd](../../apps/clientd/README.md) |
| I09 A/B | finalized RPC archive scan、SELECT-only証拠照合、native proof、送信前journal、v0送信/照会/復旧、期限監視 | [challenger](../../services/challenger/README.md) |
| I09 C/D/E | 専用dispatcher/fencing、DB/signer復旧、同期WAL failover、private admin、監視、KMS envelope/mTLS | [運用](../../deploy/operations/README.md)、[control](../../services/control/README.md) |

ブラウザとGoで別の認可・会計状態機械を作らず、challengerも財務ledgerの第二writerを作らない。元RP/WP/Poseidon、layout 2、proof_bound、mandatory v0_buffer、ADR-0002の役割別鍵、USDC整数会計を維持した。固定upstreamとlicenseは変更していない。Go relay移植とSolana向け差分は各READMEへ記録した。

## 再現順序

固定Rust/Node/npm/Go、SBF build tools、PostgreSQL、Chromeを用意する。CI定義も同じ順序を使う。

```sh
bash scripts/run_i04.sh
bash scripts/run_i06_i07.sh
python3 scripts/run_i08.py
python3 scripts/run_i09_challenger.py
python3 scripts/run_i08_wallet.py
python3 scripts/run_i08_clientd.py
python3 scripts/run_i09_operations.py
python3 scripts/check_upstream.py
python3 work/design/generate_contracts.py --check
python3 scripts/check_design.py
python3 scripts/check_evidence.py
git diff --check
```

`run_i06_i07.sh`はI05 trust/署名fixtureも生成する。I09 runnerが生成する認証済みtest tree PKをwallet runnerが使う。runtime reportの件数にはrunner間の重複があるため単純合算しない。`check_design.py`と`check_evidence.py`は設計・保存hashの検査であり、runtime合格の根拠ではない。

生成fixtureを共有するrunnerは上記の順に直列実行する。今回の最終再検証では、backendとwalletを並列にした一回だけ、`target/i05/public-manifest.json`の再生成中にwalletが読み込んでENOENTとなった。製品処理に到達する前のfixture競合であり、失敗ログを`target/i08-wallet-shared-fixture-interference*.log`へ保存し、backend終了後にwallet/clientdを直列で再実行した。最終runtime reportは成功した実行だけから生成し、この中断を成功件数へ含めない。

## 公開受入との境界

実行したのは実暗号、実WASM/Chrome、実Go/Node/Rust process、実PostgreSQL/WAL、実mTLS、実Solana署名と実Vault SBFである。provider HTTP、chain finality/RPC、KMS helperはlocal fixtureを含む。各報告でこの違いを明記する。

以下は引き続き未検証であり、I10への完了引継ぎやG1〜G4の合格を記録しない。

- 実provider credentialによる推論・キー失効・請求照合、実walletアプリ、公開RPC/clusterの全機能E2E・負荷/継続障害試験。
- 実Tor、他OS、端末の電源断/全browser crash、production署名配布。
- production cloud KMS、OS/ネットワーク基盤によるegress隔離、別障害domainのfailover、運用通知の外部配送と実SLO。
- production setup/鍵/multisig、第三者review、hosted CI実行、公開manifestとG1〜G4。

既知entropyのtest setup、test signing keys、合成USDC mintをproductionへ使わない。不明な財務execute/finalizeは照会・同一bytes復旧を維持し、推論を黙って再実行したりdirectからproxyへ切り替えたりしない。
