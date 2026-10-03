# ADR-0001 — 同一Poseidonのtree更新を追加Groth16証明で検証する

状態：**実装方針として採用**（2026-10-03 JST）。ユーザーの「実装ができるようにReadyな状態にすべく設計」に基づく。production配備・G1合格の承認ではない。

## 問題と実測

固定Ethereum zkAPIのrequest/withdrawal回路、Poseidon、32段treeを維持する。元treeを直接SBFで計算すると約2.18億CU。最初の追加tree証明案にもprogramでのtransition tag再計算が残り、全体で約1,034〜1,065万CUだった。同一ハッシュの演算最適化でもtag単体が約262万CU。標準Poseidon syscallは異なるspongeで出力が一致しない。

[I02実測](../evidence/I02-optimization-results.json)の`research-proof-bound-tag`は、追加tree回路が拘束済みのtagの二重計算を省き、365,907〜671,266 CU。通常の100万CU予算、実SBF、実Token CPIで131ケースを確認した。これは本番Vault全体のworst-case値ではない。

## 決定

1. 初版の新poolは`layout_version=2`、`tree_backend=transition_proof`、`tree_tag_policy=proof_bound`に固定する。runtimeでbackend・VK・tag検査方式を選ばせない。
2. request/withdrawalの元回路・12/14公開入力・Poseidon・Baby-JubJub署名・nullifier式を維持する。Solana識別情報のH2FとUSDC化は既存移植仕様を継承する。
3. 追加回路`solana.zkapi.tree.v1`が元のleaf生成、同じ32 siblingsを使った旧新root、u32 index、u64金額/expiry、op 0/1/2、11公開入力のtransition tagを制約する。
4. programは固定VKで11公開入力をすべて検証し、実accounts/命令/他のproofへの結合を別途検査する。programでleaf/path/tagのPoseidonを再計算しない。tag自体は回路・公開入力から削除しない。
5. tree証明と必要なrequest/withdrawal証明、状態更新、USDC転送を一つのinstructionで実行する。アップロード済みbufferは証明の検証成功や資金予約を意味しない。
6. transactionは`v0_buffer`を必須・既定経路とする。v1 inlineは将来の追加能力として、実cluster/RPC/wallet/serialize検証後だけadvertiseする。v1対応を初版実装の依存にしない。
7. CPU/CLIでのtree証明生成を必須とし、SDKから利用する。特定workerへの依存を避け、利用者がローカルで生成できる経路を実装する。tree proverへnote secret・残高署名・provider credentialは渡さない。

詳細な入力・命令・結合・artifact契約は[tree-transition仕様](../specs/tree-transition.md)を正本とする。

## 同等性と安全性の条件

元Vaultの`MerkleUpdateLib.verifyAndUpdate`は、同じpathから旧rootと新rootを計算し、旧rootが現在rootと一致することを確認する。追加回路はこの関係と元leaf計算を証明する。回路が正しく、setupとGroth16のsoundnessの前提が成立し、programが公開入力を実状態へ結合すれば、同じtree遷移を受理できる。

`transition_tag`はSolana移植で追加したtagであり、元の`authorization_tag`/`withdrawal_tag`を置換しない。固定tree VKによる全11入力の検証が`tag = H(domain, 前10 fields)`を保証するため、同じ関係をprogramで計算する必要はない。公開入力の一部を検証対象から外す、任意VKを渡す、状態結合をtagだけに任せる実装はこの決定に反する。

tree proofだけでは出金権限・清算承認・二重出金防止は保証しない。withdrawalのNote/root/Vault/宛先/鍵/clearance、challengeの過去requestとPendingのnullifier、status/期限/トークンaccount条件を元の状態機械どおり確認する。challengeの過去rootを現在rootへ変更してはいけない。

## 機能への影響

| 項目 | 採用後 |
|---|---|
| 匿名の利用認可、署名付き後継残高 | 元回路・サーバー精算方式を維持。毎回のAPI利用に追加tree proofは不要 |
| deposit / close / escape開始 / challenge / expiry | treeを変更する命令に追加tree proofが必要 |
| finalize / 管理命令 | tree proof不要。元の状態条件を維持 |
| tree root / leaf / 通常認可の公開情報 | 同じ入力に同じ値。通常認可にnote ID・walletを追加しない |
| 資産・chain binding・wire | 既定どおりUSDC・Solana H2F・新wire。Ethereum送信済みproofのchain間再利用はしない |
| 信頼の前提 | 元の仮定に加え、tree回路の正しさ・追加setupに依存 |
| 可用性・待ち時間 | tree proof生成とroot競合時の再生成が増える。クライアントとchallengerで評価する |

## 代替案

- SBF v2＋演算改善：出力は保つがtagだけで100万CUを超える。target featureにも依存するため初版の解決策にしない。
- 標準Poseidon syscall：root・commitment・回路の意味を変更する。今回採用しない。
- オンチェーン更新を複数transactionへ分割：途中状態・資金との原子性に新しい設計を要する。今回採用しない。
- tagをSHA256へ変更、公開入力から削除：回路変更と再検証が増える。既存追加回路のtag制約を維持する。

## 実装・公開の境界

このADRでbackend選択と「programによるtag再計算」の設計blockerを解消する。旧program再計算要求を本ADRと新仕様で置き換える。研究用featureのコードは証拠として保持し、本番Vaultへそのまま転用しない。

[I02-B](../evidence/I02B.md)で回路・wire・固定VK・共有bindingを標準化し、正常なproof同士の組合せ違いも拒否する257件の実SBF試験を完了した。I03/I04で全命令・account作成・buffer lifecycleを含む100万CU/1232 bytes gateを満たす。I11では3回路のproduction setup、artifact固定、第三者reviewを行う。失敗を予算引上げや検査省略で通さず、設計へフィードバックする。

I02完了によりI03へ着手可能。採用harnessは最大約32万CUだが、test-only setupと測定account範囲の結果を全Vaultやproduction合格とは扱わない。
