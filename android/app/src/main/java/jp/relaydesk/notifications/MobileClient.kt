package jp.relaydesk.notifications

import android.content.Context
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URI
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

class MobileFailure(val status:Int=0):Exception("Mobile request failed")
object MobileClient {
    fun validate(config:JSONObject):JSONObject {
        require(config.getInt("version")==1)
        val endpoint=URI(config.getString("endpoint"))
        require(endpoint.scheme=="https" && !endpoint.host.isNullOrBlank() && endpoint.userInfo==null && endpoint.query==null && endpoint.fragment==null && (endpoint.path.isNullOrEmpty()||endpoint.path=="/"))
        require(config.getString("token").matches(Regex("[a-fA-F0-9]{64}")))
        require(config.getString("fingerprint").matches(Regex("[a-fA-F0-9]{64}")))
        return config
    }
    fun request(config:JSONObject,path:String,body:JSONObject?=null):JSONObject {
        validate(config);require(path in listOf("/mobile/v1/snapshot","/mobile/v1/drafts","/mobile/v1/prepare-send","/mobile/v1/approve-send"))
        val expected=config.getString("fingerprint").lowercase().chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val trust=object:X509TrustManager {
            override fun getAcceptedIssuers():Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain:Array<out X509Certificate>?,authType:String?) { throw java.security.cert.CertificateException("Client certificate unsupported") }
            override fun checkServerTrusted(chain:Array<out X509Certificate>?,authType:String?) {
                val cert=chain?.firstOrNull()?:throw java.security.cert.CertificateException("Missing certificate")
                cert.checkValidity()
                if(!MessageDigest.isEqual(expected,MessageDigest.getInstance("SHA-256").digest(cert.encoded)))throw java.security.cert.CertificateException("Paired certificate mismatch")
            }
        }
        val ssl=SSLContext.getInstance("TLS").apply { init(null,arrayOf<TrustManager>(trust),null) }
        val connection=URI(config.getString("endpoint")).resolve(path).toURL().openConnection() as HttpsURLConnection
        connection.sslSocketFactory=ssl.socketFactory
        // The default hostname verifier still checks the paired certificate's SAN.
        connection.instanceFollowRedirects=false;connection.connectTimeout=15000;connection.readTimeout=30000
        connection.setRequestProperty("Authorization","Bearer "+config.getString("token"))
        connection.setRequestProperty("Accept","application/json")
        try {
            if(body!=null){connection.requestMethod="POST";connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json; charset=utf-8");connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }}
            val code=connection.responseCode;if(code !in 200..299)throw MobileFailure(code)
            val output=ByteArrayOutputStream()
            connection.inputStream.use { input->val buffer=ByteArray(8192);while(true){val n=input.read(buffer);if(n<0)break;if(output.size()+n>35*1024*1024)throw MobileFailure(413);output.write(buffer,0,n)} }
            return JSONObject(output.toString("UTF-8"))
        }finally{connection.disconnect()}
    }
    @Synchronized fun sync(context:Context):JSONObject {
        val config=MobileStore.read(context).optJSONObject("config")?:throw MobileFailure()
        val snapshot=request(config,"/mobile/v1/snapshot")
        MobileStore.update(context){it.put("snapshot",snapshot)}
        return snapshot
    }
}
