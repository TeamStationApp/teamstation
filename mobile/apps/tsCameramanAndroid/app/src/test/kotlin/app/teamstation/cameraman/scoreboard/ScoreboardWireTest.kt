package app.teamstation.cameraman.scoreboard

import app.teamstation.cameraman.eventcontrol.EventControlFetchException
import app.teamstation.cameraman.eventcontrol.EventControlFetchFailure
import app.teamstation.cameraman.eventcontrol.EventControlFixtures
import app.teamstation.cameraman.radar.ScoreboardSocketTarget
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException

/**
 * The account calls event control adds — who the token belongs to, and its control key — and the
 * socket's fencing of callbacks from a socket it has already left.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScoreboardWireTest {
    private val server = "https://app.example.test"

    /** Answers every call from [answer], offline. Records each request. */
    private class Server(val answer: (Request) -> Pair<Int, String>) {
        val requests = ArrayList<Request>()
        val client: OkHttpClient = OkHttpClient.Builder().addInterceptor(
            Interceptor { chain ->
                val request = chain.request()
                requests += request
                val (code, body) = answer(request)
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(code)
                    .message("x")
                    .body(body.toResponseBody("application/json".toMediaType()))
                    .build()
            }
        ).build()
    }

    @Test
    fun `sign-in reads the user ID as a number or a string`() {
        val numeric = Server { 200 to """{"token":"t","user":{"id":1001,"displayName":"Ken Griffey","email":"griffey@example.test"}}""" }
        assertEquals("1001", OkHttpScoreboardAccount(numeric.client).completeSignIn(server, "griffey@example.test", "1", "d").userId)
        val text = Server { 200 to """{"token":"t","user":{"id":"1002"}}""" }
        val signedIn = OkHttpScoreboardAccount(text.client).completeSignIn(server, "griffey@example.test", "1", "d")
        assertEquals("1002", signedIn.userId)
        assertEquals("griffey@example.test", signedIn.email)
        val none = Server { 200 to """{"token":"t","user":{}}""" }
        assertEquals("", OkHttpScoreboardAccount(none.client).completeSignIn(server, "a@example.test", "1", "d").userId)
    }

    @Test
    fun `auth me names the account, with the device's own token`() {
        val ok = Server { 200 to """{"id":1001,"displayName":"Ken Griffey"}""" }
        assertEquals("1001", OkHttpScoreboardAccount(ok.client).me(server, "token-one"))
        assertEquals("https://app.example.test/api/v1/auth/me", ok.requests.single().url.toString())
        assertEquals("Bearer token-one", ok.requests.single().header("Authorization"))

        val noId = Server { 200 to "{}" }
        try {
            OkHttpScoreboardAccount(noId.client).me(server, "token-one")
            fail("an answer with no ID")
        } catch (error: ScoreboardWireException) {
            assertEquals(200, error.status)
        }
        val refused = Server { 401 to """{"error":"unauthorized"}""" }
        try {
            OkHttpScoreboardAccount(refused.client).me(server, "token-one")
            fail("a refused token")
        } catch (error: ScoreboardWireException) {
            assertEquals(401, error.status)
        }
    }

    @Test
    fun `the control key is fetched with the device's own token, and failures say what kind`() {
        val reply = EventControlFixtures.one.toJson()
        val ok = Server { 200 to reply }
        val fetched = OkHttpScoreboardAccount(ok.client).eventControlKeyFetcher().fetch("wss://app.example.test/", "token-one")
        assertEquals(EventControlFixtures.one, fetched)
        assertEquals("https://app.example.test/api/v1/device-event-control/key", ok.requests.single().url.toString())
        assertEquals("Bearer token-one", ok.requests.single().header("Authorization"))

        val cases = mapOf(
            401 to EventControlFetchFailure.Unauthorized,
            404 to EventControlFetchFailure.Unavailable,
            503 to EventControlFetchFailure.Unavailable,
            500 to EventControlFetchFailure.Offline
        )
        for ((code, failure) in cases) {
            val answer = Server { code to """{"error":"deviceEventControlUnavailable"}""" }
            try {
                OkHttpScoreboardAccount(answer.client).eventControlKeyFetcher().fetch(server, "token-one")
                fail("$code")
            } catch (error: EventControlFetchException) {
                assertEquals(failure, error.failure)
            }
        }
        val offline = OkHttpClient.Builder().addInterceptor(Interceptor { throw IOException("no route") }).build()
        try {
            OkHttpScoreboardAccount(offline).eventControlKeyFetcher().fetch(server, "token-one")
            fail("offline")
        } catch (error: EventControlFetchException) {
            assertEquals(EventControlFetchFailure.Offline, error.failure)
        }
    }

    private fun Request.json(): String = Buffer().also { body!!.writeTo(it) }.readUtf8()

    @Test
    fun `a sign-in asked for in the app names the app's own link host`() {
        val ok = Server { 202 to """{"sent":true,"requestId":"emc_1","clientSecret":"s"}""" }
        val account = OkHttpScoreboardAccount(ok.client)
        account.startSignIn(server, "griffey@example.test", "android", "https://cameraman.example.test")
        account.startSignIn(server, "griffey@example.test", "android", null)
        account.startSignIn(server, "griffey@example.test", "android", "")
        assertEquals("https://app.example.test/api/v1/auth/email-code", ok.requests[0].url.toString())
        assertTrue(ok.requests[0].json().contains(""""appOrigin":"https:\/\/cameraman.example.test""""))
        assertTrue(ok.requests.drop(1).none { it.json().contains("appOrigin") })
    }

    @Test
    fun `a link is spent for this named device`() {
        val ok = Server { 200 to """{"token":"session","user":{"id":1001,"displayName":"Ken Griffey","email":"griffey@example.test"}}""" }
        val signedIn = OkHttpScoreboardAccount(ok.client).signInWithLink(server, "tok", "TS Cameraman")
        assertEquals(ScoreboardSignedIn("session", "Ken Griffey", "griffey@example.test", "1001"), signedIn)
        assertEquals("https://app.example.test/api/v1/auth/link/verify", ok.requests.single().url.toString())
        val body = ok.requests.single().json()
        assertTrue(body.contains(""""token":"tok""""))
        assertTrue(body.contains(""""deviceName":"TS Cameraman""""))

        val spent = Server { 401 to """{"code":"unauthorized","message":"That link is no longer good"}""" }
        try {
            OkHttpScoreboardAccount(spent.client).signInWithLink(server, "tok", "TS Cameraman")
            fail("a spent link")
        } catch (error: ScoreboardWireException) {
            assertEquals(401, error.status)
        }
    }

    @Test
    fun `the issuer comes from the server's OpenID discovery, or not at all`() {
        val ok = Server { 200 to """{"issuer":"https://web.example.test/oauth"}""" }
        assertEquals("https://web.example.test/oauth", OkHttpScoreboardAccount(ok.client).issuer(server))
        assertEquals("https://app.example.test/oauth/.well-known/openid-configuration", ok.requests.single().url.toString())

        // Answered without one (OAuth off): null.
        assertNull(OkHttpScoreboardAccount(Server { 404 to "{}" }.client).issuer(server))
        assertNull(OkHttpScoreboardAccount(Server { 200 to "{}" }.client).issuer(server))
        assertNull(OkHttpScoreboardAccount(Server { 200 to "not json" }.client).issuer(server))
        // Not asked at all: thrown.
        for (unreachable in listOf(
            Server { 503 to "{}" }.client,
            OkHttpClient.Builder().addInterceptor(Interceptor { throw IOException("no route") }).build()
        )) {
            try {
                OkHttpScoreboardAccount(unreachable).issuer(server)
                fail("unreachable")
            } catch (error: IOException) {
                // Expected.
            }
        }
    }

    @Test
    fun `user IDs are decimal or nothing`() {
        assertEquals("7", decimalUserId(7))
        assertEquals("70000000000", decimalUserId(70_000_000_000L))
        assertEquals("12", decimalUserId(" 12 "))
        assertEquals("", decimalUserId("12a"))
        assertEquals("", decimalUserId(""))
        assertEquals("", decimalUserId(1.5))
        assertEquals("", decimalUserId(null))
    }

    /** Sockets the client was asked for, with the listener each was given. */
    private class Sockets : OkHttpClient() {
        val made = ArrayList<Pair<FakeSocket, WebSocketListener>>()
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeSocket(request).also { made += it to listener }
    }

    private class FakeSocket(private val request: Request) : WebSocket {
        val texts = ArrayList<String>()
        var closed = false
        override fun request(): Request = request
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = texts.add(text)
        override fun send(bytes: ByteString): Boolean = false
        override fun close(code: Int, reason: String?): Boolean = true.also { closed = true }
        override fun cancel() = Unit
    }

    private fun response(request: Request, code: Int = 101) = Response.Builder()
        .request(request).protocol(Protocol.HTTP_1_1).code(code).message("x").build()

    @Test
    fun `callbacks from a socket the publisher has left change nothing, and its queued reading is dropped`() {
        val client = Sockets()
        val statuses = ArrayList<String>()
        val socket = ScoreboardSocket(client = client, onStatus = { statuses += it })
        val a = ScoreboardSocketTarget("wss://app.example.test/api/v1/scoreboard/gam_demoA/publish", "Bearer t")
        val b = ScoreboardSocketTarget("wss://app.example.test/api/v1/scoreboard/gam_demoB/publish", "Bearer t")

        socket.send(a, "{\"pitchSpeed\":52}")
        socket.close()
        socket.send(b, "{\"pitchSpeed\":53}")
        val (socketA, listenerA) = client.made[0]
        val (socketB, listenerB) = client.made[1]
        assertTrue(socketA.closed)

        // A opens, closes and fails late: nothing is sent on it, and nobody hears about it.
        listenerA.onOpen(socketA, response(socketA.request()))
        listenerA.onClosing(socketA, 4404, "gone")
        listenerA.onFailure(socketA, IOException("late"), null)
        assertEquals(emptyList<String>(), socketA.texts)
        assertEquals(emptyList<String>(), statuses)

        // B opens and gets only B's reading; a fresh reading equal to A's last goes to B too.
        listenerB.onOpen(socketB, response(socketB.request()))
        socket.send(b, "{\"pitchSpeed\":52}")
        assertEquals(listOf("{\"pitchSpeed\":53}", "{\"pitchSpeed\":52}"), socketB.texts)
        assertEquals(listOf("Sending"), statuses)
        assertEquals("Bearer t", socketB.request().header("Authorization"))
    }
}
