# Discord個人DMの接続条件（2026-10-27確認）

当初要件の「本人の既存DMを共通形式へ取り込む」は未達成。Bot用の会話取得を個人DM取得として数えない。

## 公式の接続候補

- OAuth2の `dm_channels.read` はDM・グループDMの情報向けで、承認済みパートナー限定。OAuthのスコープ表では `rpc` も承認済みパートナー向けとされる一方、RPCの資料には未承認アプリ向けの最大50人の開発テスター制度がある。開発時の許可と全DMへの権限を混同しない。`messages.read` はローカルRPC用の権限であり、一般のOAuth認証を追加するだけで本人の全メッセージを取得できる意味ではない。
- Social SDKには個人DMの送受信・会話サマリー・履歴APIがある。ただし履歴は最大200件かつ72時間、双方が同じゲームを利用していることが条件。既存の全DMを対象とする統合受信箱への一般的な代替にはできない。
- 現状の公式Bot API接続は、Botの権限があるチャンネルのデータ向け。本人の全DMではない。
- 元の公式Web画面は利用できるが、そこを開けることを共通受信箱への個人DM統合の完了とは扱わない。Discordの個人ログイントークンを取得・保存する仕組みは用意しない。

## 開発の扱い

本人は「当初どおり、Discord個人DMも統合できるまで完成扱いしない」と回答した。適用可能な接続方式で個人DMを統合できるまでPC版全体を完成扱いにしない。元の公式画面を開くだけで、この条件を満たしたとは扱わない。

本人が公式画面でRelayDesk Privateアプリを作成し、規約同意と本人確認を完了した。こちらは登録後の一般情報・テスター・OAuth設定を閲覧した。秘密のリセット、テスター招待、権限付与、第三者への申請送信はしていない。公式OAuthコード交換・更新、Windows名前付きパイプのRPC、指定会話のGET_CHANNEL本文取り込みコードを追加した。未承認アプリの権限許可、全DMの自動列挙、全履歴、本人送信は別途解決が必要。

## 一次資料

- [Discord RPC — IPC and approved testers](https://docs.discord.com/developers/topics/rpc)
- [Discord OAuth2 scopes](https://docs.discord.com/developers/topics/oauth2)
- [Social SDK — DM history and limitations](https://docs.discord.com/developers/discord-social-sdk/development-guides/sending-direct-messages)
- [Social SDK — communication features and development limits](https://docs.discord.com/developers/discord-social-sdk/core-concepts/communication-features)
