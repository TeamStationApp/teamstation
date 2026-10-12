package app.teamstation.streamcore.phonestream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * This device's stream slot on a game: `POST /api/v1/games/:gameId/live-streams` with the device's
 * install id. An OkHttp port of TS Director's `TeamStationClient.requestLiveStream`, which is what the
 * phone engine's redial calls: with [heldStreamId] the server hands back the stream this device
 * already holds, or answers 410 when that stream has been ended, and then nothing is created.
 */
class LiveStreamClient(
    /** The server's origin, or its `/api/v1` base. */
    apiBase: String,
    private val token: String,
    private val http: OkHttpClient = defaultClient
) {
    /** One stream as the server answers it. */
    data class LiveStream(val id: String, val url: String?, val label: String?, val state: String?)

    sealed class Error(message: String) : Exception(message) {
        /** 410: the stream this device holds was ended or revoked. Start streaming again to go live. */
        class StreamEnded(message: String) : Error(message)

        data object NotSignedIn : Error("Sign in to TeamStation first")

        data object Offline : Error("TeamStation could not be reached")

        class Server(val status: Int, reason: String) : Error(reason)
    }

    private val base = PhoneStreamRequest.serverURL(apiBase)

    suspend fun requestLiveStream(
        gameId: String,
        label: String,
        deviceId: String,
        deviceModel: String,
        heldStreamId: String? = null,
        recordsLocally: Boolean = true
    ): LiveStream {
        val body = JSONObject()
            .put("label", label)
            .put("deviceId", deviceId)
            .put("deviceModel", deviceModel)
            .put("recordsLocally", recordsLocally)
        if (heldStreamId != null) body.put("heldStreamId", heldStreamId)
        val request = Request.Builder()
            .url("$base/api/v1/games/${escape(gameId)}/live-streams")
            .header("accept", "application/json")
            .header("authorization", "Bearer $token")
            .post(body.toString().toRequestBody(jsonType))
            .build()
        return withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(request).execute()
            } catch (error: IOException) {
                throw Error.Offline
            }
            response.use { answer ->
                val text = answer.body?.string().orEmpty()
                val status = answer.code
                when {
                    status == 410 -> throw Error.StreamEnded(reason(text) ?: endedMessage)
                    status == 401 || status == 403 -> throw Error.NotSignedIn
                    !answer.isSuccessful -> throw Error.Server(status, reason(text) ?: "TeamStation answered $status")
                }
                val json = runCatching { JSONObject(text) }.getOrElse { throw Error.Server(status, "TeamStation sent something unreadable") }
                LiveStream(
                    id = json.getString("id"),
                    url = json.optStringOrNull("url"),
                    label = json.optStringOrNull("label"),
                    state = json.optStringOrNull("state")
                )
            }
        }
    }

    companion object {
        const val endedMessage = "This camera was ended. Start streaming again to go live."

        private val jsonType = "application/json; charset=utf-8".toMediaType()

        val defaultClient: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(20, TimeUnit.SECONDS)
                .writeTimeout(20, TimeUnit.SECONDS)
                .build()
        }

        private fun reason(text: String): String? = runCatching { JSONObject(text).getString("message") }.getOrNull()

        private fun escape(segment: String): String = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")

        private fun JSONObject.optStringOrNull(key: String): String? =
            if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }
    }
}
