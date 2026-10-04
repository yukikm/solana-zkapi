# I06/I07 実装引き継ぎ

2026-10-04 JST。I06 direct / I07 proxyのlocal実装・検証を完了した。
実行結果は[I06](evidence/I06.md)、[I07](evidence/I07.md)、
[統合結果](evidence/I06-I07-results.json)を正本とする。
2026-10-04のレビューで7件を修正し、59テスト・実Vault SBF 10取引を再検証した。I08/I09のlocal実装着手Readyとする（実provider/公開gate合格ではない）。
次はI08 SDK/WASM・clientd、I09 challenger・運用である。具体的な着手順序・接続先・受入条件は[I08/I09実装開始契約](i08-i09-implementation-ready.md)を読む。

## 再利用する実装

`services/control/src/direct/`はOA-orgとOpenRouterのキー発行・停止・最終usage・削除・未知発行回収。
`services/control/src/proxy/`はOpenAI Chat/Responses、Anthropic Messages/count_tokens、OpenRouter ChatとSSE。
`inference.rs`が既存Ledgerの予約→immutable attempt→最終claim→一回のHTTP送信を接続する。
`provider_runtime.rs`が整数課金・署名receipt・direct復旧・proxy unknown waiverを接続する。
設定と対応範囲は[PROVIDERS.md](../services/control/PROVIDERS.md)を参照。

I05のmigration・writer接続・signer journal、実Vault、generated IDL、I04 transport/indexer、
元回路/Poseidon、ADR-0001/0002は再実装・置換していない。
DB schemaはversion 2を維持し、direct checkpointは既存outboxに型検査したimmutable snapshotとして追記する。
checkpointの最終usageをDELETEより先にcommitし、発行・削除応答が失われても同じ管理参照で復旧する。

## クライアントへ引き継ぐ契約

- directの`provider_key`は最初の応答だけ。再送・GETで返さない。初回応答のbody破棄・deadlineではcloseを保存する。完全なclient到達はHTTP serverだけでは証明できないため、key欠落時はcontrol tokenでclose/recoverする。
- proxyは利用者生成の`zkp1`とUUIDv4 Idempotency-Keyを使う。再送409はstatus URLへ進む。本文を復元するAPIも暗黙の新ID実行もない。modeを自動変更しない。
- proxyの入力・出力は一時メモリーのみ。ledgerへ本文・生credentialを渡さない。SSEの終端usageまでdrainし、遅いconsumerは短い送信猶予後に切り離す。
- quoteで固定した整数料金表と、署名receiptのusage・nano額をSDKで再計算する。micro切上げはsession精算時に一回だけ。
- OA verifierに成功した鍵だけを返す。OA署名receiptは固定upstreamと同じ構造・lease結合検証であり、独立した署名再検証を実証したとは扱わない。
- OpenRouter final usageのgrace＋二回安定観測は運用上の判定。外部請求の最終性証明ではない。実providerとの照合・確定時間はG3で検証する。

## 運用へ引き継ぐ制限

local runtimeはcontrolとprovider dispatchを同processに置き、既存の単一writerを通す。
本番の別process/host配置、provider credentialの専用dispatcher限定、egress ACL・独立fencing、
KMS/mTLS、同期replica/failover・監視はI09/I10で接続する。別ledgerを作ってはいけない。
旧epochの未終了attemptがあると新規受付と署名を保留する。timeoutや再起動だけでfenceしない。新writerが旧epochのattemptを`finish_attempt`することも拒否し、独立停止証拠のあるfencingを要求する。
proxy unknownはowner終了/fence確認後のdrain時だけ0課金に固定し、directに自動適用しない。

モデル名・context上限・cache区分・料金表は明示profileでpinする。現在のfixtureは合成で、実providerの応答記録ではない。
現行のloopback・test-only setupの起動制約を本番公開のためだけに外さない。
実provider、公開wallet/RPC、hosted CI、production setup・監査、G1〜G4は未合格。

## 再現

```sh
bash scripts/run_i06_i07.sh
python3 scripts/check_upstream.py
python3 work/design/generate_contracts.py --check
python3 scripts/check_evidence.py
```

一括suiteは使い捨てPostgreSQL、provider HTTP fixture、実request proof、別process signer、実Vault SBF回帰を実行する。
既存DB・実provider credentialを使わない。`check_design.py`だけでruntime合格とはしない。
