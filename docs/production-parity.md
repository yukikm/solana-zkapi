# Solana zkAPI — Production parity design

更新：2026-10-02 JST

ユーザー要件：最初から本番運用を想定し、Ethereum版の利用体験と機能をSolanaで再現する。USDC決済、proxy対応を必須とし、OpenAI・Claude優先、Ollama互換は初期対象外。

実装上の正本は [実装開始仕様](implementation-ready.md) とその参照先。本文は比較設計として残し、具体的なwire/DB/実装順序は実装開始仕様を優先する。

本書は過去の限定MVP案およびnative SOLを必須とした設計に優先する。USDCを基本資産とし、本番向けの復旧・運用要件を維持する。I01〜I05のlocal実装・検証は完了し、次はI06 direct・I07 proxyのprovider adapters。現在地と証拠は[I05完了記録](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I05.md)を参照する。実provider・実wallet・公開RPC・hosted CI・G1〜G4公開gateを含むプロダクション実装は未完了。2026-10-03 JSTの[ADR-0001](adr/0001-proof-bound-tree-transition.md)でlayout 2の追加tree証明方式を採用した。以下の方式比較は経緯として残し、採用済みのwire/条件は[tree-transition仕様](specs/tree-transition.md)を優先する。

## 1. 同等性の定義

同等性とは、利用者から見た操作、残高状態遷移、失敗時の復旧、プライバシー境界が、固定したEthereum版と対応することをいう。資産と課金方式は、ユーザーの希望によりUSDC建てへ変更する。native ETH/SOL会計との完全一致を完成条件にはしない。EVM ABIやEthereumアドレスをSolanaでそのまま扱う意味ではない。

暗号と状態機械は可能な限り維持する。Solanaのaccount、SPL Token、slot、transaction、署名方式への対応はchain adapterに置く。USDC会計とproxy追加は意図した仕様差分として記録し、同等移植と独自拡張を混同しない。

### 参照元の確度

| 証拠 | 確認できた内容 |
|---|---|
| EF紹介記事 | Ethereum mainnet稼働を告知。Vaultリンクあり |
| 取得コード | コミット `045b444ea1b52538d1b40273c7cb6ed09468a052` |
| SDK mainnet manifest | deployment ID `zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930` |
| 同manifestのVault | `0x4386FDbdA35D995beB3BF8625118Ec5982ec81fe`。記事のリンクと一致 |
| 同manifestの課金 | `billing_asset=native_eth`, `billing_unit=gwei`, `billing_token_address=null` |
| 同manifestの回路 | `zkapi-v2-note-bound-v1` |
| 本番API・bytecode照合 | 今回未完了。Web取得不可、補助取得もローカルCAの証明書検証で失敗。TLS検証を無効にしていない |

したがって「公開コードに固定された本番構成」を比較基準として採用する。参照元がnative ETHであるという観測情報は、Solana版のUSDC採用とは分けて保持する。実際のデプロイbytecode、現在のAPI設定、constructor値、監査の有無まで確認済みとは扱わない。これらの照合は実装基盤の最初のタスクに含める。

出典：[紹介記事](https://blog.ethereum.org/2026/10/01/introducing-zkapi)、[mainnet manifest](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/sdk/assets/config/mainnet.json)、[デプロイ説明](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/docs/deployment.md)

## 2. 前案から変更する判断

| 前案 | 今回の方針 |
|---|---|
| native ETH→native SOLを必須とする | Circle発行USDCを基本資産にする。native SOL課金は初期必須から外す |
| SOL/USD oracleを必須にする | USDC建て料金表・quoteを固定して発行・精算する。通常課金に相場oracleは使わない |
| Solana Poseidonへ直ちに置換する | 元のPoseidon spongeとtest vectorの維持を第一候補にする |
| 32-byteアドレス対応で回路刷新 | hash-to-fieldによる外部bindingで既存回路を維持できるか先に検証する |
| nullifierにnote leafを追加する | 原式 `N=H_null(secret,anchor)` を維持する |
| 7日間の出金猶予を追加する | 原実装のexpiry/claim semanticsを維持する |
| 過去rootを使った出金を許可する | 原実装と同じく、close/escape開始ではcurrent rootを要求する |
| depositだけpauseする | 原Vaultのpause対象を再現する。変更は別仕様として扱う |
| API・SDKを一部に限定したMVP | 現行の有効な全経路を受入表に含める |
| 新しい強制出金プロトコル | 基本移植では導入しない。原方式の信頼条件を維持・明記する |

USDC採用は、料金の分かりやすさと価格変動の小ささを重視したユーザーの最新方針に基づく。native SOL必須という前の判断を上書きする。初期の課金資産はUSDCに限定し、SOLはnetwork fee・rent等に使う。

## 3. 再現する機能と受入基準

以下の全項目が対象。実装順序と最終スコープは区別する。

| ID | 機能 | Solanaでの対応・受入基準 |
|---|---|---|
| P01 | 秘密noteの生成 | secret、commitment、blinding、anchorの端末生成と保存 |
| P02 | USDC入金 | 固定mintのUSDCをPDA管理のtoken accountへ入金し、整数micro-USDCのdepositとleafを登録 |
| P03 | 32段active tree | 原leaf/node hash、zero leaf、index順序で登録・除去・復元 |
| P04 | 端末内proving | Rust/nativeとbrowser WASMで実Groth16 proofを生成 |
| P05 | genesis / signed state | 初回 `B=D, τ=1` と後続の署名検証を維持 |
| P06 | note-bound commitment | `E=B·G+r·H+L·J` と再乱数化を維持 |
| P07 | 匿名認可 | request ID・prompt-free payload・quote・capとの結合を検証 |
| P08 | 二重使用防止 | 永続nullifier予約、同一認可の再送、異なる認可の拒否 |
| P09 | USDC料金見積もり | mint・精度・料金表version・cap・期限を固定。USD upstreamとの換算方針も明示 |
| P10 | 期限切れ見積もりの復旧 | 未受理確認と、予約済み認可の旧quote維持を区別。oracle更新による失効は廃止 |
| P11 | OA-org runtime-key経路 | 発行証拠・verifierのpinning、明細検証、精算 |
| P12 | direct OpenRouter経路 | 発行・disable・grace・usage・deleteを永続処理 |
| P13 | 直接推論 | prompt/responseをpayment serverへ送らない |
| P14 | 実使用料精算 | cap内のΔを差し引き、一つの署名付き後継状態を返す |
| P15 | lease復旧 | 応答喪失・不明な発行・未発行確定・精算途中を復元 |
| P16 | 合意出金 | clearance、withdrawal proof、N消費、BとD−Bの支払 |
| P17 | escape開始 | leaf即時除去、N消費、Pending記録、challenge deadline |
| P18 | stale escape challenge | 過去request proofと現在のzero-pathでleafを復元 |
| P19 | escape finalize | 期間後、保存済みdestination/balanceに一度だけ支払 |
| P20 | expiry claim | 期限切れActive noteの全depositをtreasuryへ。Pendingは対象外 |
| P21 | 管理機能 | treasury変更、pause/unpause、原契約と対応する権限 |
| P22 | Indexer API | root、snapshot、next-note-id、path、zero-path、同期状態 |
| P23 | Browser SDK | worker、wallet接続、手動署名相当、入出金、journal、状態購読 |
| P24 | ローカルCLI/API | config/serve、models、chat completions、responses、messages、streaming、wallet操作 |
| P25 | key reuse | default 60秒、0でrequestごと、設定保存、終了後の自動精算 |
| P26 | ローカル接続制御 | loopback、Origin/Host検査、wallet用管理credential、ログ秘匿 |
| P27 | Tor / SOCKS5 | remote DNS、経路不通時のfail closed、companionと経路一致 |
| P28 | mainnet/test環境分離 | manifest・鍵・journal・USDC mintの分離、test専用共有password |
| P29 | 復旧可能なchallenge運用 | 永続checkpoint、証拠保管、再送、finality確認、期限監視 |
| P30 | 配布・運用 | artifact pinning、native配布、Docker、設定、backup/restore、monitoring |
| P31 | ダッシュボード | summary/recent/events相当と秘密情報を出さない運用表示 |
| P32 | proxy認可 | proofに結合した限定credential、同一操作の復旧 |
| P33 | provider adapters | OpenAI Chat/Responses、Anthropic Messages、OpenRouter Chat |
| P34 | proxy予算・会計 | 並列予約、最大額制限、整数精算 |
| P35 | proxy障害復旧 | SSE、切断、usage unknown、二重実行防止 |
| P36 | 料金・対応機能・privacy | 固定料金表、対応API一覧、proxy内容可視性の表示 |

OA-orgのproduction credentialやverifier利用権限は上流コード公開とは別の依存である。利用可能性を確認し、adapter自体は実装対象に残す。利用できない経路をmockのまま「全経路本番同等」と扱わない。

### 記事と有効コードに差がある機能

原runtimeは `request_modes=[direct_openrouter]`, `policy_enabled=false` を返し、`POST /v2/requests` は削除済み。proxyは元コードに有効な経路があると仮定せず、7節の追加設計として扱う。初期RLNやpolicy penaltyは復活させない。

ローカルAPI実装で確認した公開推論ルートは `/v1/models` と `/v1/chat/completions`。ユーザーの希望によりOllama互換は初期対象外。Solana版はproxyと併せてOpenAI Responses、Anthropic Messagesのadapterを追加する。対応subsetと受入試験はAPI仕様に固定し、全クライアント互換とは扱わない。[Claude API概要](https://platform.claude.com/docs/en/api/overview)

出典：[server routes](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/crates/zkapi-serverd/src/routes.rs)、[native billing](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/docs/native-eth-billing.md)、[local client](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/docs/CLI_ZKAPI.md)

## 4. 暗号移植の優先順位

### 4.1 原回路の維持を最初に検証する

維持するもの：BN254 Groth16、Baby-JubJub Schnorr、note-binding generator、Poseidonの定数・sponge規則、request 12 fields、withdrawal 14 fields、32段tree。

既存回路の `contract_address` と `destination` はFrとして受け取られており、回路内でEthereumの160-bitアドレスであることを前提にした型ではない。このため、Solana側の完全な識別情報を次のように外部で結合する案を第一候補にできる。

```text
H2F(label, bytes) = OS2IP(SHA256(length_delimited(label, bytes))) mod Fr_modulus

chain_namespace = 0x534f4c

vault_binding = H2F(
  "solana-zkapi-vault-v1",
  genesis_hash || program_id || pool_pubkey || token_program_id || usdc_mint || decimals
)

destination_binding = H2F(
  "solana-zkapi-destination-v1",
  destination_pubkey_32_bytes
)
```

`chain_id` fieldへchain_namespace、`contract_address` fieldへvault_binding、`destination` fieldへdestination_bindingを入れる。このnamespaceは本プロトコル内部の識別値で、Solana公式のchain IDではない。JavaScriptの安全整数範囲に収め、ネットワーク間の分離はgenesis hashを含むvault bindingで行う。プログラムは実際のaccount pubkeyと固定configからbindingを再計算し、渡されたfieldを盲信しない。クライアントはgenesis hashをRPCと照合する。プログラムがgenesis hashを自動でRPC取得できるとは仮定しない。

これはPubkeyそのものを剰余変換する案とは異なる。全32バイトを暗号学的ハッシュで結合し、衝突困難性に依存する。数学的な単射ではない。destinationは出金先wallet ownerを意味し、programがそのowner・固定mint・固定token programから導出したATAだけへ支払う。別ownerのtoken accountや別mintへの差し替えを拒否する。既存circuitの入力互換性、証明生成helperのEVM型依存、Solana verifier変換を実証してから採用を確定する。

この案が成立すれば、**アドレス対応のためだけに既存回路やsetupを変更する必要はない**。HTTP/SDKのchain schemaはSolana用であることを明示し、既存Ethereumクライアントとwire互換とは主張しない。

出典：[回路の入力と制約](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/rust/crates/zkapi-proof/src/groth16.rs)

### 4.2 Solanaの暗号機能との接続

- Groth16検証はBN254 syscallを利用するSolana verifierへ接続する。
- proof座標のFr/Fq区別、big-endian、G2係数順、A点符号、subgroup検査をadapterに集約する。
- SolanaのEd25519をBaby-JubJub状態署名に置き換えない。
- 原Poseidon spongeはSBFで同じ出力を得る実装を先に計測する。同名syscallへの置換で同一になると仮定しない。

I02で以下を比較し、2の追加tree証明（tagはproof内で拘束、programでの再計算なし）を採用した。1/3は現在の実装選択肢ではない。

1. 定数・有限体演算・メモリー配置を最適化し、同一test vectorを保つ。
2. 同じhashによるtree更新を別のZK transition proofで検証する。旧root/new root、note index、旧leaf/new leafとNote内容を結合し、資金転送と原子的に適用する。この場合は追加回路・setupが必要だが、利用者残高の原回路は維持できる。
3. それでも適さない場合だけsyscall互換hashへ改訂する。差分を明示し、新回路・新setup・全経路の再検証を行う。

どの方式でも、複数transactionに分けた未完了のtree更新を有効rootとして公開しない。入力アップロード用bufferを使う場合はhash・所有権・最終化を固定する。

原setupはsingle-partyである。既存setupの再利用と新setupの生成は別判断とする。まず同じartifactで検証器の互換性を確認し、本番manifestには採用したartifactと信頼モデルを記録する。新setupを作っただけで信頼モデルが改善したとは扱わない。[setup説明](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/setup/v2/README.md)

## 5. USDC会計と料金見積もり

入金・note残高・精算・出金をSolana上のCircle発行USDCで統一する。単位は整数micro-USDC（1 USDC = 1,000,000 units）。mainnet mintはCircle公式一覧の `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`、devnet mintは別manifestで固定する。mint accountのowner program・decimalsも実環境で検証してpinし、同名の別tokenは受け付けない。[Circle公式mint一覧](https://developers.circle.com/stablecoins/usdc-contract-addresses)・[Solana転送例](https://developers.circle.com/stablecoins/quickstart-transfer-10-usdc-on-solana)

初期の料金方針は「upstreamの1 USD分の利用料を1 USDCで請求」とする。これはサービスの料金設定であり、USDCの市場価格や償還価格を保証する主張ではない。この方式では通常課金にSOL/USD・USDC/USD oracleは不要になる。相場乖離時の差額は運営側のリスクで、受理済みquoteを後から変更しない。新規認可を停止しても既存精算・出金まで自動停止させない。発行体によるtoken凍結など、資産固有の制約は残る。

capをU micro-USDC、upstream確定使用額をC micro-USDとすると、追加手数料なしの初期設定は次の通り。

```text
provider_budget_micro_usd = U
charge_micro_usdc        = C       # 0 <= C <= U
```

upstreamがより細かい単位を返す場合は正確な十進数または整数比で累積し、精算時に一度だけmicro-USDCへ切り上げる。JSON浮動小数点値を会計の正本にしない。usage=0はcharge=0、上限超過を利用者に転嫁しない。安全な上限予約と停止処理を実装し、超過分は運営負担として記録する。元の `MAX_NATIVE_UNITS=2^53−1` は初期の数値上限候補として互換性を検証するが、元の50,000 gweiというcapをUSDCの同じ数値へコピーしない。

quoteにはasset/mint、unit、料金表version、provider/model、利用上限、期限、換算方針、手数料があればその額を含め、認可payloadのbindingとjournalへ固定する。UIではUSDC残高と利用料を同じ単位で表示する。未受理quoteの期限切れと、受理済みquoteを使った復旧を区別する。

SOLはtransaction feeとaccount作成費に使う。基本経路は利用者がfee payerとなり、運営の手数料代払いは追加UXとして設計可能。代払いしてもネットワークへの支払い自体はSOLであり、資金源・上限・濫用防止・代払い停止時の自力出金経路を別途定義する。通常のオフチェーンAPI利用ごとにはSOL支払いを要求しない。[Solana手数料](https://solana.com/docs/core/fees)

## 6. VaultのSolana対応

| Ethereum | Solana |
|---|---|
| immutable deployment parameters | 固定PoolConfig、VKと署名鍵のpinning |
| native ETH保管 | 固定USDC mintのtoken account。SPL Token Program所有、vault PDAがtoken authority |
| notes mapping | Note PDA |
| pendingWithdrawals mapping | PendingWithdrawal PDA |
| usedNullifiers mapping | ExitNullifier PDA。消費後は再利用不可 |
| currentRoot / nextNoteId | TreeState PDA |
| owner | 明示されたadmin authority |
| block.timestamp | Clock sysvarのunix timestamp |
| EVM transaction nonce | signature・recent blockhash・lastValidBlockHeightを持つ送信journal |

命令は `deposit`, `mutual_close`, `initiate_escape`, `challenge_escape`, `finalize_escape`, `claim_expired`, `set_treasury`, `pause`, `unpause` を対応させる。

保持する挙動：

- expiryを日単位で切り上げる。デプロイスクリプトのTTLは30日、challenge defaultは24時間。実際のEthereum本番constructor値は別途照合する。
- 合意出金とescape開始はcurrent rootを要求する。
- escape開始時はleafをゼロにする。
- challengeは元のhistorical request proofを保持し、現在rootに対するzero-pathで復元する。履歴rootを現在rootへ書き換えない。
- challenge成功後も消費済みwithdrawal nullifierを復活させない。
- finalizeはPendingに記録された受取先と残高を使う。
- expiry claimはActiveだけ、全depositをtreasuryへ支払う。
- pauseはdeposit、mutual close、escape開始を止める。challenge、finalize、expiry claimは原実装と同様に止めない。

原実装と同じ管理挙動を保持することと、その管理者を信頼不要と呼ぶことは別である。

USDC escrowではtoken balanceを元本の正本とし、SOLのrent reserve・transaction fee・account作成費と分離する。これらの費用をnote残高から無断で引かない。入出金は固定mint・token program・decimalsとauthorityを検証し、`TransferChecked` CPIで行う。入金に失敗した場合はnote/tree登録も失敗し、出金に失敗した場合はcloseも成立しない。受取先は証明に結合したwallet ownerのUSDC ATAとし、treasuryにも固定mintのtoken accountを使う。[Token転送仕様](https://solana.com/docs/tokens/basics/transfer-tokens)

閉鎖後のPDA再初期化やID再利用でnullifier保護を失わない。共用escrowの会計不変条件は `vaultのUSDC残高 ≥ 未決済deposit総額`、各closeでは `利用者支払＋treasury支払=D` とする。すべてmicro-USDC整数で比較する。

current root競合は原仕様に従ってpath/proofを更新してretryする。必須のv0 bufferと実証後の追加inline経路のいずれでも、証明検証、leaf置換、状態更新、送金は一つの原子的遷移にする。

出典：[Vault](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/contracts/src/ZkApiVault.sol)、[Deploy script](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/demo/contracts/script/Deploy.s.sol)

## 7. サービス・SDK・運用を初期スコープに含める

既存Rust/Axum server、Arkworks prover、WASM wallet、Go clientdは再利用を基本とする。EVM RPC、wallet provider、送信・finality、asset/quote、event pollerをadapter化する。暗号・状態機械を維持し、USDC化の差分を明示する。

### proxyモードの追加設計

ユーザーが示した「第三者が既存APIをZK認可付きで提供する」という用途を初回productionの必須機能とする。現行upstreamで稼働済みの機能とは扱わず、直接接続と併存する新規adapterとして実装する。具体的な入口と復旧条件は [API仕様](specs/api-proxy.md) に固定した。

```text
利用者 → ZK認可 → 第三者のproxy → 運営側の通常API credential → API事業者
                └→ 利用量・料金計測 → USDC残高の精算
```

API事業者にはZK検証の実装を求めず、通常の認証済みAPI呼び出しを送る。事業者はproxy運営者の契約・課金主体を認識するが、ZK認可そのものから利用者の入金noteは得ない。proxyが利用者walletの署名や長期識別子をAPI認可に要求すると支払元との分離を損なうため、セッション認可をZK証明と限定credentialで行う。

| 観点 | 直接接続 | proxy |
|---|---|---|
| 通信経路 | 端末→API事業者 | 端末→proxy→API事業者 |
| 決済サーバーからの内容秘匿 | prompt/responseを送らない | proxy運営者にはprompt/responseが見える |
| 上流に必要な仕組み | 委譲可能な上限付きcredential、失効・usage照会など | 運営者用の通常APIアクセスと、計測可能な利用量 |
| 利用者の入金元との結合 | ZK認可で隠す | 同じZK認可を維持。ただし内容・IP・時刻で相関可能 |
| 料金の証拠 | 経路によって署名明細またはusage照会 | 一般APIではproxy計測を信頼。proxy署名は第三者による正当性証明にならない |

直接接続でも、事業者がZKを直接実装する必要があるとは限らない。必要なkey管理・usage機能を提供していればzkAPI側で接続できる。[OpenRouter key管理](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)

proxyは多数のAPIへ拡張できるが、任意APIへの無設定対応は約束しない。各adapterは認証、endpoint、リクエスト上限、料金・usage、streaming、cancel、timeout、再試行の副作用を定義する。利用者個人のOAuth権限が必要なAPIでは、そのサービス上の本人性まで隠せるとは扱わない。契約上の中継・再提供条件と必要権限はproviderごとに確認する。

本番設計では、ZK認可後にcap内のセッションcredentialを発行し、同時実行分も含めて予算を予約する。upstream実行前に処理ID・料金表・予約を永続化し、実行の成否が不明な処理を自動再実行して二重課金しない。プロンプト本文を通常ログや課金journalへ保存せず、監査に必要なusage・請求額・状態だけを保持する。ZK証明がAPI応答の正しさや実使用量まで証明するとは説明しない。セッション内の関連付けは許容するプライバシー境界として示す。

受入条件には、provider側の変更なしでの実API利用、上限予約の競合、切断後の精算、未知のusageの復旧、請求根拠の表示、本文を含まないログを含める。

### 通常認可の不変条件

1. 完全な認可内容・quote・proofをjournal/DBに保存してから上流発行する。
2. nullifierは全writerで一意。同一認可の再送にだけ同じ結果を返す。
3. キー発行前・返却前にオンチェーンExitNullifierを確認する。
4. 発行された可能性があるキーを、usage不明のまま無料キャンセルしない。
5. 一つの認可から二つの異なる後継状態を署名しない。
6. 複数の独立したDBを同じpoolの認可writerにしない。

DBはPostgreSQL＋poolごとのsingle-writerを採用する。proxyの並列予算予約・復旧・nullifier排他を同じtransaction基盤で扱い、元SQLiteのrecovery suiteを移植する。writer fencingと同期replicaを必須とし、active-active署名を行わない。

### Production構成

```text
Browser SDK / local clientd
        ├── Solana wallet + RPC adapter → Vault program
        ├── proof worker / native prover
        ├── Authorization API → durable nullifier/transcript store
        │                         ├── restricted signer
        │                         └── provider lease / settlement worker
        ├── short-lived provider key → inference provider
        └── limited proxy token → proxy adapters → inference provider

Solana account/event stream → durable indexer → tree APIs
Pending withdrawals + transcript store → challenger → restricted SOL signer
All services → metrics, redacted logs, backup/restore, deployment manifest
```

API、indexer、challenger、署名サービスは障害を分離する。入金時の利用開始はSolanaのfinalizedを基準とし、Ethereum版のpre-finality activationとの差をadapter仕様へ記録する。キー発行の直前確認はより新しい状態を使い、viewの遅れ・reorg・RPC不明時の動作をテストする。

データ損失後にnullifier DBを空で起動して新規発行しない。backup/restoreとfencingの復旧確認が済むまで新規発行を停止し、既存の精算・出金・challengeの復旧を優先する。

program upgradeと暗号artifactの更新は別々に管理する。元Vaultのimmutable verifier/keyに相当する固定を保ち、既存poolに対して互換性のないVKや鍵を入れ替えない。更新可能なSolana programを採用する場合、そのauthorityと変更手順はmanifest/運用仕様の明示事項にする。

## 8. AI実装用の進め方

各タスクは対象のP番号、変更するコード、受入テスト、必要な証拠を持つ。実行順序は [I01〜I12の実装計画](implementation-plan.md) が正本。以下のW01〜W08は初期の分割記録であり、proxyを含むI系列に置き換えた。test doubleはテストで使い、本番経路の代用として残さない。

| 順序 | 実装単位 | 完了の証拠 |
|---|---|---|
| W01 | upstream固定・原テスト実行・本番構成照合 | commit/artifact hash、設定差分、基準テスト結果 |
| W02 | proof/verifier・hash・address binding adapter | 同一proofの検証結果、改変負例、CU、bytes |
| W03 | USDC Vault全命令 | 原状態遷移との比較、mint/owner差し替え拒否、転送失敗時の原子性 |
| W04 | Solana indexer・transaction/recovery adapter | rebuild、rollback、blockhash期限切れ、重複送信の結果 |
| W05 | USDC quote・認可・両provider・精算 | 料金表固定、整数精算、発行競合、usage、crash recovery |
| W06 | Browser SDK・CLI/API・配布 | 実wallet、実proof、streaming、再起動、設定移行 |
| W07 | challenger・運用基盤 | 期限内challenge、復旧演習、監視、署名権限制約 |
| W08 | 全機能の統合検証・release | P01〜P31の結果、実provider試験、deployment manifest |

暗号adapter、Vault、サービスを段階的に完成させるが、完成定義はP01〜P36。proxyとAnthropic Messages互換も必須であり、P01〜P31だけで完了とはしない。

### 差分テスト

同じ抽象操作列をEthereum基準実装とSolana実装へ入力し、通貨・アドレス・transaction識別子を正規化して比較する。USDC料金計算は意図した差分として専用の期待値を使い、native価格oracleの結果との一致は要求しない。

```text
deposit → authorize → issue → usage → settle → authorize → settle → close
deposit → escape → finalize
deposit → authorize → stale_escape → challenge → latest_close
deposit → expiry → claim
reserve → upstream_timeout → restart → recover → settle
clearance と authorize の同時実行
escape と key issuance の同時実行
```

エラー時も比較対象とする。特に、未受理quoteを破棄できる条件、予約済みquoteの保持、unknown issuanceを無料にしない条件、pause対象、challenge deadlineの等号を一致させる。

最終成果には単体テストの件数だけでなく、実proof・実SVM・実providerの結果、CPU/CU/bytes、artifact hash、回復できなかった条件を含める。AIが実装したか人が実装したかで完成条件を変えない。

## 9. 引き継ぐ制約

現在の方式は単一の精算主体、逐次のnote状態更新、net settlement、challenge watcherへの運用依存を持つ。サーバーが次署名を返さない場合の資金可用性、expiryで未使用分も回収されること、管理pause、上流usage最終性、setupへの信頼を、Solanaへ移すだけで解消したとは扱わない。

これらを理由に機能を削らず、Ethereum版と同じ条件を再現・表示する。改善が必要になった場合は、原版に対する意図的な仕様差分として別途扱う。

mainnetでの稼働実績は参照元選定の根拠になる。一方、SVM上の暗号実装、USDC会計とtoken transfer、account権限、transaction復旧の正しさはSolana版で検証する。本番向け設計を進めることと、実資金を扱うデプロイを実施することは別の作業であり、本書では後者を行っていない。
