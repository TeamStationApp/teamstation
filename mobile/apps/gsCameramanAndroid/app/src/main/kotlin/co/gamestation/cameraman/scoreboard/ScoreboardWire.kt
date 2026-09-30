package co.gamestation.cameraman.scoreboard

import co.gamestation.cameraman.radar.ScoreboardSocketTarget
import co.gamestation.cameraman.radar.ScoreboardTarget
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

internal class ScoreboardWireException(message: String) : Exception(message)

internal data class ScoreboardSignInStarted(
    val requestId: String,
    val clientSecret: String
)

internal data class ScoreboardSignedIn(
    val token: String,
    val displayName: String,
    val email: String
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

/** The three GameStation calls Cameraman makes: mail a code, spend it, list events. */
internal interface ScoreboardAccount {
    fun startSignIn(server: String, email: String, origin: String): ScoreboardSignInStarted
    fun completeSignIn(
        server: String,
        email: String,
        code: String,
        deviceName: String
    ): ScoreboardSignedIn
    fun events(server: String, token: String, zone: ZoneId): ScoreboardEventLists
}

internal class OkHttpScoreboardAccount(
    private val client: OkHttpClient = OkHttpClient()
) : ScoreboardAccount {
    override fun startSignIn(
        server: String,
        email: String,
        origin: String
    ): ScoreboardSignInStarted {
        val body = post(
            server,
            "auth/email-code",
            null,
            JSONObject().put("email", email).put("origin", origin)
        )
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
            email = user.optString("email").ifEmpty { email }
        )
    }

    override fun events(server: String, token: String, zone: ZoneId): ScoreboardEventLists {
        val body = get(server, "scoreboard/events", token)
        return ScoreboardEventLists(
            recent = rows(body.optJSONArray("recent"), zone),
            upcoming = rows(body.optJSONArray("upcoming"), zone)
        )
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
            throw ScoreboardWireException(messageOf(text) ?: "The server answered ${response.code}")
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
) {
    private val lock = ReentrantLock()
    private var socket: WebSocket? = null
    private var openUrl: String? = null
    private var openAuthorization: String? = null
    private var opened = false
    private var stopped = false
    private var pending: String? = null

    fun send(target: ScoreboardSocketTarget?, text: String) {
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

    fun close() {
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
