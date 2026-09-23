package co.gamestation.cameraman.radar

import co.gamestation.cameraman.core.InMemorySettingsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

class ScoreboardTargetTest {
    private val pacific = ZoneId.of("America/Los_Angeles")

    @Test
    fun `v1 uses the server string as typed and an event converts to a socket`() {
        assertEquals(
            "wss://app.gamestation.co/sockets/api/v1/autoState/game%201",
            ScoreboardTarget.v1Url("wss://app.gamestation.co/", "game 1")
        )
        assertNull(ScoreboardTarget.v1Url("wss://app.gamestation.co", ""))
        assertNull(ScoreboardTarget.v1Url("", "game"))
        val event = ScoreboardTarget.eventTarget(
            "https://gamestation.co/",
            "game 1",
            "token"
        )
        assertEquals(
            "wss://gamestation.co/api/v1/scoreboard/game%201/publish",
            event!!.url
        )
        assertEquals("Bearer token", event.authorization)
        assertEquals(
            "ws://10.0.2.2:9100",
            ScoreboardTarget.socketOrigin("http://10.0.2.2:9100/")
        )
        assertEquals(
            "https://gamestation.co",
            ScoreboardTarget.httpOrigin("wss://gamestation.co/")
        )
        assertNull(ScoreboardTarget.eventTarget("https://gamestation.co", "game", ""))
    }

    @Test
    fun `event route waits for a token and a chosen game`() {
        val saved = sample().copy(route = ScoreboardRoute.Event, token = "", gameId = "g")
        assertEquals(ScoreboardRoute.V1, ScoreboardTarget.effectiveRoute(saved.route, saved.token))
        assertEquals(
            "wss://app.gamestation.co/sockets/api/v1/autoState/evt",
            ScoreboardTarget.target(saved)!!.url
        )
        val signedIn = saved.copy(token = "tok", gameId = "")
        assertNull(ScoreboardTarget.target(signedIn.copy(route = ScoreboardRoute.Event)))
        val live = signedIn.copy(gameId = "g1")
        assertEquals(
            "wss://gamestation.co/api/v1/scoreboard/g1/publish",
            ScoreboardTarget.target(live)!!.url
        )
        assertEquals("Bearer tok", ScoreboardTarget.target(live)!!.authorization)
    }

    @Test
    fun `a pitch restarts the hold and an exit does not`() {
        val both = ScoreboardTarget.reading(50, 70)
        assertEquals("{\"pitchSpeed\":50,\"exitVelocity\":70}", both?.text)
        assertEquals(true, both?.restartsPitchHold)
        assertEquals(true, ScoreboardTarget.reading(50, 0)?.restartsPitchHold)
        val exitOnly = ScoreboardTarget.reading(0, 70)
        assertEquals("{\"exitVelocity\":70}", exitOnly?.text)
        assertEquals(false, exitOnly?.restartsPitchHold)
        assertNull(ScoreboardTarget.reading(0, 0))
        assertEquals("{\"pitchSpeed\":0}", ScoreboardTarget.PITCH_CLEAR_PAYLOAD)
        assertEquals(5_000L, ScoreboardTarget.PITCH_HOLD_MS)
    }

    fun `sign-in uses the build host`() {
        assertEquals("gamestation.co", ScoreboardTarget.accountHost(null))
        assertEquals("gamestation.co", ScoreboardTarget.accountHost(""))
        assertEquals("gamestation.co", ScoreboardTarget.accountHost("\$(GS_PRIMARY_HOST)"))
        assertEquals("https://gamestation.co", ScoreboardTarget.accountOrigin(null))
        assertEquals(
            "devhost3.examplegs.test",
            ScoreboardTarget.accountHost("https://devhost3.examplegs.test/")
        )
        assertEquals(
            "https://devhost3.examplegs.test",
            ScoreboardTarget.accountOrigin("devhost3.examplegs.test")
        )
        assertEquals("http://localhost", ScoreboardTarget.accountOrigin("localhost"))
    }

    fun `payload is the speeds that arrived`() {
        assertEquals("{\"pitchSpeed\":50,\"exitVelocity\":70}", ScoreboardTarget.payload(50, 70))
        assertEquals("{\"pitchSpeed\":50}", ScoreboardTarget.payload(50, 0))
        assertEquals("{\"exitVelocity\":70}", ScoreboardTarget.payload(0, 70))
        assertNull(ScoreboardTarget.payload(0, 0))
        assertNull(ScoreboardTarget.payload(-1, 0))
    }

    @Test
    fun `a refused socket is not retried`() {
        assertEquals(true, ScoreboardTarget.stopsRetry(4401))
        assertEquals(true, ScoreboardTarget.stopsRetry(4403))
        assertEquals(true, ScoreboardTarget.stopsRetry(4404))
        assertEquals(false, ScoreboardTarget.stopsRetry(1000))
    }

    @Test
    fun `event labels match the watcher`() {
        assertEquals("Visitors at Home", ScoreboardTarget.eventTitle("Visitors", "Home"))
        assertEquals(
            "Mon Sep 28, 2026 3:05 PM",
            ScoreboardTarget.localStartTime("2026-09-28T22:05:00Z", pacific)
        )
        assertEquals("not-a-date", ScoreboardTarget.localStartTime("not-a-date", pacific))
    }

    @Test
    fun `saved route falls back to v1 until a token exists`() {
        val store = InMemorySettingsStore()
        val fresh = ScoreboardTarget.load(store)
        assertEquals(ScoreboardRoute.V1, fresh.route)
        assertEquals(ScoreboardTarget.DEFAULT_V1_SERVER, fresh.apiServer)
        assertEquals(ScoreboardTarget.DEFAULT_ACCOUNT_SERVER, fresh.accountServer)
        assertEquals("", fresh.token)

        val chosen = sample().copy(route = ScoreboardRoute.Event, token = "tok")
        ScoreboardTarget.save(store, chosen)
        assertEquals(chosen, ScoreboardTarget.load(store))

        store.setString("", "co.gamestation.cameraman.scoreboard.token")
        assertEquals(ScoreboardRoute.V1, ScoreboardTarget.load(store).route)
        val out = ScoreboardTarget.signedOut(chosen)
        assertEquals(ScoreboardRoute.V1, out.route)
        assertEquals("", out.token)
        assertEquals("g1", out.gameId)
    }

    private fun sample() = ScoreboardSaved(
        route = ScoreboardRoute.V1,
        apiServer = "wss://app.gamestation.co",
        v1EventId = "evt",
        accountServer = "https://gamestation.co",
        token = "",
        displayName = "",
        email = "",
        gameId = "g1",
        gameTitle = "Away at Home",
        gameStartAt = "2026-09-28T22:05:00Z"
    )
}
