package app.teamstation.streamcore.phonestream

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import app.teamstation.streamcore.upload.UploadClient
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

    /**
     * Says when the first picture of the stream's first publish was captured, in wall seconds:
     * `PATCH …/live-streams/:id { liveStartedAt }`. TeamStation places the stream's live video there,
     * where the angle grid lines it up with the game's other cameras, instead of where the publish
     * reached it. The first account holds; one of a later publish is ignored.
     */
    suspend fun reportLiveStart(gameId: String, streamId: String, startedAt: Double) {
        val body = JSONObject().put("liveStartedAt", UploadClient.instant(startedAt))
        val request = Request.Builder()
            .url("$base/api/v1/games/${escape(gameId)}/live-streams/${escape(streamId)}")
            .header("accept", "application/json")
            .header("authorization", "Bearer $token")
            .patch(body.toString().toRequestBody(jsonType))
            .build()
        withContext(Dispatchers.IO) {
            val response = try {
                http.newCall(request).execute()
            } catch (error: IOException) {
                throw Error.Offline
            }
            response.use { answer ->
                val status = answer.code
                when {
                    status == 410 -> throw Error.StreamEnded(reason(answer.body?.string().orEmpty()) ?: endedMessage)
                    !answer.isSuccessful -> throw Error.Server(status, "TeamStation answered $status")
                }
            }
        }
    }

    /**
     * What to add to [now] to read TeamStation's clock ([ServerClock]), from [samples] round trips to
     * `GET /api/v1/time`. [now] is the clock the caller's instants are on. Throws only when no round
     * trip came back.
     */
    suspend fun serverClockOffset(samples: Int = ServerClock.SAMPLES, now: () -> Double): Double {
        val request = Request.Builder()
            .url("$base/api/v1/time")
            .header("accept", "application/json")
            .get()
            .build()
        val taken = mutableListOf<ServerClock.Sample>()
        var failure: Error = Error.Offline
        withContext(Dispatchers.IO) {
            repeat(maxOf(1, samples)) {
                val sent = now()
                try {
                    http.newCall(request).execute().use { answer ->
                        val text = answer.body?.string().orEmpty()
                        if (!answer.isSuccessful) throw Error.Server(answer.code, "TeamStation answered ${answer.code}")
                        val server = runCatching { JSONObject(text).getDouble("serverTime") / 1000 }
                            .getOrElse { throw Error.Server(answer.code, "TeamStation sent something unreadable") }
                        taken += ServerClock.Sample(sent, server, now())
                    }
                } catch (error: IOException) {
                    failure = Error.Offline
                } catch (error: Error) {
                    failure = error
                }
            }
        }
        return ServerClock.offset(taken) ?: throw failure
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
