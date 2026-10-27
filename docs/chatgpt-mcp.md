# ChatGPTとの接続

2026-10-27。リモートMCPのOAuth受付と任意のWindows用トンネルを実装しました。**通常ChatGPTからの接続成功は未確認です。今回はトンネルの開始も外部公開も行っていません。**

## 利用者が行う接続

1. RelayDesk「ChatGPT連携」で共有アカウントと、全会話／選択会話を指定します。既定は共有オフです。
2. Windows簡易接続を画面で承認するか、自分で管理するHTTPS転送先を設定します。簡易接続のコードはCloudflare公式ツールをGitHubから取得し、提供されたSHA-256を照合して実行します。root画面のAPIを転送先にしません。
3. カスタムMCPが利用できる本人のChatGPTで、表示されたHTTPSの /mcp URLとOAuthを設定します。本人のプラン・ワークスペース権限は未確認です。
4. ChatGPTから開いた認証画面と、PCの承認待ちの確認コードが一致することを確認します。接続名は自己申告のため、それだけで信用しません。
5. PC内で共有範囲と返信案保存の許可を承認すると、ChatGPTへ戻る構成です。実際の往復はまだ行っていません。

Quick Tunnelは試用向けでURLが変わります。停止・終了で許可を失効し、再起動で自動公開しません。継続利用には自分で管理する固定HTTPS経路を使用できます。固定Cloudflareトンネル用の設定・暗号化トークン保存・アプリ再起動時の自動復帰・通信断後の再接続を追加しました。固定ホスト名が同じAI受付へ到達することを公開のランダムな起動識別子で照合します。自動復帰は既存のOAuth許可を失効させず、明示的な停止時に失効させます。転送元・転送先の設定と本人の公開承認が必要です。通信がCloudflareを経由することを画面で説明します。[Cloudflare公式の制約](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)に従います。課金契約を自動作成しません。

## ツール

|ツール|動作|
|---|---|
|list_accounts|共有済み接続と最終同期|
|list_threads / get_messages|保存済み会話・本文|
|list_members|名簿と完全性の併記|
|search|許可済み本文の横断検索|
|list_attention|共有範囲の要確認一覧|
|page_threads / page_messages / page_search|最大200件のページ取得、日時条件、続きのoffset|
|stage_reply|追加許可がある接続だけ承認待ちへ保存|

送信・承認・編集削除・既読・設定変更のMCPツールは提供しません。私的添付URLや保管庫IDを本文応答に含めません。キャッシュの参照であり、最新化や完全履歴の保証ではありません。

## 認証の実装

別ポートの127.0.0.1受付に、保護リソース／OAuthメタデータ、DCR、S256 PKCE、PC所有者の承認、一回限りのコード、1時間のアクセストークン、30日の更新トークンとローテーション、失効を実装しました。戻り先は公式ChatGPTドメインの対応パスに限定し、resource・issuer・client・redirect・scope・期限を照合します。アクセス／更新トークンはハッシュで保管します。

毎回、接続承認時の範囲と現在の共有範囲の積集合を検査します。共有を外すと既存接続にも渡しません。[OpenAI公式認証仕様](https://developers.openai.com/plugins/build/auth)と[公式MCP資料](https://developers.openai.com/api/docs/mcp)を参照しています。

## 従来のローカルMCP

ランダムポートの /mcp とBearerキーも保持します。scripts/mcp-stdio.mjsにはRELAY_MCP_URLとRELAY_MCP_TOKENをローカルに渡します。root UIのセッション値とは別物です。このキーをChatGPTのOAuth設定に貼るものではありません。

今回のOAuth・トンネル・SDK相互運用・失効の動作検証は未実施です。以前のローカルMCPテストを今回の通常ChatGPT接続成功とは扱いません。
