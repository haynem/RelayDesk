package jp.relaydesk.notifications

data class Stats(val count: Int, val opened: Int, val dismissed: Int, val viewed: Int, val days: Double, val fastOpened: Int)
data class Evaluation(val level: String, val score: Int, val reasons: List<String>)
object Scoring {
    fun sensitive(text: String) = Regex("(?i)\\b(otp|password|passcode|verification|authentication)\\b|認証|確認コード|ワンタイム|パスワード|暗証番号|\\b[0-9]{4,8}\\b").containsMatchIn(text)
    fun evaluate(text: String, stats: Stats, priority: Boolean, keywords: List<String>): Evaluation {
        if (sensitive(text)) return Evaluation("除外", 0, listOf("機密情報の可能性"))
        if (priority || keywords.any { it.isNotBlank() && text.contains(it, true) }) return Evaluation("高", 100, listOf("ユーザーの優先指定"))
        var score = 50
        val reasons = mutableListOf<String>()
        if (Regex("(?i)至急|緊急|締切|お願い|urgent|deadline").containsMatchIn(text)) { score += 25; reasons.add("依頼・緊急キーワード") }
        if (stats.count < 20 || stats.days < 7) reasons.add("観測不足のため通常評価を維持")
        else {
            if (stats.opened.toDouble() / stats.count >= 0.5) { score += 20; reasons.add("確認できたタップ率が高い") }
            if (stats.fastOpened > 0) { score += 10; reasons.add("2分以内のタップ実績") }
            if (stats.viewed > 0) { score += 10; reasons.add("統合アプリ内での確認実績") }
            if (stats.dismissed.toDouble()/stats.count > 0.8 && stats.opened.toDouble()/stats.count < 0.1 && stats.viewed == 0) { score -= 15; reasons.add("消去が多い。消去単独では低評価にしない") }
            if (stats.count/stats.days > 30 && stats.opened.toDouble()/stats.count < 0.1 && stats.viewed == 0) { score -= 20; reasons.add("大量通知かつ確認実績が少ない") }
        }
        return Evaluation(if (score >= 75) "高" else if (score < 35) "低" else "中", score.coerceIn(0,100), reasons)
    }
}
