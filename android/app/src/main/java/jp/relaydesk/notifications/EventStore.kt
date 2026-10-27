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

/** Never exports notification bodies. Bounded retention: 14 days / 500 episodes. */
object EventStore {
    private const val alias = "relaydesk-notification-v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "notifications.enc"))
    @Synchronized fun read(context: Context): JSONArray {
        val file = file(context)
        if (!file.baseFile.exists()) return JSONArray()
        val bytes = file.openRead().use { it.readBytes() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONArray(String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)), Charsets.UTF_8))
    }
    @Synchronized fun mutate(context: Context, update: (MutableList<JSONObject>) -> Unit) {
        val data = read(context)
        val rows = (0 until data.length()).map { data.getJSONObject(it) }.toMutableList()
        update(rows)
        val cutoff = System.currentTimeMillis() - 14L*24*60*60*1000
        val retained = rows.filter { it.optLong("firstAt") >= cutoff }.takeLast(500)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE,key()) }
        val bytes = cipher.iv + cipher.doFinal(JSONArray(retained).toString().toByteArray(Charsets.UTF_8))
        val target = file(context); val out = target.startWrite()
        try { out.write(bytes); target.finishWrite(out) } catch (e: Exception) { target.failWrite(out); throw e }
    }
    @Synchronized fun clear(context: Context) { file(context).delete() }
    fun stats(rows: List<JSONObject>, subject: String): Stats {
        val matched = rows.filter { it.optString("subject") == subject }
        val oldest = matched.minOfOrNull { it.optLong("firstAt") } ?: System.currentTimeMillis()
        return Stats(matched.size, matched.count { it.optInt("reason",-1)==1 }, matched.count { it.optInt("reason",-1) in listOf(2,3) }, matched.count { it.optBoolean("viewedInApp") },
            (System.currentTimeMillis()-oldest).toDouble()/86400000.0,
            matched.count { it.optInt("reason",-1)==1 && it.optLong("reactionMs",Long.MAX_VALUE)<120000 })
    }
}
