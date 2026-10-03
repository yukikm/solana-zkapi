# ADR-0002 — ビルド時に検証した署名公開鍵の固定

2026-10-03 JST。I03で採用。初期リリースの単一pool profileについて、state/clearance署名公開鍵はprogram buildの設定として固定する。元Baby-JubJub曲線、部分群、署名、回路、tree hash、VKは変更しない。

## 根拠

Arkworks 0.5のcanonical座標・非単位点・on-curve・prime-order subgroup検査をそのままSBF v0で実行すると、1鍵6,369,418 CU、2鍵12,737,948 CUだった。通常の1,000,000 CU予算では失敗する。高予算で得た数値は診断値であり、cluster受理可能性やG1合格を意味しない。[検証記録](../evidence/I03-key-validation.json)にartifact hashと範囲を保存する。

## 決定と不変条件

1. ビルド設定にstate/clearance各64-byte公開鍵を保持する。公開鍵であり、秘密鍵をソースやbuildへ渡さない。
2. `build.rs`は元Arkworksによって両公開鍵の座標canonical、曲線、正しい部分群、非単位点を検証し、不正ならビルドを失敗させる。剰余正規化やcofactor clearingで別の鍵へ置換しない。
3. `initialize_pool`の署名・args・wireは維持する。指定された鍵を、ビルドで検証した**同じ役割**の鍵と完全一致で比較する。2鍵の集合へのmembership判定ではなく、stateとclearanceを交換しても拒否する。
4. 保存したPoolConfigの鍵も各命令でビルド設定と比較する。accepted keyが正しい部分群にあるという不変条件は、検証済み定数との一致から成立する。
5. 別の署名鍵を使う場合は公開鍵設定を変更し、ビルドと検証をやり直して、対応programと新poolとして配備する。既存poolの鍵をupgradeで入れ替えない。鍵ローテーションAPIは初版に追加しない。

これは元仕様が受理し得た任意の有効鍵を、1つのビルドで受理することを制限する、明示的な配備設定の変更である。既存の単一pool方針と初期化後の鍵不変条件に合わせる。program buildごとの公開鍵pinをmanifest/PoolConfigと照合する要件を追加する。汎用的なオンチェーン部分群計算が必要な複数pool構成は、別方式の検証と計測が必要になる。

## 適用範囲

現在の公開鍵・deployment authority・setupは公開テストfixtureの値であり、本番の鍵ではない。productionはI11の安全なsetup、配備設定、監査、manifest検証を引き続き必要とし、現在の`production` featureはコンパイルを拒否する。I04のtransport、G1全体、G2〜G4の合格をこのADRから導かない。
