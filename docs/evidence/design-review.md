# 設計レビュー記録

後続レビュー：[2026-10-03の指摘・修正・検証](design-review-2026-10-03.md)。以下は作成時点の記録であり、現在の検証結果は後続レビューを参照。

日付：2026-10-02 JST。対象：[実装開始仕様](../implementation-ready.md)。設計者自身による整合性確認であり、独立した暗号監査・実装監査ではない。

## 確認したもの

- 固定upstreamのVault命令、request 12/withdrawal 14 public inputs、Poseidonドメイン、proof wireの実装、clearance wire、Arkworks依存。
- 最新ユーザー要件を「USDC必須・directとproxy両方必須・Ollama初期対象外」として全資料へ反映。
- PDA/USDC authority、destination owner→ATA、原子的なtree/資金更新、nullifier tombstone。
- quote/認可/credentialのbinding、同一再送、未知の発行、stream切断、予算予約、署名一意性。
- 初期対応API、意図した互換subset、provider-specific usage証拠と料金計測の限界。

## レビュー中に修正した不整合

1. proxyを追加候補としていた古い記述を必須へ変更し、P32〜P36とI07へ割り当てた。
2. SQLite候補の記述をPostgreSQL＋fenced single-writerへ統一した。
3. 上流direct keyにないmodel制限を仮定しないよう、directのquoteをprovider-wideにした。
4. micro-USDCのcapとnano-USDCの内部累積を明示的に1000倍で比較するよう固定した。
5. tree fallback回路にtransition_tagを加え、vault bindingを未拘束public inputにしない仕様にした。
6. ISSUING中のcloseを永続的なclose_requestedで処理する遷移を追加した。
7. immutable settlement rowとsigner journalで、crash後に異なるcharge/anchorを署名しない契約にした。
8. pool初期化にdeployment authorityを要求し、第三者の先回り初期化を防ぐ仕様にした。

## 実施した構造確認

`python3 scripts/check_design.py` でJSON構文/重複key、OpenAPI内部参照・認証scheme・path parameter、相互リンク、36機能/20受入シナリオ/12実装タスクの対応、4 binding vectorsと8丸めvectorsを確認する。`work/design/generate_contracts.py` でOpenAPIとベクトルを再生成可能。

SQLはレビュー用DDLとして作成した。PostgreSQLへ適用していない。OpenAPIは構造チェックを実施したが、外部のOpenAPI validatorやprovider本体による検証は未実施。ベクトルは合成した符号化入力であり、実Groth16 proofではない。

## 実装で取得する証拠

G1〜G4はすべて未実施。I02で元証明の互換性、SVM CU、tree backendを決める。I05でDDL適用とtransaction競合、I10で障害注入と実provider、I11でsetup・review・release条件を満たす。依存versionのexact lock、production program ID/keys、実provider権限はそれぞれのタスクの成果物である。

現在の完了判定は「設計と作業契約があり、追加の製品方針質問なしでI01から着手できる」。production稼働可能という判定はしていない。
