# Sendy調査記録

調査日：2026-10-27 JST。インストール済みアプリとコードを読み取った。既存アプリを起動して認証したり、設定・アカウント・本文保存領域を書き換えたりしていない。抽出した配布コードは作業用 `work/sendy-reference/` に限定し、このリポジトリに入れていない。

## 環境・存在確認

| 対象 | 結果 |
| --- | --- |
| Windows開発環境 | Node.js 24.16.0、npm 11.13.0、Git 2.54.0 |
| Java | JRE 1.8.0_461。JDK 17/Android SDK/adbは見つからず |
| Sendy実行ファイル | `%LOCALAPPDATA%\Programs\Sendy\Sendy.exe` 存在 |
| Electron ASAR | `%LOCALAPPDATA%\Programs\Sendy\resources\app.asar`、43,118,047 bytes |
| ASAR SHA256 | `54BE0617335BAC12FFA3CAAF6DCC6ED48D4778C36AA5E509F7A789E63482ACD0` |
| 配布コードのバージョン | package.jsonで `reply-desk` / `0.2.106` / private:true |
| MCPブリッジ | resources/mcp-stdio-bridge.mjs、存在、2,081 bytes |
| 保存先 | コードがpackaged版で `%APPDATA%\Sendy` に設定。実ディレクトリも存在 |
| 会話DB | この保存先配下に `.sqlite` は見つからず。別保存先指定の可能性までは否定しない |
| API | 調査時、TCP 8765のlistenとSendyプロセスは見つからず。API動作検証は未実施 |

## コード上の証拠

以下のファイル名はASAR内の相対パス。ビルド済みコードを読んだことを示し、本人のアカウントで動作したことを示さない。

| 確認内容 | ファイル・識別子 |
| --- | --- |
| LINE接続ライブラリ | package.json：`@evex/linejs` → `@jsr/evex__linejs@3.2.1`。`dist/main/chunks/LineConnector-ok9uPefI.js` の動的import |
| LINE既読更新の分離 | 同ファイル `markRead(thread, relay=false)`。relayが偽ならreturn、真なら `talk.sendChatChecked` |
| Instagram | `InstagramConnector-rksQdYcv.js`, `InstagramPageFetcher-CxCwvRQ7.js`。内部APIによる取得とmarkReadを分離 |
| Messengerブリッジ | `BridgeManager-iYQZ3CEJ.js` 内で `mautrix-meta`, `conduwuit` をプロセス管理 |
| メール | `EmailConnector-Cxc-akg7.js`, `SmtpClient-CynTcL6b.js`。IMAP接続とSMTP送信の処理が存在 |
| 既読モード | `dist/main/index.js` の `read-receipt-mode` と `on-send / never / always`、`ReadReceiptRelay-D-hyc9k3.js` のonOpen/onSend |
| Slack・Discord | index.jsのプロバイダーカタログでtransportがwebview。Slackのコード断片の存在を、完全なAPI統合の証拠とは扱わない |
| 共通保存 | `Db-C6kb-tql.js`：accounts / threads / messages_cache / messages_fts / connections、アカウント込みの複合キー |
| MCPツール | `McpCore-B_nBBcjO.js`：list_accounts/list_threads/get_messages/list_members/search/send_reply |
| MCP返信 | send_replyはstageSendへ渡す承認待ち登録。名称だけで実送信と解釈しない |
| MCP参加者 | complete/sourceを返し、不完全な発言者一覧と全名簿を区別 |
| HTTP MCP | `McpServer-Ct34tWqH.js`：127.0.0.1 bind、Bearer、Host/Origin検査、権限とレート上限 |
| stdioブリッジ | JSON-RPCを `/mcp` に転送。`SENDY_MCP_TOKEN` が必要 |

## 公開資料との比較

[配布リポジトリ](https://github.com/tkimurabusiness-debug/sendy-download)を確認。完全な開発用ソースがあるとは扱っていない。[製品ページ](https://stockvalue.co.jp/products/sendy/)と[llms.txt](https://stockvalue.co.jp/products/sendy/llms.txt)はWeb取得ツールで失敗したため、PowerShellのHTTPS取得でHTTP 200を確認した。llms.txtは0.2.125時点のmacOS向け製品情報を記載し、Slack/Discordを元画面表示として区別している。インストール済みWindowsコード0.2.106と公開説明の版・OSが異なる。公開説明の全機能がこの配布物で動いたとは報告しない。

## 今回の再利用判断

Sendyを別の認証付き読み取りアダプターとして扱い、既存のプロバイダー接続を再利用できる入口を作った。MCPの会話・本文を共通モデルに変換する独立実装であり、Sendyのコードそのものは成果物へコピーしていない。アカウント込みのキーと既読処理の分離を設計に反映した。

直接のコネクタコードの移植は、ライブラリ依存・Electronへの結合・既存データ破損リスクを確認してから進める。ユーザーの私的再利用許可と第三者再配布の許可は区別し、公開・再配布・Sendyアップデート・本人の保存領域への書き込みは実施しない。

## 未検証

実認証、履歴取得、復帰同期、実送信、相手側の既読、LINE暗号化鍵の互換性、Messengerブリッジ起動、Slack/Discordの本文取得範囲、通常ChatGPTからの接続。ローカル8765が起動していないため、APIが成功したとも報告しない。
