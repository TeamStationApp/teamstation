package app.teamstation.speedy.core

/**
 * Which clips say a reading. Only 20 to 99 has a voice; a side outside that range is left out, and
 * a reading with nothing left to say is silent.
 *
 * A pitch alone is its falling take ("56"); an exit is its take before "exit" and the word itself
 * ("53 exit"); both together join with "and" ("56 and 52 exit").
 */
object Phrase {
    val SPEAKABLE = 20..99

    fun clips(pitch: Int?, exit: Int?): List<String> {
        val p = pitch?.takeIf { it in SPEAKABLE }
        val e = exit?.takeIf { it in SPEAKABLE }
        return when {
            p != null && e != null -> listOf("n$p-and", "word-and", "n$e-exit", "word-exit")
            p != null -> listOf("n$p-final")
            e != null -> listOf("n$e-exit", "word-exit")
            else -> emptyList()
        }
    }

    /** The clips as the words a listener hears: "56 and 52 exit". */
    fun words(clips: List<String>): String = clips.joinToString(" ") { clip ->
        if (clip.startsWith("word-")) clip.removePrefix("word-") else clip.drop(1).takeWhile { it.isDigit() }
    }
}
