package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.StreamCodec
import org.json.JSONObject

/**
 * How one file is encoded: codec, size, frame rate, bitrate and keyframe spacing. TS Director's
 * `EncodeSettings`, written to a take's row in the same JSON shape.
 */
data class EncodeSettings(
    val codec: StreamCodec = StreamCodec.HEVC,
    val width: Int = 1920,
    val height: Int = 1080,
    val frameRate: Int = 30,
    val bitrate: Int = 6_000_000,
    val keyframeSeconds: Double = 2.0
) {
    fun toJson(): JSONObject = JSONObject()
        .put("codec", codec.rawValue)
        .put("resolution", JSONObject().put("width", width).put("height", height))
        .put("frameRate", frameRate)
        .put("bitrate", bitrate)
        .put("keyframeSeconds", keyframeSeconds)

    companion object {
        fun fromJson(json: JSONObject): EncodeSettings {
            val resolution = json.getJSONObject("resolution")
            return EncodeSettings(
                codec = StreamCodec.fromRawValue(json.getString("codec")) ?: StreamCodec.HEVC,
                width = resolution.getInt("width"),
                height = resolution.getInt("height"),
                frameRate = json.getInt("frameRate"),
                bitrate = json.getInt("bitrate"),
                keyframeSeconds = json.getDouble("keyframeSeconds")
            )
        }
    }
}

/** The encoding a take was recorded with, kept with the take. TS Director's `TakeEncoding`. */
data class TakeEncoding(val rawCamera: EncodeSettings, val programme: EncodeSettings) {
    fun toJson(): String = JSONObject().put("rawCamera", rawCamera.toJson()).put("programme", programme.toJson()).toString()

    companion object {
        /** Null for a missing or unreadable value: an export falls back to its settings. */
        fun fromJson(text: String?): TakeEncoding? {
            if (text.isNullOrEmpty()) return null
            return runCatching {
                val json = JSONObject(text)
                TakeEncoding(EncodeSettings.fromJson(json.getJSONObject("rawCamera")), EncodeSettings.fromJson(json.getJSONObject("programme")))
            }.getOrNull()
        }
    }
}

/**
 * What a take is recorded with: the programme master's encoding, the whole encoding kept with the
 * take, and how long the app may be away before an interrupted take is closed rather than resumed.
 * TS Director's `RecordingSettings`.
 */
data class RecordingSettings(
    val programme: EncodeSettings,
    val takeEncoding: TakeEncoding = TakeEncoding(programme, programme),
    val resumeDowntimeLimitSeconds: Double = 3_600.0
)
