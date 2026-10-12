package app.teamstation.streamcore.upload

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Why a request to TeamStation failed. TS Director's `TeamStationError`, for uploads. */
sealed class UploadClientError(message: String) : Exception(message) {
    data object Offline : UploadClientError("TeamStation could not be reached")
    data object NotSignedIn : UploadClientError("Sign in to TeamStation first")
    data class Server(val reason: String) : UploadClientError(reason)
}

/**
 * The upload half of TS Director's `TeamStationClient`: `POST /api/v1/director/uploads`, its state,
 * its parts and its finish, with a bearer token.
 */
class UploadClient(
    private val baseURL: String,
    private val token: String? = null,
    private val open: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }
) {
    /** An upload the server has opened, and how it wants the recording sent. */
    data class Opened(val uploadId: String, val partSize: Int, val parts: Int, val received: List<Int>)

    /** What the server has of an upload so far. */
    data class State(
        val uploadId: String,
        /** `open`, `assembling`, `ready`, `failed` or `abandoned`. */
        val state: String,
        val partSize: Int,
        val parts: Int,
        val received: List<Int>,
        val missing: List<Int>,
        val receivedBytes: Long,
        val step: String?,
        val videoId: String?,
        val message: String?
    )

    data class PartTaken(val received: Int, val parts: Int, val missing: List<Int>)

    data class Finished(val videoId: String?, val state: String, val step: String?)

    /**
     * Opens an upload. [startedAt] is when the recording began, seconds since 1970. [liveStreamId]
     * names the live stream this recording is the local copy of, and [wholeStream] says it ran for
     * every moment that stream published: the server then replaces exactly that stream's live copy.
     * Both are left out unless given.
     */
    suspend fun openUpload(
        gameId: String,
        title: String,
        kind: String,
        filename: String,
        sizeBytes: Long,
        startedAt: Double,
        liveStreamId: String? = null,
        wholeStream: Boolean? = null
    ): Opened {
        val body = JSONObject()
            .put("gameId", gameId)
            .put("title", title)
            .put("kind", kind)
            .put("filename", filename)
            .put("sizeBytes", sizeBytes)
            .put("startAt", instant(startedAt))
        if (liveStreamId != null) body.put("liveStreamId", liveStreamId)
        if (wholeStream != null) body.put("wholeStream", wholeStream)
        val json = request("director/uploads", "POST", body.toString().toByteArray(), "application/json", 20_000)
        return Opened(json.getString("uploadId"), json.getInt("partSize"), json.getInt("parts"), ints(json.optJSONArray("received")))
    }

    suspend fun uploadState(uploadId: String): State {
        val json = request("director/uploads/${escape(uploadId)}", "GET", null, null, 20_000)
        return State(
            uploadId = json.getString("uploadId"),
            state = json.getString("state"),
            partSize = json.getInt("partSize"),
            parts = json.getInt("parts"),
            received = ints(json.optJSONArray("received")),
            missing = ints(json.optJSONArray("missing")),
            receivedBytes = json.optLong("receivedBytes"),
            step = json.optStringOrNull("step"),
            videoId = json.optStringOrNull("videoId"),
            message = json.optStringOrNull("message")
        )
    }

    /** One part of the recording, as bytes; minutes rather than seconds to land on a field's uplink. */
    /** The first [length] bytes of [bytes] are the part, so one buffer can carry every part in turn. */
    suspend fun sendPart(uploadId: String, index: Int, bytes: ByteArray, length: Int = bytes.size): PartTaken {
        val json = request("director/uploads/${escape(uploadId)}/parts/$index", "PUT", bytes, "application/octet-stream", 300_000, length)
        return PartTaken(json.getInt("received"), json.getInt("parts"), ints(json.optJSONArray("missing")))
    }

    /** Every part is there: turn it into a video. The server may take minutes before it answers. */
    suspend fun finishUpload(uploadId: String): Finished {
        val json = request("director/uploads/${escape(uploadId)}/finish", "POST", "{}".toByteArray(), "application/json", 900_000)
        return Finished(json.optStringOrNull("videoId"), json.optString("state"), json.optStringOrNull("step"))
    }

    private suspend fun request(
        path: String,
        method: String,
        body: ByteArray?,
        type: String?,
        timeoutMillis: Int,
        bodyLength: Int = body?.size ?: 0
    ): JSONObject =
        withContext(Dispatchers.IO) {
            val connection = try {
                open(URL(baseURL.trimEnd('/') + "/api/v1/" + path))
            } catch (error: IOException) {
                throw UploadClientError.Offline
            }
            try {
                connection.requestMethod = method
                connection.connectTimeout = timeoutMillis
                connection.readTimeout = timeoutMillis
                connection.setRequestProperty("accept", "application/json")
                token?.let { connection.setRequestProperty("authorization", "Bearer $it") }
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("content-type", type)
                    connection.setFixedLengthStreamingMode(bodyLength)
                    connection.outputStream.use { it.write(body, 0, bodyLength) }
                }
                val status = connection.responseCode
                val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                    ?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                if (status == 401 || status == 403) throw UploadClientError.NotSignedIn
                if (status !in 200..299) throw UploadClientError.Server(message(text, status))
                runCatching { JSONObject(text) }.getOrElse { throw UploadClientError.Server("TeamStation sent something unreadable") }
            } catch (error: IOException) {
                throw UploadClientError.Offline
            } finally {
                connection.disconnect()
            }
        }

    companion object {
        /** ISO 8601 with milliseconds in UTC, which is what the server reads. */
        fun instant(seconds: Double): String =
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .format(Date(Math.round(seconds * 1000)))

        /** The server's own words for a failure, or its status. */
        fun message(text: String, status: Int): String =
            runCatching { JSONObject(text).getString("message") }.getOrNull() ?: "TeamStation answered $status"

        private fun escape(segment: String): String = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")

        private fun ints(array: JSONArray?): List<Int> = array?.let { list -> (0 until list.length()).map { list.getInt(it) } } ?: emptyList()

        private fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else optString(key)
    }
}
