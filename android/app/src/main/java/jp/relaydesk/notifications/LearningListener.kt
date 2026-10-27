package jp.relaydesk.notifications

import android.app.Notification
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.security.MessageDigest

class LearningListener : NotificationListenerService() {
    private fun digest(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    override fun onListenerConnected() {
        // Reconnection snapshots do not imply a fresh delivery; firstAt is the observation time.
        activeNotifications?.forEach { onNotificationPosted(it) }
    }
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        val prefs = getSharedPreferences("learning",MODE_PRIVATE)
        if (sbn.packageName == packageName || !prefs.getBoolean("app:${sbn.packageName}",false)) return
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val id = digest(sbn.key)
        val extras = sbn.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        // Conservative exclusion BEFORE writing or scoring. An updated sensitive episode erases its old row too.
        if (Scoring.sensitive("$title $text") || (title.isBlank() && text.isBlank())) {
            runCatching { EventStore.mutate(this) { rows -> rows.removeAll { it.optString("key") == id } } }
            return
        }
        val channel = sbn.notification.channelId.orEmpty()
        val shortcut = sbn.notification.shortcutId
        // Titles are never an identity key. No stable conversation ID -> package/channel aggregate.
        val subject = digest("${sbn.packageName}|$channel|${shortcut ?: "unknown-conversation"}")
        runCatching { EventStore.mutate(this) { rows ->
            val now = System.currentTimeMillis()
            val existing = rows.lastOrNull { it.optString("key")==id && !it.has("removedAt") }
            val stats = EventStore.stats(rows,subject)
            val result = Scoring.evaluate("$title $text",stats,prefs.getBoolean("priority:${sbn.packageName}",false),prefs.getString("keywords","").orEmpty().split(","))
            val row = existing ?: JSONObject().put("key",id).put("subject",subject).put("package",sbn.packageName).put("channel",channel)
                .put("firstAt",now).put("postedAt",sbn.postTime).put("firstElapsed",SystemClock.elapsedRealtime()).put("updates",-1)
            row.put("title",title.take(300)).put("text",text.take(2000)).put("lastAt",now).put("updates",row.optInt("updates")+1)
                .put("score",result.score).put("level",result.level).put("reasons",result.reasons.joinToString(" / "))
                .put("identityConfidence",if(shortcut!=null)"shortcut" else "package-channel-only")
            if (existing==null) rows.add(row)
        } }
    }
    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap, reason: Int) {
        val id = digest(sbn.key)
        runCatching { EventStore.mutate(this) { rows ->
            rows.lastOrNull { it.optString("key")==id && !it.has("removedAt") }?.let { row ->
                row.put("removedAt",System.currentTimeMillis()).put("reason",reason)
                // Wall-clock duration also works after reboot; accuracy is not asserted for clock changes.
                row.put("reactionMs",(System.currentTimeMillis()-row.optLong("firstAt")).coerceAtLeast(0))
            }
        } }
    }
}
