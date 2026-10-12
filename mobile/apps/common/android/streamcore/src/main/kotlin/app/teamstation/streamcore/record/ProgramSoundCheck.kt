package app.teamstation.streamcore.record

import org.json.JSONArray
import org.json.JSONObject

/**
 * What a finished programme part's sound track turned out to hold, kept with the take. A port of TS
 * Director's `ProgramSoundCheck`: sound shorter than its picture is the one fault nothing downstream
 * can repair, so it is said plainly on the take's row rather than left in memory.
 */
data class ProgramSoundCheck(
    /** Which output file, 1-based, matching the anchors' part. */
    val part: Int,
    /** Where the file's picture ends, read back from the file. */
    val pictureSeconds: Double,
    /** Where the file's sound ends, read back the same way. */
    val soundSeconds: Double,
    /** How many sound samples (AAC packets) the file holds; -1 when the track could not be read. */
    val samples: Int,
    /** The encoder's own diagnostic line, verbatim. */
    val detail: String
) {
    /** How far the sound falls short of the picture. Zero when it does not. */
    val shortfall: Double
        get() = if (pictureSeconds <= 0 || soundSeconds <= 0) 0.0 else maxOf(0.0, pictureSeconds - soundSeconds)

    val isShort: Boolean get() = pictureSeconds > 0 && soundSeconds > 0 && shortfall > tolerance

    fun toJson(): JSONObject = JSONObject()
        .put("part", part)
        .put("pictureSeconds", pictureSeconds)
        .put("soundSeconds", soundSeconds)
        .put("samples", samples)
        .put("detail", detail)

    companion object {
        /** Beyond this a viewer hears it. */
        const val tolerance = 0.25

        fun fromJson(json: JSONObject) = ProgramSoundCheck(
            part = json.getInt("part"),
            pictureSeconds = json.getDouble("pictureSeconds"),
            soundSeconds = json.getDouble("soundSeconds"),
            samples = json.getInt("samples"),
            detail = json.optString("detail")
        )

        /** Empty for a missing or unreadable value: no verdict is not a verdict of "fine". */
        fun listFromJson(text: String?): List<ProgramSoundCheck> {
            if (text.isNullOrEmpty()) return emptyList()
            return runCatching {
                val array = JSONArray(text)
                (0 until array.length()).map { fromJson(array.getJSONObject(it)) }
            }.getOrDefault(emptyList())
        }

        fun listToJson(checks: List<ProgramSoundCheck>): String =
            JSONArray().also { array -> checks.forEach { array.put(it.toJson()) } }.toString()
    }
}
