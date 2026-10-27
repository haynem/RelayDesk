package jp.relaydesk.notifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Pairing tokens and conversation caches never enter preferences, backups or logs. */
object MobileStore {
    private const val alias="relaydesk-mobile-v1"
    private fun key():SecretKey {
        val store=KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias,null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun file(context:Context)=AtomicFile(File(context.noBackupFilesDir,"mobile.enc"))
    @Synchronized fun read(context:Context):JSONObject {
        val target=file(context);if(!target.baseFile.exists())return JSONObject()
        val bytes=target.openRead().use { it.readBytes() };require(bytes.size>=28)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,bytes.copyOfRange(0,12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)),Charsets.UTF_8))
    }
    @Synchronized fun update(context:Context,edit:(JSONObject)->Unit) {
        val state=read(context);edit(state)
        val cipher=Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key()) }
        val bytes=cipher.iv+cipher.doFinal(state.toString().toByteArray(Charsets.UTF_8))
        val target=file(context);val out=target.startWrite()
        try{out.write(bytes);target.finishWrite(out)}catch(e:Exception){target.failWrite(out);throw e}
    }
    fun action(context:Context,account:String,thread:String,kind:String) {
        update(context){state->
            val old=state.optJSONArray("actions")?:JSONArray();val next=JSONArray()
            for(i in maxOf(0,old.length()-499) until old.length())next.put(old.getJSONObject(i))
            next.put(JSONObject().put("accountId",account).put("threadId",thread).put("kind",kind).put("at",System.currentTimeMillis()))
            state.put("actions",next)
        }
    }
    @Synchronized fun clear(context:Context){file(context).delete()}
}
