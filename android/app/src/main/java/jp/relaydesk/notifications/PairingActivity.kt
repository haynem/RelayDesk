package jp.relaydesk.notifications

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.util.Base64
import android.view.WindowManager
import android.widget.*
import org.json.JSONObject

class PairingActivity:Activity() {
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState);window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        val root=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL;setPadding(28,36,28,28) };setContentView(ScrollView(this).apply { addView(root) })
        root.addView(TextView(this).apply { text="PCと接続";textSize=24f })
        root.addView(TextView(this).apply { text="PC版の「スマートフォン接続」で共有するアカウントを選び、接続QRを作成します。カメラで読み取るか、手動接続用の情報をここに貼り付けてください。PCと同じWi-Fiが必要です。サービスのパスワードは不要です。" })
        val input=EditText(this).apply { hint="PCに表示された接続情報";minLines=5;inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;importantForAutofill=android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS };root.addView(input)
        val status=TextView(this);root.addView(status)
        intent?.data?.takeIf { it.scheme=="relaydesk"&&it.host=="pair" }?.getQueryParameter("data")?.let { encoded->runCatching { require(encoded.length<10000);String(Base64.decode(encoded,Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),Charsets.UTF_8) }.onSuccess { input.setText(it) } }
        root.addView(Button(this).apply { text="接続先を確認";setOnClickListener {
            val config=runCatching { require(input.text.length<10000);MobileClient.validate(JSONObject(input.text.toString())) }.getOrElse { status.text="接続情報の形式が正しくありません。PC版からコピーし直してください。";return@setOnClickListener }
            AlertDialog.Builder(this@PairingActivity).setTitle("このPCを信頼して接続しますか？")
                .setMessage("接続先：${config.getString("endpoint")}\n\nPCで許可した会話をこの端末内に暗号化保存します。返信の送信権限はPC側の設定に従い、送信ごとに確認します。")
                .setNegativeButton("戻る",null).setPositiveButton("接続") { _,_->
                    runCatching { MobileStore.update(this@PairingActivity){state->state.remove("snapshot");state.remove("actions");state.put("config",config)} }
                        .onSuccess { startActivity(Intent(this@PairingActivity,InboxActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));finish() }
                        .onFailure { status.text="端末の暗号化保存に失敗しました。既存データは上書きしていません。" }
                }.show()
        } })
        root.addView(Button(this).apply { text="戻る";setOnClickListener { finish() } })
    }
}
