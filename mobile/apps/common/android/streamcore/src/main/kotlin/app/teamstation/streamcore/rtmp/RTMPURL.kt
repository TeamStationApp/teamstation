package app.teamstation.streamcore.rtmp

import java.net.URI

/**
 * `rtmp://host[:port]/app/streamName`, the only URL shape classic RTMP ingest accepts. A port of TS
 * Director's `RTMPURL`.
 */
data class RTMPURL(
    val host: String,
    val port: Int,
    val app: String,
    val stream: String
) {
    val tcURL: String get() = "rtmp://$host:$port/$app"
    val description: String get() = "$tcURL/$stream"

    enum class ParseError(val description: String) {
        EMPTY("set a stream URL in Settings"),
        NOT_RTMP("stream URL must start with rtmp://"),
        RTMPS_UNSUPPORTED("rtmps:// is not supported yet — use rtmp://"),
        MISSING_HOST("stream URL is missing a host"),
        MISSING_APP("stream URL needs an application name, e.g. rtmp://host/live/key"),
        MISSING_STREAM("stream URL needs a stream key after the application name")
    }

    /** What [parse] made of a string: a URL, or why it is not one. */
    sealed interface Parsed {
        data class Success(val url: RTMPURL) : Parsed
        data class Failure(val error: ParseError) : Parsed
    }

    /** Thrown where a caller needs a URL and [parse] gave none. */
    class InvalidURLException(val error: ParseError) : Exception(error.description)

    companion object {
        fun parse(raw: String): Parsed {
            val trimmed = raw.trim()
            if (trimmed.isEmpty()) return Parsed.Failure(ParseError.EMPTY)
            val lower = trimmed.lowercase()
            if (lower.startsWith("rtmps://")) return Parsed.Failure(ParseError.RTMPS_UNSUPPORTED)
            if (!lower.startsWith("rtmp://")) return Parsed.Failure(ParseError.NOT_RTMP)

            val uri = runCatching { URI(trimmed) }.getOrNull()
            val host = uri?.host
            if (uri == null || host.isNullOrEmpty()) return Parsed.Failure(ParseError.MISSING_HOST)
            val port = if (uri.port >= 0) uri.port else 1935
            val parts = (uri.path ?: "").split("/").filter { it.isNotEmpty() }
            val app = parts.firstOrNull() ?: return Parsed.Failure(ParseError.MISSING_APP)
            val stream = parts.drop(1).joinToString("/")
            if (stream.isEmpty()) return Parsed.Failure(ParseError.MISSING_STREAM)
            return Parsed.Success(RTMPURL(host, port, app, stream))
        }

        /** [parse], throwing [InvalidURLException] for a string that is not an ingest URL. */
        fun require(raw: String): RTMPURL = when (val parsed = parse(raw)) {
            is Parsed.Success -> parsed.url
            is Parsed.Failure -> throw InvalidURLException(parsed.error)
        }
    }
}
