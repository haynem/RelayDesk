package jp.relaydesk.notifications

import android.app.Activity
import android.app.AlertDialog
import android.os.Bundle
import android.provider.Settings
import android.content.Intent
import android.widget.*
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private val packages = linkedMapOf("jp.naver.line.android" to "LINE", "com.instagram.android" to "Instagram", "com.facebook.orca" to "Messenger", "com.Slack" to "Slack", "com.google.android.gm" to "Gmail", "com.microsoft.office.outlook" to "Outlook", "com.discord" to "Discord")
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); show() }
    private fun text(value: String) { root.addView(TextView(this).apply { text=value; textSize=15f; setPadding(0,15,0,15) }) }
    private fun button(label: String, action: () -> Unit) { root.addView(Button(this).apply { text=label; setOnClickListener { action() } }) }
    private fun show() {
        root=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(30,35,30,35) }
        setContentView(ScrollView(this).apply { addView(root) })
        text("RelayDesk · 通知学習の試作")
        button("統合受信箱を開く") { startActivity(Intent(this,InboxActivity::class.java)) }
        text("許可したアプリの通知本文・時刻・消去理由を、この端末内に暗号化保存します。保存は最大14日・500件です。機密コードは除外しますが検出は完全ではありません。元アプリの通知をオンのまま利用してください。通知の抑制・送信・外部転送は行いません。")
        button("通知アクセス設定を開く") { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        val prefs=getSharedPreferences("learning",MODE_PRIVATE)
        for((pkg,name) in packages) {
            root.addView(CheckBox(this).apply { text="$name を観測"; isChecked=prefs.getBoolean("app:$pkg",false); setOnCheckedChangeListener { _,checked -> prefs.edit().putBoolean("app:$pkg",checked).apply() } })
            root.addView(CheckBox(this).apply { text="$name を常に優先（このアプリ内の評価）"; isChecked=prefs.getBoolean("priority:$pkg",false); setOnCheckedChangeListener { _,checked -> prefs.edit().putBoolean("priority:$pkg",checked).apply() } })
        }
        val keywords=EditText(this).apply { hint="優先キーワード（カンマ区切り）"; setText(prefs.getString("keywords","")) };root.addView(keywords)
        button("優先キーワードを保存") { prefs.edit().putString("keywords",keywords.text.toString().take(500)).apply(); Toast.makeText(this,"保存しました。以後の通知から反映します",Toast.LENGTH_SHORT).show() }
        button("通知履歴と評価理由を表示") { history() }
        button("観測履歴をすべて削除") { AlertDialog.Builder(this).setMessage("この端末の通知学習履歴を削除しますか？").setPositiveButton("削除") { _,_ -> EventStore.clear(this);show() }.setNegativeButton("戻る",null).show() }
    }
    private fun history() {
        val data=runCatching { EventStore.read(this) }.getOrElse { Toast.makeText(this,"履歴を復号できません。上書きせず停止しました",Toast.LENGTH_LONG).show();return }
        root.removeAllViews();text("保存済みの通知 ${data.length()}件")
        text("タップはAndroidがREASON_CLICKを通知した場合だけ計測。消去は確認済みを意味しません。展開回数・すべてのタップ・他アプリ内返信は取得できません。")
        button("設定に戻る") { show() }
        val rows=(0 until data.length()).map { data.getJSONObject(it) }
        for(row in rows.takeLast(100).reversed()) {
            text("${row.optString("package")} · ${row.optString("channel")}\n${row.optString("title")}\n${row.optString("text")}\n重要度 ${row.optString("level")} / ${row.optInt("score")}\n${row.optString("reasons")}\n更新 ${row.optInt("updates")}回・消去理由 ${row.optInt("reason",-1)}\n識別 ${row.optString("identityConfidence")}")
            button("このアプリ内で確認したと記録") {
                EventStore.mutate(this) { saved -> saved.lastOrNull { it.optString("key")==row.optString("key") && it.optLong("firstAt")==row.optLong("firstAt") }?.put("viewedInApp",true) }
                Toast.makeText(this,"アプリ内確認を記録。通知タップとは別の指標です",Toast.LENGTH_SHORT).show()
            }
            val stats=EventStore.stats(rows,row.optString("subject"))
            if(stats.count>=20 && stats.days>=7 && stats.dismissed.toDouble()/stats.count>.8 && stats.opened.toDouble()/stats.count<.1 && stats.viewed==0) {
                val suggestion="${stats.days.toInt()}日 / ${stats.count}件中、タップ確認 ${stats.opened}件・消去 ${stats.dismissed}件。通知設定を見直しますか？（同じ送信者と断定できない場合はアプリ・チャンネル単位）"
                val prefs=getSharedPreferences("learning",MODE_PRIVATE);val subject=row.optString("subject")
                if(!prefs.getBoolean("hide:$subject",false)) button("整理提案の理由を見る") {
                    AlertDialog.Builder(this).setMessage(suggestion).setPositiveButton("設定を開く") { _,_ -> startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE,row.optString("package"))) }
                        .setNeutralButton("今後表示しない") { _,_ -> prefs.edit().putBoolean("hide:$subject",true).apply() }.setNegativeButton("今回は見送る",null).show()
                }
            }
        }
    }
}
