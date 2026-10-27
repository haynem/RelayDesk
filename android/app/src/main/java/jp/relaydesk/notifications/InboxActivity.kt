package jp.relaydesk.notifications

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.WindowManager
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

private fun JSONArray.rows()=(0 until length()).mapNotNull { optJSONObject(it) }
class InboxActivity:Activity() {
    private val executor=Executors.newSingleThreadExecutor()
    private var snapshot:JSONObject?=null
    private var config:JSONObject?=null
    private var storageError=false
    private var busy=false
    private var firstResume=true
    private var accountFilter=""
    private var query=""
    private var selectedAccount=""
    private var selectedThread=""
    private lateinit var root:LinearLayout
    private lateinit var status:TextView
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState);window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        load();showInbox()
    }
    override fun onResume(){super.onResume();if(firstResume){firstResume=false;if(config!=null&&!storageError)sync()}}
    override fun onDestroy(){executor.shutdownNow();super.onDestroy()}
    private fun load(){runCatching { MobileStore.read(this) }.onSuccess { config=it.optJSONObject("config");snapshot=it.optJSONObject("snapshot");storageError=false }.onFailure { storageError=true }}
    private fun rows(name:String)=snapshot?.optJSONArray(name)?.rows()?:emptyList()
    private fun date(at:Long)=if(at>0)DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(Date(at)) else "未取得"
    private fun text(value:String,parent:LinearLayout=root,size:Float=15f):TextView=TextView(this).apply { text=value;textSize=size;setPadding(0,12,0,12);parent.addView(this) }
    private fun button(value:String,parent:LinearLayout=root,action:()->Unit)=Button(this).apply { text=value;parent.addView(this);setOnClickListener { action() } }
    private fun page(title:String){
        root=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL;setPadding(28,28,28,28) };setContentView(ScrollView(this).apply { addView(root) });text(title,size=23f)
        status=text(if(busy)"取得中…" else "")
    }
    private fun network(action:()->JSONObject,done:(JSONObject)->Unit){
        if(busy)return;busy=true;status.text="処理中…"
        executor.execute {
            val result=runCatching(action)
            runOnUiThread {
                if(isDestroyed||isFinishing)return@runOnUiThread
                busy=false
                result.onSuccess { status.text="";done(it) }.onFailure { failure->
                    status.text=when((failure as? MobileFailure)?.status){
                        401->"PCからのアクセス許可が無効です。PCで接続情報を作り直してください。保存済みの会話はキャッシュです。"
                        403->"この端末では、このアカウントまたは送信操作が許可されていません。"
                        else->"PCに接続できないか、操作を完了できませんでした。同じWi-Fi・PCの起動・接続設定を確認してください。送信を試した場合は元サービスの履歴を確認し、自動で再送しないでください。"
                    }
                }
            }
        }
    }
    private fun sync(){network({MobileClient.sync(this)}){data->snapshot=data;if(selectedThread.isNotBlank())showThread()else showInbox();status.text="PCから保存済みデータを取得しました。サービスごとの最終取得日時を確認してください。"}}
    private fun call(path:String,body:JSONObject)=MobileClient.request(config?:throw MobileFailure(),path,body)
    private fun showInbox(){
        selectedThread="";selectedAccount="";page("RelayDesk · 統合受信箱")
        if(storageError)text("保存データを復号できません。既存データは上書きしていません。")
        text("端末への最終取得：${date(snapshot?.optLong("generatedAt")?:0)}\nPC停止中・接続できない間は保存済みキャッシュを表示します。")
        val controls=LinearLayout(this).apply { orientation=LinearLayout.HORIZONTAL };root.addView(controls)
        button("PCから更新",controls){sync()};button("PCと接続",controls){startActivity(Intent(this,PairingActivity::class.java))}
        button("通知学習と優先設定"){startActivity(Intent(this,MainActivity::class.java))}
        val accounts=rows("accounts")
        if(accounts.isEmpty())text("PC版の「スマートフォン接続」から共有するアカウントを選んでください。")
        val accountIds=listOf("")+accounts.map { it.optString("id") }
        val selector=Spinner(this).apply { adapter=ArrayAdapter(this@InboxActivity,android.R.layout.simple_spinner_dropdown_item,listOf("すべてのアカウント")+accounts.map { it.optString("name")+" · "+it.optString("service") });setSelection(accountIds.indexOf(accountFilter).coerceAtLeast(0)) };root.addView(selector)
        val search=EditText(this).apply { hint="会話名・保存済み本文を検索";setSingleLine();setText(query);importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO };root.addView(search)
        val list=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL };root.addView(list)
        fun draw(){
            list.removeAllViews();val term=query.trim().lowercase()
            val matched=rows("messages").filter { it.optString("text").lowercase().contains(term) }.map { it.optString("accountId")+"\u0000"+it.optString("threadId") }.toSet()
            val threads=rows("threads").filter { (accountFilter.isEmpty()||it.optString("accountId")==accountFilter)&&(term.isEmpty()||it.optString("title").lowercase().contains(term)||matched.contains(it.optString("accountId")+"\u0000"+it.optString("id"))) }.sortedByDescending { it.optLong("updatedAt") }
            text("${threads.size}会話",list)
            for(thread in threads){
                val account=accounts.find { it.optString("id")==thread.optString("accountId") }
                button(thread.optString("title")+"\n"+(account?.optString("name")?:"")+" · "+date(thread.optLong("updatedAt")),list){
                    selectedAccount=thread.optString("accountId");selectedThread=thread.optString("id")
                    executor.execute { runCatching { MobileStore.action(this,selectedAccount,selectedThread,"view") } };showThread()
                }
            }
        }
        selector.onItemSelectedListener=object:AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent:AdapterView<*>?){}
            override fun onItemSelected(parent:AdapterView<*>?,view:View?,position:Int,id:Long){accountFilter=accountIds[position];draw()}
        }
        search.addTextChangedListener(object:TextWatcher{override fun beforeTextChanged(s:CharSequence?,start:Int,count:Int,after:Int){};override fun onTextChanged(s:CharSequence?,start:Int,before:Int,count:Int){query=s.toString();draw()};override fun afterTextChanged(s:Editable?){} })
        draw()
        button("この端末の接続と会話データを削除"){
            AlertDialog.Builder(this).setMessage("この端末の接続情報・会話キャッシュ・アプリ内の行動記録を削除します。PCや元サービスのデータは削除しません。")
                .setNegativeButton("戻る",null).setPositiveButton("端末内のデータを削除"){_,_->MobileStore.clear(this);config=null;snapshot=null;storageError=false;showInbox()}.show()
        }
    }
    private fun showThread(){
        val thread=rows("threads").find { it.optString("accountId")==selectedAccount&&it.optString("id")==selectedThread }
        if(thread==null){showInbox();return}
        val account=rows("accounts").find { it.optString("id")==selectedAccount }
        page(thread.optString("title"));button("受信箱に戻る"){showInbox()};button("PCから更新"){sync()}
        text("${account?.optString("name")} · 最終取得 ${date(account?.optLong("lastSync")?:0)}"+(if(account?.optBoolean("error")==true)"\nこのサービスの取得に未解決のエラーがあります。" else ""))
        val messages=rows("messages").filter { it.optString("accountId")==selectedAccount&&it.optString("threadId")==selectedThread }.sortedBy { it.optLong("ts") }
        text("保存済み ${messages.size}件（最大300件を表示）")
        for(message in messages.takeLast(300)){
            text((if(message.optBoolean("isMe"))"自分"else message.optString("sender"))+" · "+date(message.optLong("ts")))
            text(message.optString("text"))
            for(attachment in message.optJSONArray("attachments")?.rows()?:emptyList())text("添付：${attachment.optString("name")}（${attachment.optString("kind")}）\nこの版では添付ファイルのダウンロードに未対応です。")
        }
        val reply=EditText(this).apply { hint="返信案を入力";minLines=3;importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO };root.addView(reply)
        button("返信案をPCに保存（まだ送信しない）"){
            val body=reply.text.toString();if(body.isBlank()||body.length>10000){status.text="返信案は1〜10000文字で入力してください。";return@button}
            val accountId=selectedAccount;val threadId=selectedThread
            network({val result=call("/mobile/v1/drafts",JSONObject().put("accountId",accountId).put("threadId",threadId).put("text",body));MobileStore.action(this,accountId,threadId,"draft");result}){reply.setText("");sync()}
        }
        for(draft in rows("drafts").filter { it.optString("accountId")==selectedAccount&&it.optString("threadId")==selectedThread }){
            val state=draft.optString("status")
            text("返信案 · "+when(state){"sent"->"送信済み";"uncertain"->"送信結果を元サービスで確認してください。自動再送しません。";"sending"->"送信中";else->"未送信"}+"\n"+draft.optString("text"))
            if(state=="pending"&&snapshot?.optBoolean("sendAllowed")==true&&account?.optBoolean("canSend")==true)button("宛先と本文を確認して送信") { prepare(draft.optString("id")) }
        }
        if(snapshot?.optBoolean("sendAllowed")!=true)text("この端末では送信を許可されていません。返信案はPC側で確認・承認できます。")
        else if(account?.optBoolean("canSend")!=true)text("このサービスの送信機能は未対応または設定が未完了です。")
    }
    private fun prepare(id:String){
        network({call("/mobile/v1/prepare-send",JSONObject().put("draftId",id))}){prepared->
            val preview=prepared.getJSONObject("preview")
            AlertDialog.Builder(this).setTitle("この1件を送信しますか？")
                .setMessage("接続：${preview.optString("account")}\n宛先：${preview.optString("recipient")}\n\n${preview.optString("text")}")
                .setNegativeButton("戻る",null).setPositiveButton("この内容の送信を承認") { _,_->
                    network({call("/mobile/v1/approve-send",JSONObject().put("draftId",id).put("challenge",prepared.getString("challenge")).put("explicitConfirmation",true))}){
                        val account=selectedAccount;val thread=selectedThread;executor.execute { runCatching { MobileStore.action(this,account,thread,"sent") } };sync()
                    }
                }.show()
        }
    }
}
