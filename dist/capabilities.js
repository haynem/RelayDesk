export const pcCapabilities = {
    implementationOnly: true,
    services: [
        { name: 'LINE', read: 'QR接続・本文・未読・発言者', history: '会話ごとの追加取得', send: 'テキスト・引用', files: 'E2EEでの画像・動画・音声・ファイル送信、取得・保存', actions: 'リアクション・自分の送信取消', members: '個人DM・グループの名簿取得', receipts: 'never / on-send / always を分離', remaining: '一部の過去E2EE本文・LINE固有の操作' },
        { name: 'Instagram', read: '公式ログイン後のGraphQL取得', history: '保存されたカーソルから追加取得', send: 'テキスト・引用', files: '画像・動画・音声の送信、URL取得済み添付の保存', actions: '承認付き編集・送信取消・リアクション（対象を再取得）', members: '会話詳細を再取得して名簿を取得', receipts: 'never / on-send / always を分離', remaining: '段階的な一覧取得の完了確認・通信仕様変更・一部メディアのURL・固有操作' },
        { name: 'Messenger', read: '平文・E2EE受信処理、端末登録と暗号化鍵DB', history: '平文の追加取得・本人PINによる暗号化履歴復元', send: '平文・E2EEのテキスト・引用', files: '平文・E2EE添付の取得・送信', actions: '平文・E2EEの編集・取消・リアクション', members: '暗号化グループの名簿取得', receipts: '平文・E2EEとも既読送信を分離', remaining: '端末登録・履歴復元・実通信は今回未検証。拡張形式・古い平文グループの名簿・固有操作' },
        { name: 'Slack', read: '個人DM・グループ・参加チャンネル', history: '会話の追加取得・返信スレッド', send: 'テキスト・スレッド返信', files: '現行の外部アップロード方式・取得・保存', actions: '自分の編集・削除、リアクション', members: '会話の全参加者取得（上限あり）', receipts: 'never / on-send / always を分離', remaining: '取得制限・権限・スレッドの全件追跡・元画面の固有操作' },
        { name: 'メール', read: 'Gmail・Outlook・一般IMAP、選択フォルダー', history: 'フォルダー別に200通ずつ追加、差分500通ずつ', send: 'SMTP・新規作成・CC/BCC・全員に返信・引用', files: 'MIME添付の取得・送信・暗号化保存', actions: 'Gmail送信元の受信箱自動除外と取消（明示承認）。サーバー削除・迷惑メール報告・ブロックは別途開発', members: 'From / 取得済み発言者', receipts: '既定はEXAMINE / BODY.PEEK、明示設定時だけSeen', remaining: 'OAuthの利用者自身のアプリ登録・設定権限' },
        { name: 'Discord', read: 'Bot接続と公式OAuth/RPCによる指定会話のPC内本文取り込みコード', history: 'Bot対象の会話ごとに追加取得', send: 'Botのテキスト・引用', files: 'Bot添付の送受信・保存', actions: 'Bot自身の編集・削除、リアクション', members: '保存済みの発言者', receipts: 'ユーザーの既読を更新しない', remaining: '本人の全DM列挙・全履歴・個人送信は開発継続中。公式RPCの実際の権限許可が必要' },
    ],
    shared: ['優先度別の要確認一覧と一段階の上下修正', '横断検索・複数アカウント・ピン・ローカルフォルダー', '本文・添付の暗号化保存', '承認待ち送信と操作、結果不明時の自動再実行禁止', '端末内の閲覧・返信・後回しに基づく通知学習と整理提案', 'ChatGPT用OAuth・会話範囲の制御・任意のQuick Tunnel', '元サービス画面、本人が選ぶ通話用メディア・画面共有', '1分同期、自動再接続、取得位置と更新認証の保存、Windowsログイン時起動、任意のスリープ抑止', '固定Cloudflare接続の自動復帰とChatGPT OAuth許可の保持'],
    outstanding: ['Discord個人DM', 'Messenger E2EE連携の実動作・履歴と拡張形式の網羅', '6サービスそれぞれの固有機能の完全な網羅', 'サービス側のOAuth登録や承認', '通常ChatGPTからの実接続と最新変更の実動作確認'],
};
