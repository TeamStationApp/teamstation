package co.gamestation.cameraman.rtsp

/**
 * The server half of RFC 2326's message syntax: requests parsed, responses written.
 *
 * GS Producer's `RTSPMessage` is the mirror image of this — it writes requests and parses responses.
 * The two are deliberately not shared, because a bug in shared code would cancel itself out in any
 * test that used both ends.
 */
data class RTSPServerRequest(
    val method: String,
    val uri: String,
    /** Lower-cased keys. No client agrees with any other about capitalisation. */
    val headers: Map<String, String>,
    val body: ByteArray = ByteArray(0)
) {
    val cseq: String? get() = headers["cseq"]

    /** Session identifier without the `;timeout=` parameter a client may echo back. */
    val session: String? get() = headers["session"]?.split(";")?.firstOrNull()?.trim()

    override fun equals(other: Any?): Boolean =
        other is RTSPServerRequest &&
            other.method == method &&
            other.uri == uri &&
            other.headers == headers &&
            other.body.contentEquals(body)

    override fun hashCode(): Int {
        var result = method.hashCode()
        result = result * 31 + uri.hashCode()
        result = result * 31 + headers.hashCode()
        return result * 31 + body.contentHashCode()
    }

    data class Parsed(val request: RTSPServerRequest, val consumed: Int)

    companion object {
        /**
         * Parses one request, returning how many bytes it consumed. Null means "not yet complete",
         * which is the normal case on a streaming socket and must never be treated as an error.
         */
        fun parse(data: ByteArray, length: Int = data.size): Parsed? {
            val terminator = headerTerminator(data, length) ?: return null

            val headerText = String(data, 0, terminator.start, Charsets.UTF_8)
            val lines = unfolded(headerText).toMutableList()
            val requestLine = lines.firstOrNull() ?: return null
            lines.removeAt(0)

            // "DESCRIBE rtsp://host/live RTSP/1.0"
            val parts = requestLine.split(" ").filter { it.isNotEmpty() }
            if (parts.size < 3) return null

            val headers = HashMap<String, String>()
            for (line in lines) {
                val separator = line.indexOf(':')
                if (separator < 0) continue
                val name = line.substring(0, separator).trim().lowercase()
                headers[name] = line.substring(separator + 1).trim()
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val available = length - terminator.end
            if (available < contentLength) return null

            val bodyEnd = terminator.end + contentLength
            return Parsed(
                RTSPServerRequest(
                    method = parts[0].uppercase(),
                    uri = parts[1],
                    headers = headers,
                    body = data.copyOfRange(terminator.end, bodyEnd)
                ),
                bodyEnd
            )
        }

        private data class Terminator(val start: Int, val end: Int)

        private fun headerTerminator(data: ByteArray, length: Int): Terminator? {
            // A client sending bare LFs would otherwise never look complete, so LFLF is accepted too.
            var index = 0
            while (index < length) {
                if (matches(data, length, index, crlfCrlf)) return Terminator(index, index + 4)
                if (matches(data, length, index, lfLf)) return Terminator(index, index + 2)
                index += 1
            }
            return null
        }

        private val crlfCrlf = byteArrayOf(0x0D, 0x0A, 0x0D, 0x0A)
        private val lfLf = byteArrayOf(0x0A, 0x0A)

        private fun matches(data: ByteArray, length: Int, index: Int, pattern: ByteArray): Boolean {
            if (index + pattern.size > length) return false
            for (offset in pattern.indices) {
                if (data[index + offset] != pattern[offset]) return false
            }
            return true
        }

        /**
         * Joins continuation lines. A header value may wrap onto following lines that begin with
         * whitespace, and splitting on newlines alone silently loses the remainder.
         */
        private fun unfolded(text: String): List<String> {
            val result = ArrayList<String>()
            for (raw in text.split("\n")) {
                val line = if (raw.endsWith("\r")) raw.dropLast(1) else raw
                val first = line.firstOrNull()
                if ((first == ' ' || first == '\t') && result.isNotEmpty()) {
                    result[result.size - 1] = result[result.size - 1] + " " + line.trim()
                } else {
                    result.add(line)
                }
            }
            return result.filter { it.isNotEmpty() }
        }
    }
}

class RTSPServerResponse(
    val statusCode: Int = 200,
    val reasonPhrase: String = "OK",
    /** Ordered so the wire form is byte-for-byte predictable in tests. */
    val headers: List<Pair<String, String>> = emptyList(),
    val body: ByteArray = ByteArray(0)
) {
    fun adding(name: String, value: String): RTSPServerResponse =
        RTSPServerResponse(statusCode, reasonPhrase, headers + (name to value), body)

    val wireFormat: ByteArray
        get() {
            val text = StringBuilder()
            text.append("RTSP/1.0 ").append(statusCode).append(' ').append(reasonPhrase).append("\r\n")
            for ((name, value) in headers) {
                text.append(name).append(": ").append(value).append("\r\n")
            }
            if (body.isNotEmpty()) {
                text.append("Content-Length: ").append(body.size).append("\r\n")
            }
            text.append("\r\n")

            return text.toString().toByteArray(Charsets.UTF_8) + body
        }

    companion object {
        fun status(code: Int, reason: String, cseq: String?): RTSPServerResponse {
            val headers = ArrayList<Pair<String, String>>()
            // Echoing CSeq is mandatory even on an error. A client that cannot match the response to
            // its request treats the session as desynchronised.
            if (cseq != null) headers.add("CSeq" to cseq)
            return RTSPServerResponse(code, reason, headers)
        }
    }
}
