# Layout 2 — 実装Ready化の設計確認

日付：2026-10-03 JST。ユーザー依頼：「こちらで実装ができるようにReadyな状態にすべく設計」。状態：**設計採用済み・I02-B実装着手Ready**。同じ担当による仕様整合確認であり、第三者監査・production runtime検証ではない。

## 採用した成果物

- [ADR-0001](../adr/0001-proof-bound-tree-transition.md)：同一Poseidonを追加Groth16 tree証明で保証し、programのtag再計算を省く。layout 2、新pool限定、v0_buffer必須を採用。
- [tree-transition仕様](../specs/tree-transition.md)：11公開入力、命令別の元WP/RP/実状態との結合、wire、proof生成・競合・復旧、artifact/profile/setup、TT01〜TT08。
- [protocol仕様](../specs/protocol-solana.md)：全資金命令をTreeUpdateへ変更。Account layout/profile、原子的execute、buffer payload/close条件を統一。
- [wire契約](../contracts/tree-transition.json)・[OpenAPI](../contracts/openapi.json)：固定payload長・op・公開入力順、manifestの採用方式・transcript・transport条件を生成器へ反映。
- [実装開始仕様](../implementation-ready.md)・[タスク](../implementation-plan.md)：完了済みI02-Aと残りI02-Bを区別し、B1〜B4からI03/I04へ進む条件を固定。

## 設計で解決した点

| 論点 | 決定・確認 |
|---|---|
| tag再計算が約1,000万CU | 固定tree回路がtagを拘束し、programは全11入力のproofを検証。元認可/出金tagは維持 |
| 「証明が2つ通る」だけで別Noteを操作できる危険 | WPのNote/root/VaultをTP/実状態と比較。正常proof同士の混合拒否をTT02へ追加 |
| challengeのhistorical root | RPは過去のまま、Pending.Nで結合。TPだけ現在rootへ結合。Pending.old_rootとの一致も要求しない |
| tree opと命令の混同 | tree 0/1/2とbuffer 0..4を別enum化。close/escape/expiryの個別認可条件を維持 |
| 初期化時に重いPoseidonが残る | 元Rust/EVMで照合したempty rootを埋込み、programで32段再計算しない |
| harnessのwire/転送を本番へ誤流用 | 正本はpublic→proof順の608 bytes、harnessはproof→public。I02-Bで明示的に標準化 |
| v1やALT未対応で実装が止まる | v0 bufferを必須・既定。v1は実証済みdeploymentの追加能力 |
| 追加proverが単一障害点になる | native/CLI必須、local生成可能、workerに秘密不要。待ち時間/競合/障害復旧を受入条件に追加 |
| test setupを本番に流用 | test_onlyとceremony_verifiedをmanifestで区別し、mainnet＋test_onlyをschemaで拒否。runtime/transcript検証は別途必須 |
| Readyと完成の混同 | backendの設計blockerだけ解除。I02-B/I03/I04/I10/I11の実装・公開gateを残す |

固定Ethereum sourceのdeposit/close/escape/challenge/finalize/expiryを照合した。元request/withdrawal回路、hash、署名、nullifier意味は変更しない。USDC/H2F、counterの満杯表現、追加tree証明、wire/transportは意図した差分として扱う。公開Ethereum bytecode・liveサービスとの同等性検証は今回の範囲に含めない。

## 検証

```sh
python3 work/design/generate_contracts.py --check
python3 scripts/check_design.py
python3 scripts/check_upstream.py
# 専用venvに openapi-spec-validator==0.7.2 / jsonschema==4.26.0
python3 scripts/check_openapi_contract.py
python3 scripts/check_evidence.py
git diff --check
```

OpenAPI 3.1、52 schemas、31正常/異常例を確認。layout 1・旧backend・誤tag policy・tree artifact欠落・公開入力数違い・v0_buffer欠落・mainnet test setup・ceremony transcript欠落を拒否する。別途、生成物一致、11入力順、wire長/命令op、profile fields、20既存受入条件＋8 tree条件、リンク、upstream pin、artifact SHAを検査する。

schema例のhash/公開鍵/署名は形式検査用。ceremony_verifiedという文字列やtranscript hashの存在だけで安全性は証明されない。実transcript検証・profile digest再計算・実account照合はI02-B/I11の実装条件。

今回変更したのは設計・契約schema・設計checker・引継ぎ。暗号回路、proof fixtures、SBF programは変更せず、新しいruntime CU結果は生成していない。研究用JSONの集計metadataだけを設計採用後の状態へ更新した。以前の131ケース/37〜67万CUを新しいwireや完成Vaultの実測として扱わない。remote CIは未実行。

## 次の担当の開始位置

`docs/implementation-ready.md`→ADR-0001→tree-transition仕様→I02-BのB1〜B4。追加の方式選択を待たずlocal/test環境で着手できる。I03のscaffold/IDLを並行して用意できるが、統合完了はI02-Bのbinding/実SBF合格後。G1全体は本番相当の全Vault/transport、G4はproduction setup/review完了後に判定する。
