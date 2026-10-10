package app.teamstation.cameraman.eventcontrol

import java.text.BreakIterator
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.ResolverStyle

internal enum class EventAssignmentProblem {
    EmptyGameId,
    GameIdTooLong,
    UntrimmedGameId,
    EmptyTitle,
    TitleTooLong,
    UntrimmedTitle,
    BadStartAt;

    val wireName: String get() = name.replaceFirstChar { it.lowercaseChar() }
}

internal class EventAssignmentException(val problem: EventAssignmentProblem) : Exception(problem.wireName)

/**
 * What a Director assigns: the selected game's own ID, which is the only destination and is never
 * shown, plus the title and start time the apps already display for it.
 */
internal data class EventAssignment(
    val gameId: String,
    val title: String,
    /** Exactly `YYYY-MM-DDTHH:MM:SSZ`. */
    val startAt: String
) {
    companion object {
        /**
         * An assignment exactly as received, refused unless already canonical: non-empty, within
         * its byte limits, trimmed, and a real UTC start time to the second.
         */
        fun fromWire(gameId: String, title: String, startAt: String): EventAssignment {
            if (gameId.isEmpty()) throw EventAssignmentException(EventAssignmentProblem.EmptyGameId)
            if (byteLength(gameId) > EventControlProtocol.MAX_GAME_ID_BYTES) {
                throw EventAssignmentException(EventAssignmentProblem.GameIdTooLong)
            }
            if (trimmed(gameId) != gameId) throw EventAssignmentException(EventAssignmentProblem.UntrimmedGameId)
            if (title.isEmpty()) throw EventAssignmentException(EventAssignmentProblem.EmptyTitle)
            if (byteLength(title) > EventControlProtocol.MAX_TITLE_BYTES) {
                throw EventAssignmentException(EventAssignmentProblem.TitleTooLong)
            }
            if (trimmed(title) != title) throw EventAssignmentException(EventAssignmentProblem.UntrimmedTitle)
            if (parseStartAt(startAt) == null) throw EventAssignmentException(EventAssignmentProblem.BadStartAt)
            return EventAssignment(gameId, title, startAt)
        }

        /**
         * The Director-side builder, for the shared vectors: game ID and title trimmed, an empty or
         * over-long game ID refused (never shortened), a title over 256 bytes cut at the last whole
         * character that fits, the start time written to the second.
         */
        fun build(gameId: String, title: String, startAtMs: Long): EventAssignment {
            val id = trimmed(gameId)
            if (id.isEmpty()) throw EventAssignmentException(EventAssignmentProblem.EmptyGameId)
            if (byteLength(id) > EventControlProtocol.MAX_GAME_ID_BYTES) {
                throw EventAssignmentException(EventAssignmentProblem.GameIdTooLong)
            }
            var label = trimmed(title)
            if (label.isEmpty()) throw EventAssignmentException(EventAssignmentProblem.EmptyTitle)
            if (byteLength(label) > EventControlProtocol.MAX_TITLE_BYTES) {
                val characters = graphemes(label).toMutableList()
                while (byteLength(label) > EventControlProtocol.MAX_TITLE_BYTES) {
                    characters.removeAt(characters.lastIndex)
                    label = characters.joinToString("")
                }
                label = trimmed(label)
            }
            return EventAssignment(id, label, formatStartAt(startAtMs))
        }

        /** Trims ASCII space, tab, LF, VT, FF and CR only; a no-break space is kept. */
        fun trimmed(text: String): String = text.trim { it in BLANKS }

        /** `YYYY-MM-DDTHH:MM:SSZ`, rounded down to the second. */
        fun formatStartAt(epochMs: Long): String =
            CANONICAL.format(Instant.ofEpochSecond(Math.floorDiv(epochMs, 1000L)).atOffset(ZoneOffset.UTC))

        /** The instant a canonical start time names, or null. */
        fun parseStartAt(text: String): Instant? {
            if (!SHAPE.matches(text)) return null
            return runCatching {
                LocalDateTime.parse(text.dropLast(1), STRICT).toInstant(ZoneOffset.UTC)
            }.getOrNull()
        }

        private const val BLANKS = " \t\n\u000b\u000c\r"
        private val SHAPE = Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z""")
        private val CANONICAL = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss'Z'")
        private val STRICT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss")
            .withResolverStyle(ResolverStyle.STRICT)

        private fun byteLength(text: String): Int = EventControlBytes.utf8(text).size

        private fun graphemes(text: String): List<String> {
            val iterator = BreakIterator.getCharacterInstance()
            iterator.setText(text)
            val out = ArrayList<String>()
            var start = iterator.first()
            var end = iterator.next()
            while (end != BreakIterator.DONE) {
                out += text.substring(start, end)
                start = end
                end = iterator.next()
            }
            return out
        }
    }
}
