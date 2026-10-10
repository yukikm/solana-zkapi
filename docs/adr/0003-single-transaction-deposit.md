# ADR-0003 — compactな入金命令を1つのv0取引で送る

2026-10-06 JST更新。状態：**実装済み。ローカルruntime検証を追加し、公開canary／Phantom受入前。** [詳細設計](../architecture/single-signature-deposit.md)を実装契約とし、結果は[実装証跡](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-implementation.md)に記録する。ADR-0001の稼働manifest・既存journalの既定経路は変更しない。

## 問題

通常の入金がcreate/append/seal/executeの4取引・4回のwallet署名になる。既存Vaultには原子的なinline depositがあるが、692-byte argsと現行account構成、CU limit/priceを含む自己負担v0取引は1,263 bytesとなり、1,232-byte制限を超える。SDKは全操作にbufferを使う。

## 提案する決定

1. 新命令 `deposit_compact_v1` を追加する。436-byte argsから既存692-byte canonical depositと同じ全11公開入力を復元し、同じ固定VKと共通financial handlerで検証・実行する。
2. 既存DepositAccountsを維持する。元回路、Poseidon、PK/VK、account layout、USDC会計、API認可・精算を変更しない。
3. 新規depositは認証済み `v0_inline_deposit_v1` capabilityがある場合にv0取引1つを使う。通常自己負担のserializeは1,007 bytes。ALT・relayer・v1・一括署名を必須にしない。
4. 既存WalletClient/journalをtransport別のplan/attempt unionで拡張する。inlineを金融命令として扱い、未知送信の再入金・rebase・buffer fallbackは禁止する。
5. 新inline recordはNoteJournal schema 2で旧SDKに拒否させ、新SDKは旧schema 1のbuffer操作を保存された方式のまま回復する。
6. `v0_buffer` は旧操作、withdrawal、escape、challenge等の必須互換経路として残す。旧署名・proof・journalを変換しない。
7. 実装後のSBF/SDK/indexer/Phantom gateを通してから、ADR-0001の既定transportを「新capabilityがある新規depositだけcompact」に補足する。

## 比較と限界

既存inline＋ALTでもサイズを減らせるが、ALT配備・pin・availabilityが増える。4取引の一括署名は原子的な1取引入金を実現しない。compact案は既存の公開入力の重複だけを省き、検証内容を保つ。

正常系で署名1回を目標とする。root/next ID/expiryの競合で確定拒否された場合は新しい取引への再署名が必要。「障害時も一度の承認を永続利用する」署名intent/nonce/relayer protocolは別設計とする。

[設計初版のoffline計測](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-transport-analysis.json)はサイズと符号化の証拠であり、後続の実SBF・SDK・Indexer検証は[実装証跡](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-single-deposit-implementation.md)で区別する。公開wallet・本番受入は未確認。配備順序は[詳細設計](../architecture/single-signature-deposit.md)に固定する。
