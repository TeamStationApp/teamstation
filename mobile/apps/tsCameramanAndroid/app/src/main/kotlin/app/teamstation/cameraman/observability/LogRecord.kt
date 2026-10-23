package app.teamstation.cameraman.observability

import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID

enum class LogKind(val wire: String) {
    STARTED("service_started"), STOPPED("service_stopped"), ERROR("app_error"),
    STREAM_STARTED("stream_started"), STREAM_STOPPED("stream_stopped"), STREAM_FAILED("stream_failed"),
    RECORDING_REQUESTED("recording_requested"), RECORDING_STARTED("recording_started"),
    RECORDING_STOPPED("recording_stopped"), RECORDING_FAILED("recording_failed"),
    UPLOAD_STARTED("upload_started"), UPLOAD_COMPLETED("upload_completed"),
    UPLOAD_FAILED("upload_failed"), UPLOAD_RETRY("upload_retry"),
}
enum class LogOperation(val wire: String) { RECORD("record"), UPLOAD("upload"), PLAYBACK("playback"), SERVICE("service"), REQUEST("request"), OTHER("other") }
enum class LogError(val wire: String) {
    INVALID("invalid"), EXPIRED("expired"), RATE_LIMITED("rate_limited"), OFFLINE("offline"),
    INTERNAL("internal"), TIMEOUT("timeout"), PERMISSION("permission"), STORAGE("storage"), CANCELLED("cancelled"), UNKNOWN("unknown"),
}

/** Closed typed fields: no raw error text, chat, URLs, tokens or request bodies. */
data class LogRecord(
    val kind: LogKind,
    val at: Instant = Instant.now(),
    val id: UUID = UUID.randomUUID(),
    val operation: LogOperation? = null,
    val error: LogError? = null,
    val milliseconds: Double? = null,
    val count: Int? = null,
    val video: String? = null,
    val version: String? = null,
) {
    init {
        require(milliseconds == null || (milliseconds.isFinite() && milliseconds in 0.0..15000.0))
        require(count == null || count in 0..1_000_000_000)
        require(video == null || Regex("^vid_[A-Za-z0-9_-]{1,96}$").matches(video))
        require(version == null || Regex("^[0-9][0-9A-Za-z.+_-]{0,63}$").matches(version))
        val videoKind = kind.wire.startsWith("recording_") || kind.wire.startsWith("upload_")
        require(if (videoKind) operation == null && count == null else video == null)
    }

    fun jsonLine(): String {
        val properties = JSONObject()
        operation?.let { properties.put("op", it.wire) }
        error?.let { properties.put("ec", it.wire) }
        milliseconds?.let { properties.put("ms", it) }
        count?.let { properties.put("n", it) }
        video?.let { properties.put("vi", it) }
        val rest = JSONObject()
            .put("A", "cam").put("I", id.toString()).put("E", kind.wire)
            .put("L", if (error == null) "info" else "error").put("R", 1).put("P", properties)
        version?.let { rest.put("V", it) }
        val date = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(at)
        return "{\"D\":" + JSONObject.quote(date) + "," + rest.toString().drop(1) + "\n"
    }

    companion object {
        fun decode(line: String): LogRecord {
            val row = JSONObject(line)
            require(row.getString("A") == "cam" && row.getInt("R") == 1)
            val p = row.getJSONObject("P")
            val result = LogRecord(
                LogKind.entries.first { it.wire == row.getString("E") },
                Instant.parse(row.getString("D")), UUID.fromString(row.getString("I")),
                if (p.has("op")) LogOperation.entries.first { it.wire == p.getString("op") } else null,
                if (p.has("ec")) LogError.entries.first { it.wire == p.getString("ec") } else null,
                if (p.has("ms")) p.getDouble("ms") else null,
                if (p.has("n")) p.getInt("n") else null,
                if (p.has("vi")) p.getString("vi") else null,
                if (row.has("V")) row.getString("V") else null,
            )
            require(row.getString("L") == if (result.error == null) "info" else "error")
            return result
        }
    }
}
