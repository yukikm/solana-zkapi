# I08/I09 実装レビューと継続実装への引き継ぎ

2026-10-04 JST。コード、受入条件、既存証跡を照合した結果、**I08/I09は初期実装であり、全体完了ではない**。レビュー修正後の基盤から継続実装できる。I10全機能E2Eへの完了引継ぎは未達で、G1〜G4は未合格を維持する。

## 修正した問題

| 対象 | 問題と影響 | 修正・回帰 |
|---|---|---|
| SDK認可復旧 | createが通信失敗して未到達だった場合、closeがphaseをclosingへ変更すると、close 404後もGETのみになり同一認可の復旧を失う | close意図を別に保存し、send_unknownのexact認可POSTを維持。復旧後に必ずcloseし、direct keyを公開しない。再起動・close応答喪失も試験 |
| SDK artifact引き渡し | contextの非同期検証後に呼出元の可変artifactを使うと、検証したPK/VKとproverへ渡すbytesがずれる | 入口でsnapshotし、検証済みartifact copyを返すbundle APIを追加。既存context APIは維持し、検証中の外部変更を回帰試験 |
| Challenger DB接続 | hostだけの検査はhostaddrによる接続先上書きを見逃し、local-only APIから遠隔IPへNoTls接続できる | hostaddrもloopback限定にし、IPv4/IPv6・複数host・URL形式の拒否を回帰試験 |
| Challenger永続job | 同じN/Pendingをdeadline等だけ変えて別jobとして登録すると、Unknown署名の置換禁止を迂回できる | 永久NとPending生成sequenceの一意性・不変な証拠を検査し、別名登録を拒否。再open時も不整合を拒否 |
| Challenger checkpoint | signature文字列を実行順とみなす比較や、同slotの異なるblockhash等を許す比較ではforkした観測・Pending以前のpayloadを保存できる | slot/transaction/outer/CPI順、同slot blockhash・同transaction signature・同position sequenceを検査 |
| Challenger payload復旧 | 過去のpayloadの確定失敗を使い回し、新しいpayloadを何度も差し替えられる | 直前payloadのdigest/bufferに結合した確定失敗がある場合だけ差替えを許可 |

## 新しい実Vault検証

`tests/svm/src/bin/challenger.rs`を追加し、**その実行で新しく生成した**`generated-challenge.bin`のhashを照合して、実Vault ELFへv0 bufferのcreate/append/seal/executeで渡す。入金A/Bとescape Aも実命令で構成し、成功用bufferのseedを使わない。

- 過去RP rootが現在root/Pending.old_rootと異なる状態でchallenge成功。
- pause中も成功、deadline等号では拒否。失敗時のwritable account rollbackを検査。
- root/sequence/Note/Pending/transition event、USDC escrow、永続ExitNullifierを照合。
- 同じchallengeと消費済みNによるescapeを拒否。
- 全取引の1,000,000 CU / 1,232 bytes上限を検査。

これはdaemon/broadcasterやpublic RPCの受入ではない。DB transcript envelopeは合成fixture、RPと新tree proof・Vault実行は実暗号。SDK/Go常駐processからの送信・再起動回復は未検証。

## 再現と証拠

```sh
python3 scripts/run_i08.py
# I04 archive / Vault ELFがなければ先に bash scripts/run_i04.sh
python3 scripts/run_i09_challenger.py
python3 scripts/check_upstream.py
python3 work/design/generate_contracts.py --check
python3 scripts/check_design.py
python3 scripts/check_evidence.py
git diff --check
```

**I08は77件、I09は12件、計89テスト成功、失敗・除外0**。加えて新payloadの**実Vault SBF 79取引**（期待拒否5件）を検証し、最大335,295 CU / 1,091 bytes。型検査/fmt/Clippyも成功。I08 runner 14.177秒、I09 runner 6.482秒。実行Node 24.13.0は指定24.19.0と異なり、指定versionでのlocal検証は未実施。

検査件数・コマンド・source/lock/artifact hashは[I08](I08-results.json)・[I09](I09-results.json)に記録した。I09 runnerは新生成artifactの古い出力を消してから試験し、今回のpayloadとELFのhash、実SBF結果、使用sourceも記録する。CIへ新SBF結果/ELFの保存を追加したが、hosted実行は未確認。

native companionの既存7試験も再確認し、確定不具合は見つからなかった。vendor/license・回路/Poseidon・役割別鍵・財務writer/migration・整数会計契約は変更していない。

## 次の実装

[開始契約の再開位置](../i08-i09-implementation-ready.md)に順序と境界を更新した。既存SDK journal/transport/native verifierとchallenger read model/prover/journalを使う。

- I08：note witness/clearance/WASM・wallet製品フロー、Go clientd、localhost認可、Tor、secret custody、配布。
- I09：RPC常駐scan、署名済みv0送信/復旧、期限再送/SLO、専用dispatcher/egress fencing、DB/WAL/signer復旧、監視/admin dashboard/KMS/mTLS。
- I10/I11：上記受入後の全mode E2E・実provider・target wallet/RPC・production setup・独立review。

未実装機能を単なる外部credential待ちとは扱わない。継続実装への着手と、タスク完了・公開gateは別の判定である。
