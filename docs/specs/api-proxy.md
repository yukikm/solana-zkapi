# API・proxy・精算仕様

初回productionにはdirect OA-org、direct OpenRouter、proxyの3経路を含む。制御APIは新規 `/zkapi/v1`、モデルAPIは `/v1`。元のEthereumエンドポイントとバイト互換とは主張しない。型・path一覧は [OpenAPI](../contracts/openapi.json)、永続状態は [ledger.sql](../contracts/ledger.sql)。

## 1. クライアントから見た処理

1. 最新root/next ID/expiryに対するtree証明を生成し、walletからv0 buffer経路でUSDCを入金。finalizedのrootとnote pathを取得。
2. provider、mode、モデル集合、料金表を指定してquoteを取得。
3. request ID、control secret、proxy secretを端末CSPRNGで生成しjournalへ保存。proxy secretはproxy modeのみ。
4. quoteとcredential hashに結合したrequest proofを生成。秘密noteやwalletアドレスを制御APIへ送らない。
5. `POST /zkapi/v1/sessions` で認可。directならその初回応答だけでupstream keyを受け取る。proxyなら自分で生成したproxy tokenを使う。
6. 上限内で推論。expireまたはcloseで新規受付を止め、使用料を確定。
7. GET sessionでcharge、next commitment/anchor、blind delta、state signatureを受け取り、端末で検証してjournalを更新。
8. 次の認可またはwithdrawal。1 noteの状態を同時に2つ進めない。

### Credential

control secretとproxy secretはそれぞれ32 random bytes。base64url no-padding（43文字）で表す。hashはSHA256(raw32)、constant-time比較。

- control token：`zkc1.<request_uuid>.<secret43>`。session作成、GET/close/session recovery/operation status専用。
- proxy token：`zkp1.<request_uuid>.<secret43>`。推論専用。control endpointには使えない。
- request bodyにはhashのみ。token全体をAuthorizationヘッダーで使い、URL/query/cookieへ入れない。
- proxyはOpenAI形式ならBearer、Anthropic形式ならx-api-keyのどちらも受理できるが、両方の指定は拒否。上流へ転送せず、adapterが運営側credentialへ置換する。
- control/proxy hash、mode、request UUIDをproofに結合。盗聴したproofだけでキー再発行や精算情報を取得できない。
- credentialsを失った場合にwallet署名を要求して通常認可と入金を関連付ける復旧は提供しない。端末の暗号化backupが必要。

## 2. Quoteと認可のcanonical bytes

quoteはJSON objectとして返す。金額・時刻・version整数は10進文字列。RFC 8785 JCSでUTF-8 canonical JSONにし、署名とquote_hashを除いたQuoteBodyをSHA256してquote_hashとする。配列の順番は意味を持ち、modelsはASCII昇順・重複なし。JSONの重複key、不正UTF-8、未知fieldを拒否。JSで金額をNumber化しない。

QuoteBody：`quote_id, deployment_id, pool, mode, provider, models[], tariff_hash, cap_micro_usdc, issued_at, expires_at, session_ttl_seconds, max_concurrency, control_api_origin, inference_api_origin`。proxyはmodelsに1つだけ指定する。directは `models=["*"]` とし、providerが許すmodelを利用可能。上流キーにないmodel制限をzkAPI側だけで強制できるとは仮定しない。

mode/providerの組はdirect_oa/oa、direct_openrouter/openrouter、proxy/{openai,anthropic,openrouter}だけを許可し、catalogのendpoint/model対応と照合する。directはmodels=["*"]、proxyは単一の具体model IDを要求する。料金表のhash・計算規則は8節、署名明細は9節を正本とする。

quoteはサーバーDBへ保存し、manifestにpinされた別のEd25519 quote keyでraw quote_hash32へ署名する。これはBaby-JubJubのstate/clearance keyとは別。SDKは署名・origin・pool・料金表を検証してからproveする。quote寿命120秒、session受付は既定60秒・設定1〜300秒、proxy並列上限4が初期profile。clientdのkey reuse=0は1リクエスト後にcloseする指定で、有効期間0秒のキーを発行する意味ではない。solvency_boundはpool capと等しく、初期profileは1,000,000 micro-USDC。固定cap未満の残高は出金対象となる。

AuthorizationBody：`version:"1", deployment_id, pool, request_id, quote_hash, mode, control_secret_hash, proxy_secret_hash`。directのproxy_secret_hashはnull。これをJCS化したbytesがprotocol仕様のauthorization_bytes。promptやそのhashはこのオブジェクトに含めない。

受理順序：

1. サイズ上限16 KiB・構文・control tokenの一致・deployment・quote署名/保存値・auth tag・public inputの固定fieldを検査。
2. `(pool,N)` と `(pool,request_id)` の既存予約を照会。同一body/proof/public inputs digestなら保存済み結果を返す。異なるdigestは409。受理済み再送ではquote期限/root鮮度を再適用しない。
3. 新規のみ：quote未使用・期限内、RP.request_time=quote.issued_at、pool cap一致、RP.active_root=現在のfinalized root、state key一致、実proof検証。serverはroot不明なら503。stale rootは409で新quote/proofを作り直す。
4. primary/secondary RPCでExitNullifierを確認。存在・未確定escape観測なら拒否、状態不明なら503。commitment差の扱いはoperations仕様。
5. writerのDB transactionで既存予約を再照会し、新規のみ、ロック取得後の`clock_timestamp()`でquote期限（等号は期限切れ）、pool受付状態、quote未使用を再検査する。proof検証/RPC/ロック待ち中に期限を超えた要求を予約しない。finalized rootの観測が更新/失効していれば再照合し、不明なら503。NをAUTHとして一度だけ予約し、request transcriptとquoteの消費を同一transactionで保存。quote IDも一回だけ受理。同時処理が勝ったら2へ戻る。
6. upstream発行またはproxy有効化の直前にexitを再確認。upstream keyを返す直前にも確認。escapeが見えたら新規使用を止め、challenge workerへ予約済み証拠を渡す。

digestはSHA256(JCS(SessionCreate))。再送は全フィールドとproofを完全一致させる。受理前の再proveには新request ID/credential/quoteを使い、同じNの受理状態を先に確認する。

## 3. セッションと署名の状態機械

```text
RESERVED -> ISSUING -> ACTIVE -> DRAINING -> RECONCILING -> SIGN_PENDING -> SETTLED
              |         |                          |
              +-> ISSUANCE_UNKNOWN                 +-> provider-recovery（direct）
```

proxyはISSUINGを省略してACTIVEにできる。期限は最初のACTIVE開始時に固定。expire/closeはclose_requested=trueを永続化する冪等操作。ACTIVEならDRAININGへ進め、発行中なら発行結果を確認後にキーを返さず無効化・精算する。現在の推論結果を自動再実行しない。DRAINING後は新規operation受付不可。SETTLEDは不変。

| 遷移 | 条件 |
|---|---|
| RESERVED→ACTIVE | proxy、close未要求、exit再確認済み |
| RESERVED→ISSUING | direct、close未要求、発行intentを永続化 |
| RESERVED→RECONCILING | close要求・受付停止などで上流未発行が確定、charge=0 |
| ISSUING→ACTIVE | 上流key IDを保存、close未要求、exit再確認済み |
| ISSUING→ISSUANCE_UNKNOWN | 発行timeout/応答喪失、存在を確認できない |
| ISSUING/ISSUANCE_UNKNOWN→DRAINING | 上流key存在を確定し失効・usage確認へ。UNKNOWNから新keyを発行しない |
| ISSUING/ISSUANCE_UNKNOWN→RECONCILING | 上流の未発行が確定、charge=0 |
| ACTIVE→DRAINING | close、期限、exit観測、provider停止 |
| DRAINING→RECONCILING | 新規受付不可、direct keyの停止確認またはproxy全operationの終了/UNKNOWN |
| RECONCILING→SIGN_PENDING | usage/waiver確定、全予約解除、全operation終端、全dispatch attemptの終了/fencing確認、chargeを一意決定 |
| SIGN_PENDING→SETTLED | 保存済み対象への署名を検証・保存 |

これ以外の逆戻りを禁止し、SQL更新は旧stateを条件にしたcompare-and-setとrow lockで行う。運用停止の間も状態を消さず、同じ段階から復旧する。

DB上のN予約は解放しない。発行されなかったと確定した場合もcharge=0の後継状態を一度だけ発行し、利用者は次anchorへ進む。ISSUANCE_UNKNOWNでキーが存在しないと推測して消さない。directはupstream adapterで無効化・最終usage・削除を確認してから精算する。初回応答を失った場合、direct keyは再送しない。direct作成HTTPは初回key返却まで保持する。keyを含む初回応答完了前の接続終了、HTTP応答deadline、または202を返す場合はclose_requested=trueを永続化し、遅延発行成功はキーを返さずDRAININGへ送る。初回応答送信後のcrashで受信有無を判定できない場合も再配信しない。SDK recoverはjournalにkeyがない既存direct sessionに冪等closeを送って精算を待つ。通常のGET statusは副作用を持たない。proxyの202はACTIVEへのpollが可能。

writerはpoolごとのPostgreSQL advisory lockを専用connectionで保持。すべての変異操作はwriterへ集約し、DB transactionでsession行を `FOR UPDATE` する。DB connection/lockを失ったwriterは直ちに認可と署名を停止する。read replicaや復元途中DBから署名しない。

初版では財務transactionもそのadvisory lockを保持するconnectionで実行する。別のpool connectionからの書込みを許可して、lock接続の死活監視だけで排他を保証しない。lock取得後にwriter_epochを増やし、pool受付再開前に復旧照合する。quote/session/operation/settlement/clearance/明細の更新はこのwriter経由とし、signerやdispatcherが独自に財務行を書き換えない。外部送信の停止は別途operations仕様のfencingで検証する。

RECONCILING行をロックしたtransactionでsettlementsへINSERTし、その後同じtransaction内でSIGN_PENDINGへCASする。charge、fresh anchor、blind delta、E_nextと署名対象bytesを一度だけ保存する。state signerは別サービスで、署名対象をprimary DBから読み、同じrequestに異なるmessageを拒否する永続journalを持つ。署名者も全operation終端・予約0・dispatch attempt終了/fencingをprimaryで再確認する。署名応答はDB保存後に公開。署名直後のcrashでも同じmessageだけを再署名・取得する。署名鍵を持った複数workerを無制御に起動しない。

signer journalはledgerのrestoreと独立して保持し、`(pool,N)`を一意キーとしてAUTH/CLEARANCEの役割、AUTHのrequest ID、役割別公開鍵、署名対象bytes/digestを署名前に永続化する。request IDだけで一意化すると、古いDBへのrestore後に同じNを別request IDで二重署名できるため不可。同じキーの役割・request・message変更は拒否し、署名を保存してから返す。journalに対応するledger対象がない/異なる、または署名済みledgerにjournalがない場合は受付/署名を停止して照合する。未署名の準備済み対象にjournalがまだないことは正常で、初回intentを原子的に記録できる。既存intentに署名がなければ同じ対象だけを再署名し、journalに保存済みの署名はledgerへ回復する。消失したjournalを空で自動再作成しない。clearanceにも同じ手順を適用する。

clearance：`POST /zkapi/v1/withdraw/clearance {nullifier}`。同じ `(pool,N)` のロックでAUTHとCLEARANCEを排他化する。AUTH存在時は409、CLEARANCE済みなら同じ署名を返す。未使用NをCLEARANCEとして永久予約してから元のclearance_messageへ署名する。nullifierは秘密から導出される能力として扱い、wallet identityを要求しない。rate limitし、nullifierをアクセスログへ残さない。これは元の方式を維持するもので、別の「無条件返金」方式ではない。

## 4. Proxy operationの予約・実行・課金

推論の必須header：`Idempotency-Key: UUIDv4`。local clientdが既存アプリの代わりに生成・保持する。SDKも同様。session IDとoperation IDの組を一意にする。body hashはHMAC-SHA256(key, frame("solana-zkapi-operation-v1", [method_ascii, path_ascii, anthropic_version_ascii_or_empty, raw_body_bytes]))で、frameはprotocol仕様と同じ、key=SHA256(ASCII("zkapi-proxy-body-v1") || proxy_secret_raw32)とする。methodはPOST、pathはqueryなしの固定route、anthropic-versionはMessages/count_tokensだけで使い他は空。本文はidentity encodingのUTF-8 bytesとし、同一IDでendpoint/versionだけが変わっても競合にする。単純なprompt hashを保存しない。同じidでbyteの異なる本文は、意味が同じJSONでも競合扱い。上流credential・prompt/response本文はDBに保存しない。

```text
RESERVED -> DISPATCHING -> STREAMING -> METERED -> DONE
                    \-> USAGE_UNKNOWN -> METERED または WAIVED_OPERATOR_LOSS
```

新規operationの受付はsession行ロック下でACTIVE、close_requested=false、row lock取得後のextract(epoch from clock_timestamp()) < expires_at、quoteのprovider/model/endpoint、並列枠と予算を同時検査する。期限timerの遅延に依存しない。now()/CURRENT_TIMESTAMPはtransaction開始時刻なのでこの判定には使わない。DISPATCHINGへのCAS直前にも停止条件を検査し、close/期限後の未送信RESERVEDは0課金DONEへ進める。期限後もcontrol tokenによる既存操作の照会は可能。

非stream応答はDISPATCHING→METEREDを許可する。STREAMINGを含む送信後のusage不明はUSAGE_UNKNOWNへ進める。送信前にDBへDISPATCHINGとdispatch_attemptsを同一transactionでcommitする。送信した可能性がある状態からは、同じupstream実行の照会以外の自動retryをしない。status endpointはJSON metadataだけを返し、推論本文は復元しない。同じid/bodyの再送はrunningなら409 `operation_in_progress`、完了なら409 `response_not_replayable` とstatus URL、異なるbodyなら409 `idempotency_conflict`。既存bodyを返せないことをSDKに明示し、勝手に新IDで再実行しない。

RESERVEDのままworkerを失いDISPATCHINGが一度も保存されていないoperationは、送信されていないと確定できるため予約を解除し、charge=0のDONEへ進める。署名済みstateに関係しない監査metadataとして `not_dispatched` を残す。DISPATCHING以降の不確実性と区別する。

### 上限予約

directはOpenRouterが提供する複数modelのusage合算を維持し、tariffのpricing_basis=`provider_reported_usd`、rates=[]、model="*"とする。固定するのは1 USD=1 USDCの換算とcapで、上流事業者のtoken価格を固定する保証ではない。proxyの初版quoteは1 provider・1 model、pricing_basis=`fixed_usage_rates`とし、1つのtariff_hashで料金を一意にする。モデルを変えるときはsessionを精算して新quoteを取る。将来multi-model proxyを追加する場合はmodel→tariff hashの集合をquoteへ結合する別versionとする。

1. adapterはリクエストの入力上限、max output tokens、許可tool、料金表から最大請求額Rを求める。証明可能な上限がないパラメータは400 `unsupported_metering`。
2. session行をロックし `charged_nano + reserved_nano + R_nano <= cap_micro * 1000` を検査。額はnano-USDC（10^-9 USDC）整数で内部累積し、u128/NUMERIC(38,0)を使う。
3. Rとoperationを保存してから上流へ送る。推論完了後、実usageからCを計算し予約Rを解除。通常はC<=R。超過は利用者へ転嫁せずoperator lossに記録する。
4. 複数operationのCを合算してsession精算時に一度だけ `ceil(sum_nano / 1000)` micro-USDCへ丸める。operationごとの切上げを重ねない。合計charge<=capを再検査。

入力token count APIを使う場合は、課金対象か・使用量の上限をadapterで検証する。未検証のtokenizer推定だけで利用者へ上限超過請求しない。provider公表最大contextによる保守的予約も可能だが、その額がcapを超えたら送信前に拒否する。金額計算は料金表の整数比を使い、nanoより細かい計算結果はoperation単位でnanoへ切上げる。

初期adapterの料金項目はinput/output/cache-read/cache-write token。請求する項目がusageにない場合、通常inputとcache分を重複加算しない。未対応項目、動的価格、hosted tool feeがあるmodelはcatalogに公開しない。料金表は明示versionと有効期間を持ち、受理済みsessionでは固定する。価格変更は新quoteにだけ反映する。

### Streaming・切断・曖昧なusage

- SSEを中継し、最終usage frameまでサーバー側で読む。推論本文をログへ保存しない。
- 利用者切断は利用料0の根拠ではない。上流request IDを保持し、読取/照会でusageを確定する。キャンセルはbest effortで、請求停止を保証しない。
- 1 operationのhard deadlineは600秒、timeout後はUSAGE_UNKNOWNへ。proxyのsession受付が60秒で終わっても、既存operationは完了まで精算を待つ。
- DRAINING後、各operationは自身のDISPATCHING commit時刻から900秒以内の確定を目標とする。先に送信ownerの終了またはegress fencingを確認する。確定usageが得られないものは、operatorが失敗コストを負担する `WAIVED_OPERATOR_LOSS` としてcharge=0に固定する。未実行と判定したことにはしない。
- 失効tokenによる新規受付とoperationの再dispatchを拒否し、旧ownerの送信能力を終了/fenceした上で、後継残高を一度だけ発行する。遅れてusageが判明しても利用者の精算を変更せずoperator lossを追記する。
- fencingを確認できない場合はRECONCILINGに留めて新規受付を停止し、後継署名を保留して警告する。この場合900秒を保証しない。DBフラグの変更だけで外部送信を止めたと扱わない。
- このwaiverはproxy独自の可用性方針。上流keyを利用者に渡すdirectには自動適用しない。unknown率・lossが閾値を超えたproviderは新規受付を止める。

正常なchargeにはprovider_request_id、usage units、tariff hash、計算結果を付けて利用者が再計算できる。proxy署名は記録の改ざん検知用で、providerが実際に行った処理のZK証明ではない。

## 5. Provider adapterと互換表

Rust traitの責務を次に固定する。

```text
validate(request, catalog) -> normalized_request | unsupported
reserve_bound(request, tariff) -> nano_usdc
dispatch_once(operation_id, request, service_credential) -> stream + provider_request_id
observe_usage(stream) -> usage | unknown
lookup_usage(provider_request_id) -> usage | unavailable
cancel(provider_request_id) -> confirmed | unknown | unsupported
calculate_charge(usage, tariff) -> nano_usdc
```

direct専用traitはcreate_restricted_key/disable/read_usage/delete/verify_receipt。OA-orgの署名明細とOpenRouterの管理usageを同じ証拠レベルとして扱わない。元adapterの認証・issuer/verifier pinningを移植し、実権限で受入試験をする。

| 入口 | 上流 | 初版の対応 |
|---|---|---|
| GET /v1/models | manifest/catalog | 有効なモデルのみ、料金・対応modeはcontrol catalogで提供 |
| POST /v1/chat/completions | OpenAI / OpenRouter | text、client function calling、非stream/SSE。usageを内部で必須取得 |
| POST /v1/responses | OpenAI | text、client function calling、非stream/SSE。store=false、previous_response_id/background拒否 |
| POST /v1/messages | Anthropic | text、client tool_use/tool_result、非stream/SSE、usage/cache分類 |
| POST /v1/messages/count_tokens | Anthropic | adapterが安全な見積もりを提供できるcatalogのみ。推論同様に認証・rate limit |

count_tokensの初期利用者料金は0、予約額も0とし、呼出回数の制限を設ける。上流側に費用が生じる場合は運営負担。そこで得たtoken数を推論利用量として課金しない。

異なるprovider形式へ自動変換する万能adapterにはしない。OpenAI形式からClaudeモデルを使う経路はOpenRouter adapterで別model IDを公開する。Anthropic形式はAnthropicへnative転送する。署名ヘッダー・管理キー・cookies・転送元IP・任意upstream headersは送らない。allowlistの必要headerだけを構築する。Origin/Host検査、本文サイズ1 MiB、DNS/redirect先の固定とSSRF防止を実装する。

rate limitは匿名session/cap/IP単位。IPは短期のsalted rate-limit keyにだけ使用し、入金walletとの照合DBは作らない。IP・本文・時刻による相関可能性は残る。

## 6. SDK・clientd・Indexer

layout 2のtree更新契約は[tree-transition仕様](tree-transition.md)を正本とする。SDKはprepare/prove/verify/encodeのローカルAPIを提供し、通常のSessionCreate/request proofへtree proofやnote IDを追加しない。tree proof生成は入金・合意出金・escape開始・challenge・expiryのchain操作だけ。finalizeには不要。

config Manifestはlayout/backend/tag policy/profileと3回路のartifactを固定する。署名manifest、PK/VK hash、PoolConfig.circuit_profile_hashを照合してから利用する。必須transaction formatはv0_buffer、v1_inlineは実証済みdeploymentのみ。TreeUpdateのpublic→proof順とbuffer payload（discriminatorなし）はmachine-readableな[wire契約](../contracts/tree-transition.json)とも一致させる。

native prover/CLIを必須とし、browser workerの時間・メモリーを測る。任意のリモートworkerから受け取ったtree proofもローカルで固定VK/期待inputsを検証する。リモートworkerへ秘密noteや認可session情報を渡す必要はない。初版の必須HTTP endpointを増やして中央proverへの依存を作らない。proof生成中も状態は予約されないため、journal/競合再生成/送信不明の扱いはtree-transition §4に従う。

- SDK：createNote/deposit/awaitFinality/getQuote/authorize/openProxySession/openDirectSession/closeSession/recover/withdraw/escape/challenge-statusを提供。秘密保存は暗号化storage adapter。browser proofはworkerで実行。
- clientd：既定127.0.0.1:8787、localhost推論API、wallet管理は別credential。upstream API keyとproxy tokenを混同しない。configでmodeを明示し、暗黙にdirectからproxyへ切り替えない。
- journal：未送信、送信不明、受理、利用中、精算待ち、署名検証済みをfsync/transactionで更新。新stateを保存する前に旧stateを消さない。バックアップに部署/個人を識別するmetadataを付けない。
- indexer：finalized blockの命令順でroot/sequenceを復元。snapshotにはpool、slot、blockhash、sequence、root、next IDを含める。イベント欠落時は命令/accountから再構築し、root不一致ならpath配信を停止。
- path：Active note membership、next-note zero path、Pendingの復元用zero pathを提供。API上では公開note IDを扱うが、通常認可にnote IDを転送しない。
- Tor/SOCKS5はremote DNS・fail closed。direct/proxy/indexer/RPCの経路設定を別々に確認し、HTTPだけTor化して匿名化完了と表示しない。

`GET /zkapi/v1/nullifiers/{nullifier}` はunused/authorized/cleared/exit_consumed/unknownだけを返す。request ID、料金、proof、credential hashは返さない。rate limitを適用し、RPC失敗をunusedへ変換しない。利用者の詳細復旧はcontrol token付きsession endpointで行う。

運営ダッシュボードは別のprivate listenerで `/admin/v1/dashboard/summary`、`/recent`、`/events` を提供する。管理専用Bearer credentialとnetwork ACLを必須とし、利用者tokenでは認証しない。summaryはaggregateのsession数・失敗率・精算額・root/slot lag、recent/eventsは本文・IP・鍵を含まない状態遷移のみ。監視閲覧権限に署名・provider keyの権限を与えない。

## 7. エラー契約

control APIは `{error:{code,message,retriable,request_id,retry_after_seconds,latest_root}}`。messageにproof・token・payloadを含めない。400入力/未対応、401credential、402session budget不足、409状態競合、410期限終了、413size、429rate、503DB/RPC/provider unavailable。errorのretriable=trueは同一操作の照会/再送が可能という意味で、推論を新IDで再実行する許可ではない。

推論APIは対象providerと互換のerror envelopeを使い、内部codeをheader `X-Zkapi-Error-Code` にも返す。stream開始後は形式に対応するerror eventとclose、HTTP statusを遡って変更しない。`X-Zkapi-Operation-Id` と `X-Zkapi-Status-Url: /zkapi/v1/sessions/{request_id}/operations/{operation_id}` を成功および受理済み操作の409応答に返す。生のupstream errorにcredentialや識別情報がないことを検査する。

## 8. 料金表・usageの決定論的契約

Tariffのうちtariff_hashだけを除いたobjectをTariffBodyとし、quoteと同じJCS UTF-8 bytesのSHA256をtariff_hashとする。SDKは取得時に再計算する。ratesはunitのASCII昇順、unit重複禁止。version、日時、分子・分母はcanonical十進整数文字列で、分母は1以上、valid_from <= quote.issued_at < valid_untilを要求する。受理済みsessionでは期限後もその料金表を固定する。

unitは `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens` のみ。cache_write_tokensは単一価格のproviderにだけ使用し、5m/1hとの併用は禁止。proxyのfixed_usage_ratesはinput/outputを必須とし、課金され得るcache項目をすべて含める。directのprovider_reported_usdはproviderがoa/openrouter、model="*"、rates=[]。proxyはprovider/modelをquoteと完全一致させる。operator_fee_micro_usdcは"0"固定。

各usage count、rate分子・分母は0〜2^63−1（分母は1〜2^63−1）、rate最大6件。中間計算は任意精度整数の有理数で行い、丸めた結果はNUMERIC(38,0)以内か検査する。超過/未知のusage項目は推定請求せずunknownとして処理する。予約上限を計算できない入力は送信前拒否。

operationの観測費用は `observed_nano = ceil(Σ count_i * numerator_i / denominator_i)`。項目ごとのnano切上げは行わない。利用者負担は `min(observed_nano, reservation_nano)`、差額を運営損失にする。sessionでは利用者負担nanoだけを合算して一度microへ切上げる。For direct metering, convert the selected provider USD strings/JSON numeric lexemes to exact decimal rationals, sum across models, round USD × 10^9 upward once to nano-USDC, cap at cap_micro × 1000, then round upward to micro-USDC. Do not pass through binary floating point.

正規化usageは料金unitと同じ名前の整数count配列（ASCII順、重複なし）。usage欠落を0とは解釈しない。OpenAI系のinclusive inputからcache-read/cache-writeを差し引き、Anthropicのexclusive inputにはcache分を足し戻してinputとして再請求しない。5m/1hのwrite内訳は分離する。outputに含まれるreasoning tokenを二重計上しない。SSEの累積値を各frameで足し込まない。正確な写像、欠落が0を意味するfield、利用可能なcache区分はprovider/model/API version別adapter fixtureにpinし、未検証の区分をcatalogへ公開しない。
一次資料：[OpenAI cache usage](https://developers.openai.com/api/docs/guides/prompt-caching)、[Anthropic cache usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。外部schemaはI07で再確認し、snapshotと正常/欠落/矛盾usageのfixtureを保存する。

### Direct OpenRouter capture policy — Ethereum parity

For direct OpenRouter, the selected amount is the exact `usage + byok_usage`
management observation captured after the key is confirmed disabled and the
configured grace has elapsed. Capture that observation durably before deletion;
confirm deletion before signing the capped settlement. Missing, malformed or
unavailable usage is not zero. A failed/ambiguous deletion remains pending and
reuses the saved amount; it does not issue a replacement key or replay inference.
A finalized session is never repriced.

This follows [Ethereum zkAPI at the reviewed immutable revision](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/docs/note-bound-commitments.md#L58-L62).
The configured grace is an **operator assumption** about in-flight requests and
accounting delay. It does not establish an authoritative final provider invoice.
Delayed or unobserved cost remains the operator's risk and cannot retroactively
increase the customer's signed charge. `operator_loss_nano_usdc` measures excess
of this selected observation over the charge, not all eventual external losses.
A separately obtained late observation may use the existing operator-only
append contract; a new reconciliation service is not required for this preview.
OA's issuer-finalized receipt path and proxy metering retain their own rules.

The [parity evidence](../evidence/PD-openrouter-ethereum-parity.md) distinguishes
this selected contract from the earlier two-sample implementation and records
whether the successor has actually been deployed. Upstream's default grace and
settlement-poll intervals are 5 and 2 seconds; deployed configuration remains an
explicit operator choice, not an accounting guarantee.

## 9. 署名付き明細

`GET /zkapi/v1/sessions/{request_id}/receipts` はcontrol token認証、cursor付きの署名明細一覧。OperationStatusも終端時にはreceiptを必須とし、0課金/waiverを区別する。directはoperation_id=nullのsession明細を一件作る。本文や生provider keyは含めない。

ReceiptBodyのfieldはOpenAPIを正本とする。receipt_hash=SHA256(JCS(ReceiptBody))、署名はmanifestにpinした専用Ed25519 receipt_public_keyによるraw hash32への署名。request_id、pool、deployment、operation_id、tariff_hash、reservation_nano_usdc、provider_reported_usd、provider_request_id（未知ならnull）、usage、観測nano、利用者nano、運営損失nano、reasonと証拠区分を結合する。proxy署名は運営者の記録への署名であり、OA署名明細そのものやproviderの証明と混同しない。provider_evidence_digestは元の検証済み/観測した明細のdigestで、未取得ならnull。A metered direct receipt contains the exact selected USD total in provider_reported_usd (non-exponential canonical decimal, no unnecessary leading/trailing zeroes, at most 128 characters), usage=[], and reservation_nano_usdc=cap_micro×1000. For OpenRouter, this is the captured management observation defined below, not a provider invoice-finality assertion.proxyではprovider_reported_usd=null、reservation_nano_usdcは予約R。未発行/unknownはUSD=nullとし、0の実測と区別する。これで利用者はUSD→nano→capまたはusage×rate→Rの計算を再現できる。

billing_effect="charge"は各operation（directはsession）につき一件で不変。SETTLED前に全charge明細を署名保存し、そのcharged_nano_usdc合計とsettlementのmicro切上げ結果を照合する。unknownは観測額/損失額null、利用者額0の明細を発行する。遅延usageはbilling_effect="late_loss_observation"、利用者額0、元receipt_hashをrelated_receipt_hashへ指定した追記とし、既存明細・後継署名を変更しない。保存順のcursorで取得し、cursorは当該sessionだけで有効。署名検証・集計に必要なfieldを自由形式metadataへ隠さない。

DONE/WAIVEDの公開は署名明細の保存と同じtransactionで行う。未署名の先行明細があれば一覧cursorをその先へ進めず、後から署名された明細を取り逃さない。usageがない場合のusage配列は空で、reason/観測額nullにより実測0と区別する。
