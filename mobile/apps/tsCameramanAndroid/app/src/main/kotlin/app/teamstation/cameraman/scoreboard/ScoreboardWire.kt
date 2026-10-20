package app.teamstation.cameraman.scoreboard

import app.teamstation.cameraman.eventcontrol.TeamStationUserId
import app.teamstation.cameraman.eventcontrol.EventControlCredentials
import app.teamstation.cameraman.eventcontrol.EventControlFetchException
import app.teamstation.cameraman.eventcontrol.EventControlFetchFailure
import app.teamstation.cameraman.eventcontrol.EventControlKeyFetcher
import app.teamstation.cameraman.radar.ScoreboardSocketTarget
import app.teamstation.cameraman.radar.ScoreboardTarget
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.ZoneId
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** [status] is the server's HTTP status, or 0 when it could not be reached. */
internal class ScoreboardWireException(message: String, val status: Int = 0) : Exception(message)

internal data class ScoreboardSignInStarted(
    val requestId: String,
    val clientSecret: String
)

internal data class ScoreboardSignedIn(
    val token: String,
    val displayName: String,
    val email: String,
    /** The account's canonical ID in decimal; empty when the server's answer did not carry one. */
    val userId: String = ""
)

internal data class ScoreboardEventRow(
    val gameId: String,
    val title: String,
    val startAt: String,
    val whenLabel: String
)

internal data class ScoreboardEventLists(
    val recent: List<ScoreboardEventRow>,
    val upcoming: List<ScoreboardEventRow>
)

/**
 * The TeamStation calls Cameraman makes: mail a code, spend it, list events, and, for device event
 * control, who the token belongs to and that account's control key.
 */
internal interface ScoreboardAccount {
    /** `appOrigin` is the app's own link host, where the mailed link goes; null for a web link. */
    fun startSignIn(server: String, email: String, origin: String, appOrigin: String?): ScoreboardSignInStarted
    fun completeSignIn(
        server: String,
        email: String,
        code: String,
        deviceName: String
    ): ScoreboardSignedIn
    fun events(server: String, token: String, zone: ZoneId): ScoreboardEventLists

    /** `POST auth/link/verify`: spends a sign-in link's token for this named device. */
    fun signInWithLink(server: String, token: String, deviceName: String): ScoreboardSignedIn

    /**
     * The server's OpenID issuer, `<its public origin>/oauth`. Null when the server answered without
     * one (with OAuth off it vouches for no other name); throws [java.io.IOException] when it could
     * not be asked: no answer, or a 5xx.
     */
    fun issuer(server: String): String?

    /** `GET auth/me`: the canonical user ID, of the account [token] belongs to. */
    fun me(server: String, token: String): String

    /** `GET device-event-control/key` with this device's own [token]: the server's JSON reply. */
    fun eventControlKey(server: String, token: String): String
}

/**
 * The key fetch as event control wants it: a 401 is a refused session, a 404 or 503 says the server
 * does not offer event control, and anything else (no answer, another error) is offline, as on iOS.
 */
internal fun ScoreboardAccount.eventControlKeyFetcher(): EventControlKeyFetcher =
    EventControlKeyFetcher { server, token ->
        val reply = try {
            eventControlKey(server, token)
        } catch (error: ScoreboardWireException) {
            val failure = when (error.status) {
                401 -> EventControlFetchFailure.Unauthorized
                404, 503 -> EventControlFetchFailure.Unavailable
                else -> EventControlFetchFailure.Offline
            }
            throw EventControlFetchException(failure, error.message ?: "")
        }
        EventControlCredentials.decode(reply)
    }

/** Current server identities are canonical strings; empty when malformed or absent. */
internal fun decimalUserId(raw: Any?): String =
    (raw as? String)?.let(TeamStationUserId::canonical).orEmpty()

internal class OkHttpScoreboardAccount(
    private val client: OkHttpClient = OkHttpClient()
) : ScoreboardAccount {
    override fun startSignIn(
        server: String,
        email: String,
        origin: String,
        appOrigin: String?
    ): ScoreboardSignInStarted {
        val request = JSONObject().put("email", email).put("origin", origin)
        if (!appOrigin.isNullOrEmpty()) request.put("appOrigin", appOrigin)
        val body = post(server, "auth/email-code", null, request)
        return ScoreboardSignInStarted(
            requestId = body.getString("requestId"),
            clientSecret = body.getString("clientSecret")
        )
    }

    override fun completeSignIn(
        server: String,
        email: String,
        code: String,
        deviceName: String
    ): ScoreboardSignedIn {
        val body = post(
            server,
            "auth/email-code/verify",
            null,
            JSONObject().put("email", email).put("code", code).put("deviceName", deviceName)
        )
        val user = body.getJSONObject("user")
        return ScoreboardSignedIn(
            token = body.getString("token"),
            displayName = user.optString("displayName"),
            email = user.optString("email").ifEmpty { email },
            userId = decimalUserId(user.opt("id"))
        )
    }

    override fun signInWithLink(server: String, token: String, deviceName: String): ScoreboardSignedIn {
        val body = post(
            server,
            "auth/link/verify",
            null,
            JSONObject().put("token", token).put("deviceName", deviceName)
        )
        val user = body.getJSONObject("user")
        return ScoreboardSignedIn(
            token = body.getString("token"),
            displayName = user.optString("displayName"),
            email = user.optString("email"),
            userId = decimalUserId(user.opt("id"))
        )
    }

    override fun issuer(server: String): String? {
        val url = ScoreboardTarget.httpOrigin(server).trimEnd('/') + "/oauth/.well-known/openid-configuration"
        client.newCall(Request.Builder().url(url).header("Accept", "application/json").build()).execute().use { response ->
            if (response.code >= 500) throw IOException("$url answered ${response.code}")
            if (response.code != 200) return null
            return runCatching { JSONObject(response.body?.string().orEmpty()).optString("issuer") }
                .getOrNull()?.ifEmpty { null }
        }
    }

    override fun me(server: String, token: String): String {
        val userId = decimalUserId(get(server, "auth/me", token).opt("id"))
        if (userId.isEmpty()) throw ScoreboardWireException("The server's answer was not understood", 200)
        return userId
    }

    override fun eventControlKey(server: String, token: String): String =
        getText(server, "device-event-control/key", token)

    override fun events(server: String, token: String, zone: ZoneId): ScoreboardEventLists {
        val text = getText(server, "events?scope=run&lookbackHours=2&limit=20", token)
        val rows = rows(JSONArray(text), zone)
        return ScoreboardEventLists(recent = emptyList(), upcoming = rows)
    }

    private fun getText(server: String, path: String, token: String): String {
        val url = ScoreboardTarget.httpOrigin(server).trimEnd('/') + "/api/v1/" + path
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (token.isNotEmpty()) builder.header("Authorization", "Bearer $token")
        builder.method("GET", null)
        val response = try {
            client.newCall(builder.build()).execute()
        } catch (error: Exception) {
            throw ScoreboardWireException("Cannot reach ${ScoreboardTarget.httpOrigin(server)}")
        }
        val text = response.body?.string().orEmpty()
        if (response.code !in 200..299) {
            throw ScoreboardWireException(messageOf(text) ?: "The server answered ${response.code}", response.code)
        }
        return text
    }

    private fun post(
        server: String,
        path: String,
        token: String?,
        json: JSONObject
    ): JSONObject = call(server, path, token, "POST", json.toString())

    private fun get(server: String, path: String, token: String): JSONObject =
        call(server, path, token, "GET", null)

    private fun call(
        server: String,
        path: String,
        token: String?,
        method: String,
        json: String?
    ): JSONObject {
        val url = ScoreboardTarget.httpOrigin(server).trimEnd('/') + "/api/v1/" + path
        val builder = Request.Builder().url(url).header("Accept", "application/json")
        if (!token.isNullOrEmpty()) builder.header("Authorization", "Bearer $token")
        if (json != null) {
            builder.method(method, json.toRequestBody(JSON))
        } else {
            builder.method(method, null)
        }
        val response = try {
            client.newCall(builder.build()).execute()
        } catch (error: Exception) {
            throw ScoreboardWireException("Cannot reach ${ScoreboardTarget.httpOrigin(server)}")
        }
        val text = response.body?.string().orEmpty()
        if (response.code !in 200..299) {
            throw ScoreboardWireException(messageOf(text) ?: "The server answered ${response.code}", response.code)
        }
        return try {
            JSONObject(text)
        } catch (error: Exception) {
            throw ScoreboardWireException("The server's answer was not understood")
        }
    }

    private fun rows(array: JSONArray?, zone: ZoneId): List<ScoreboardEventRow> {
        if (array == null) return emptyList()
        val rows = ArrayList<ScoreboardEventRow>(array.length())
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val gameId = item.optString("gameId")
            if (gameId.isEmpty()) continue
            val away = item.optString("awayTeamName")
            val home = item.optString("homeTeamName")
            val startAt = item.optString("startAt")
            rows += ScoreboardEventRow(
                gameId = gameId,
                title = ScoreboardTarget.eventTitle(away, home),
                startAt = startAt,
                whenLabel = ScoreboardTarget.localStartTime(startAt, zone)
            )
        }
        return rows
    }

    private fun messageOf(text: String): String? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val message = json.optString("message")
        if (message.isNotEmpty()) return message
        val error = json.optString("error")
        return error.ifEmpty { null }
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}

/** Where readings go out. [ScoreboardSocket] on a device; a recorder in tests. */
internal interface ScoreboardPublisher {
    fun send(target: ScoreboardSocketTarget?, text: String)

    /** Drops the socket, any reading still waiting for it, and the retry stop. */
    fun close()
}

/**
 * One scoreboard socket. A new target replaces the old one. A reading that arrives before the
 * handshake finishes is kept and sent when the socket opens. Close 4401, 4403, and 4404 stop
 * retries for that target.
 */
internal class ScoreboardSocket(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build(),
    private val onStatus: (String) -> Unit = {}
) : ScoreboardPublisher {
    private val lock = ReentrantLock()
    private var socket: WebSocket? = null
    private var openUrl: String? = null
    private var openAuthorization: String? = null
    private var opened = false
    private var stopped = false
    private var pending: String? = null

    override fun send(target: ScoreboardSocketTarget?, text: String) {
        if (target == null) return
        var outbound: WebSocket? = null
        var outboundText: String? = null
        lock.withLock {
            val sameTarget = openUrl == target.url && openAuthorization == target.authorization
            if (stopped && sameTarget) return
            val sameSocket = socket != null && sameTarget
            if (!sameSocket) {
                socket?.close(1000, null)
                opened = false
                stopped = false
                pending = text
                openUrl = target.url
                openAuthorization = target.authorization
                val builder = Request.Builder().url(target.url)
                if (target.authorization != null) builder.header("Authorization", target.authorization)
                socket = client.newWebSocket(builder.build(), Listener())
                return
            }
            if (opened) {
                outbound = socket
                outboundText = text
            } else {
                pending = text
            }
        }
        if (outboundText != null) outbound?.send(outboundText)
    }

    override fun close() {
        lock.withLock {
            socket?.close(1000, null)
            socket = null
            opened = false
            stopped = false
            pending = null
            openUrl = null
            openAuthorization = null
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            val text = lock.withLock {
                if (socket !== webSocket) return
                opened = true
                val text = pending
                pending = null
                text
            }
            if (text != null) webSocket.send(text)
            onStatus("Sending")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
            noteClosed(webSocket, code)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            noteClosed(webSocket, code)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val code = response?.code ?: 0
            lock.withLock {
                if (socket !== webSocket) return
                socket = null
                opened = false
                if (ScoreboardTarget.stopsRetry(code)) stopped = true
            }
            if (!ScoreboardTarget.stopsRetry(code)) onStatus("Reconnecting")
            else onStatus(reasonOf(code))
        }

        private fun noteClosed(webSocket: WebSocket, code: Int) {
            lock.withLock {
                if (socket !== webSocket) return
                socket = null
                opened = false
                if (ScoreboardTarget.stopsRetry(code)) {
                    stopped = true
                    pending = null
                }
            }
            if (ScoreboardTarget.stopsRetry(code)) onStatus(reasonOf(code))
        }
    }

    private fun reasonOf(code: Int): String = when (code) {
        4401 -> "Signed out"
        4403, 4404 -> "The scoreboard refused this camera"
        else -> "The scoreboard closed"
    }
}
