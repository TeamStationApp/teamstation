package app.teamstation.speedy.core

import java.net.URI

/**
 * What a UI test may tell a running TS Speedy through `tsspeedy://test/<command>?…`. The app acts
 * on these only when it was launched with the `uiTest` extra.
 */
sealed class ControlCommand {
    /** A reading, exactly as the radar delivers one. Zero is "no reading" for that side. */
    data class RadarFeed(val pitch: Int, val exit: Int) : ControlCommand()

    /** A pitch-only reading, then an exit-only reading [gapMs] later, timed inside the app. */
    data class RadarSequence(val pitch: Int, val exit: Int, val gapMs: Long) : ControlCommand()

    /** Clears the board, the waiting pitch and the speech log. */
    data object Reset : ControlCommand()

    companion object {
        const val SCHEME = "tsspeedy"

        fun parse(link: String): ControlCommand? {
            val uri = runCatching { URI(link) }.getOrNull() ?: return null
            if (!uri.scheme.equals(SCHEME, ignoreCase = true) || !uri.host.equals("test", ignoreCase = true)) return null
            val query = uri.rawQuery.orEmpty().split("&").mapNotNull { pair ->
                val parts = pair.split("=", limit = 2)
                val value = parts.getOrNull(1)?.toIntOrNull() ?: return@mapNotNull null
                parts[0] to value
            }.toMap()
            return when (uri.path.orEmpty().trim('/').lowercase()) {
                "radar-feed" -> RadarFeed((query["pitch"] ?: 0).coerceAtLeast(0), (query["exit"] ?: 0).coerceAtLeast(0))
                "radar-sequence" -> {
                    val gap = query["gapMs"]?.takeIf { it >= 0 } ?: return null
                    RadarSequence((query["pitch"] ?: 0).coerceAtLeast(0), (query["exit"] ?: 0).coerceAtLeast(0), gap.toLong())
                }
                "reset" -> Reset
                else -> null
            }
        }

        /** Whether a launch's `uiTest` extra, a Boolean or a String, asks for a UI test. */
        fun isUITest(extra: Any?): Boolean = when (extra) {
            is Boolean -> extra
            is String -> extra.lowercase() in setOf("true", "1", "yes")
            else -> false
        }
    }
}
