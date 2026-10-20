package app.teamstation.cameraman.scoreboard

import android.content.Context
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.cameraman.core.PreferencesSettingsStore
import app.teamstation.streamcore.core.SettingsStore
import app.teamstation.cameraman.eventcontrol.ClearSealer
import app.teamstation.cameraman.eventcontrol.EventControlAckStatus
import app.teamstation.cameraman.eventcontrol.EventControlBody
import app.teamstation.cameraman.eventcontrol.EventControlCommitter
import app.teamstation.cameraman.eventcontrol.EventControlCredentials
import app.teamstation.cameraman.eventcontrol.EventControlFixtures
import app.teamstation.cameraman.eventcontrol.EventControlHost
import app.teamstation.cameraman.eventcontrol.EventControlKeyStore
import app.teamstation.cameraman.eventcontrol.EventControlListenerState
import app.teamstation.cameraman.eventcontrol.TestDirector
import app.teamstation.cameraman.radar.ScoreboardRoute
import app.teamstation.cameraman.radar.ScoreboardSaved
import app.teamstation.cameraman.radar.ScoreboardSocketTarget
import app.teamstation.cameraman.radar.ScoreboardTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.ServerSocket
import java.time.ZoneId

/**
 * A Director's assignment as the scoreboard takes it: only the game's ID, title and start
 * time change; the route, the account, the servers, the V1 event and Send radar speeds stay; the
 * socket moves only on the event route; nothing queued or delayed for one event reaches the next;
 * the picker and every other way to change the event are off while a Director holds it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScoreboardDeskEventControlTest {
    private val server = "https://app.example.test"
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val hosts = ArrayList<EventControlHost>()
    private val keys = EventControlKeyStore(
        { context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE) },
        ClearSealer
    )
    private val radarEnabledKey = "app.teamstation.cameraman.radar.enabled"

    private val gameA = "gam_demoA"
    private val gameB = "gam_demoB"
    private val urlA = "wss://app.example.test/api/v1/scoreboard/gam_demoA/publish"
    private val urlB = "wss://app.example.test/api/v1/scoreboard/gam_demoB/publish"

    @Before
    fun clean() {
        context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After
    fun tearDown() {
        hosts.forEach { it.stop() }
        io.cancel()
    }

    /** What reached the socket, in order, and how often it was dropped. */
    private class Recorder : ScoreboardPublisher {
        val sent = ArrayList<Pair<String, String>>()
        var closes = 0
        override fun send(target: ScoreboardSocketTarget?, text: String) {
            if (target != null) sent += target.url to text
        }
        override fun close() {
            closes += 1
        }
    }

    private class Account : ScoreboardAccount {
        var me: () -> String = { "usr_11111111111111111111JG" }
        var meCalls = 0
        var eventCalls = 0
        var signedIn = ScoreboardSignedIn("token-one", "Ken Griffey", "griffey@example.test", "usr_11111111111111111111JG")
        var key: () -> String = { EventControlFixtures.credentials("one").toJson() }
        val keyTokens = ArrayList<String>()

        override fun startSignIn(server: String, email: String, origin: String, appOrigin: String?) =
            ScoreboardSignInStarted("r", "s")
        override fun signInWithLink(server: String, token: String, deviceName: String) = signedIn
        override fun issuer(server: String): String? = null
        override fun completeSignIn(server: String, email: String, code: String, deviceName: String) = signedIn
        override fun events(server: String, token: String, zone: ZoneId): ScoreboardEventLists {
            eventCalls += 1
            return ScoreboardEventLists(emptyList(), listOf(ScoreboardEventRow(gameIdC, "Comets at Pioneers", "2026-09-23T18:00:00Z", "later")))
        }
        override fun me(server: String, token: String): String {
            meCalls += 1
            return me()
        }
        override fun eventControlKey(server: String, token: String): String {
            keyTokens += token
            return key()
        }

        companion object {
            const val gameIdC = "gam_demoC"
        }
    }

    private fun saved(route: ScoreboardRoute = ScoreboardRoute.Event, userId: String = "usr_11111111111111111111JG") = ScoreboardSaved(
        route = route,
        apiServer = "wss://v1.example.test",
        v1EventId = "evt-v1",
        accountServer = server,
        token = "token-one",
        displayName = "Ken Griffey",
        email = "griffey@example.test",
        gameId = gameA,
        gameTitle = "Visitors at Pioneers",
        gameStartAt = "2026-09-21T18:00:00Z",
        userId = userId
    )

    private fun store(saved: ScoreboardSaved = saved()): InMemorySettingsStore =
        InMemorySettingsStore(mapOf(radarEnabledKey to "1")).also { ScoreboardTarget.save(it, saved) }

    private fun snapshot(store: SettingsStore, keys: List<String>): Map<String, String?> = keys.associateWith { store.string(it) }

    private val everyKey = listOf(
        "route", "apiServer", "v1EventId", "accountServer", "token", "displayName", "email",
        "gameId", "gameTitle", "gameStartAt", "userId"
    ).map { "app.teamstation.cameraman.scoreboard.$it" } + radarEnabledKey

    private fun TestScope.host(store: SettingsStore, account: ScoreboardAccount): EventControlHost {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        val ports = (0 until 2).map { ServerSocket(0).use { socket -> socket.localPort } }
        return EventControlHost(
            settings = store,
            keys = keys,
            fetcher = account.eventControlKeyFetcher(),
            scope = backgroundScope,
            io = io,
            main = dispatcher,
            ioContext = dispatcher,
            ports = ports,
            leaseScope = null
        ).also { hosts += it }
    }

    private fun TestScope.desk(
        store: SettingsStore,
        socket: ScoreboardPublisher = Recorder(),
        account: ScoreboardAccount = Account(),
        host: EventControlHost? = null
    ) = ScoreboardDesk(
        store = store,
        scope = backgroundScope,
        account = account,
        liveSocket = socket,
        zone = ZoneId.of("UTC"),
        accountOrigin = server,
        eventControl = host,
        io = UnconfinedTestDispatcher(testScheduler)
    )

    @Test
    fun `an assignment writes the game alone, and moves the socket on the event route`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val socket = Recorder()
        val desk = desk(store, socket)
        val before = snapshot(store, everyKey)

        desk.publishSpeeds(52, 0)
        val status = desk.applyAssignedEvent(gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z")
        assertEquals(EventControlAckStatus.Applied, status)
        assertEquals(1, socket.closes)

        val after = snapshot(store, everyKey)
        val changed = everyKey.filter { before[it] != after[it] }.map { it.substringAfterLast('.') }
        assertEquals(listOf("gameId", "gameTitle", "gameStartAt"), changed)
        assertEquals("1", store.string(radarEnabledKey))
        val state = desk.state.value
        assertEquals(ScoreboardRoute.Event, state.route)
        assertEquals("Pioneers at Comets", state.gameTitle)
        assertEquals("Tue Sep 22, 2026 1:30 AM", state.gameWhen)

        // A's pitch clear never fires into B; a fresh reading, the same speed as A's last, reaches B.
        advanceTimeBy(6_000)
        assertEquals(listOf(urlA to "{\"pitchSpeed\":52}"), socket.sent)
        desk.publishSpeeds(52, 0)
        assertEquals(urlB to "{\"pitchSpeed\":52}", socket.sent.last())
        advanceTimeBy(6_000)
        assertEquals(urlB to ScoreboardTarget.PITCH_CLEAR_PAYLOAD, socket.sent.last())
        assertEquals(listOf(urlA, urlB, urlB), socket.sent.map { it.first })
    }

    @Test
    fun `on V1 the event is kept for later and the socket stays`() = runTest(UnconfinedTestDispatcher()) {
        val store = store(saved(route = ScoreboardRoute.V1))
        val socket = Recorder()
        val desk = desk(store, socket)
        desk.publishSpeeds(0, 88)
        assertEquals(EventControlAckStatus.Applied, desk.applyAssignedEvent(gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z"))
        assertEquals(0, socket.closes)
        desk.publishSpeeds(0, 88)
        assertEquals(List(2) { "wss://v1.example.test/sockets/api/v1/autoState/evt-v1" }, socket.sent.map { it.first })
        assertEquals(ScoreboardRoute.V1, ScoreboardTarget.load(store).route)
        assertEquals(gameB, ScoreboardTarget.load(store).gameId)
        // Switching to the event route later sends there.
        desk.selectRoute(ScoreboardRoute.Event)
        desk.publishSpeeds(0, 88)
        assertEquals(urlB, socket.sent.last().first)
    }

    @Test
    fun `the same game again does not move the socket`() = runTest(UnconfinedTestDispatcher()) {
        val socket = Recorder()
        val desk = desk(store(), socket)
        assertEquals(EventControlAckStatus.Applied, desk.applyAssignedEvent(gameA, "Visitors at Pioneers", "2026-09-21T18:00:00Z"))
        assertEquals(0, socket.closes)
    }

    @Test
    fun `refusals write nothing`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val socket = Recorder()
        val desk = desk(store, socket)
        val before = snapshot(store, everyKey)
        assertEquals(EventControlAckStatus.Disabled, desk.applyAssignedEvent(gameB, "T", "2026-09-22T01:30:00Z") { EventControlAckStatus.Disabled })
        assertEquals(before, snapshot(store, everyKey))
        assertEquals(0, socket.closes)

        val unvalidated = desk(store(saved(userId = "")), socket)
        assertEquals(EventControlAckStatus.WrongAccount, unvalidated.applyAssignedEvent(gameB, "T", "2026-09-22T01:30:00Z"))

        val failing = object : SettingsStore by store {
            override fun setStrings(values: Map<String, String>) = throw IllegalStateException("disk full")
        }
        val broken = desk(failing, socket)
        assertEquals(EventControlAckStatus.Failed, broken.applyAssignedEvent(gameB, "T", "2026-09-22T01:30:00Z"))
        assertEquals(gameA, broken.state.value.let { ScoreboardTarget.load(store).gameId })
        assertEquals("Visitors at Pioneers", broken.state.value.gameTitle)
    }

    @Test
    fun `a Director's hold locks the picker, shows its address, and consent off gives it back`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val account = Account()
        val socket = Recorder()
        val host = host(store, account)
        val desk = desk(store, socket, account, host)
        desk.setAllowOverride(true)
        desk.start()
        runCurrent()
        assertTrue(desk.state.value.allowOverride)
        assertTrue(desk.state.value.overrideToggleEnabled)
        assertEquals(listOf("token-one"), account.keyTokens)
        assertTrue(host.state.value.listener is EventControlListenerState.Listening)

        desk.openEvents()
        assertTrue(desk.state.value.pickerOpen)
        desk.publishSpeeds(61, 0)

        val director = TestDirector(host.receiver)
        assertEquals(EventControlAckStatus.Applied, director.take(100, gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z"))
        runCurrent()
        var state = desk.state.value
        assertTrue(state.eventLocked)
        assertFalse("a hold closes the picker", state.pickerOpen)
        assertEquals("192.0.2.10", state.overrideHost)
        assertEquals("Pioneers at Comets", state.gameTitle)
        assertEquals(gameB, ScoreboardTarget.load(store).gameId)

        // Every way to change the event locally is off.
        val calls = account.eventCalls
        desk.openEvents()
        assertEquals(calls, account.eventCalls)
        desk.choose(ScoreboardEventRow(Account.gameIdC, "Comets at Pioneers", "2026-09-23T18:00:00Z", "later"))
        assertEquals(gameB, ScoreboardTarget.load(store).gameId)

        // An idempotent retry neither writes nor reconnects again.
        val closes = socket.closes
        assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 100), director.assign(100, gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z"))
        assertEquals(closes, socket.closes)

        // A to B to C through the Director; readings follow, A's delayed clear does not.
        assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 200), director.assign(200, Account.gameIdC, "Comets at Pioneers", "2026-09-23T18:00:00Z"))
        advanceTimeBy(6_000)
        desk.publishSpeeds(61, 0)
        assertEquals(
            listOf(urlA to "{\"pitchSpeed\":61}", "wss://app.example.test/api/v1/scoreboard/gam_demoC/publish" to "{\"pitchSpeed\":61}"),
            socket.sent
        )

        desk.setAllowOverride(false)
        runCurrent()
        state = desk.state.value
        assertFalse(state.eventLocked)
        assertEquals("", state.overrideHost)
        assertEquals("the last applied event stays", "Comets at Pioneers", state.gameTitle)
        desk.openEvents()
        assertEquals(calls + 1, account.eventCalls)
        desk.choose(ScoreboardEventRow(gameA, "Visitors at Pioneers", "2026-09-21T18:00:00Z", "then"))
        assertEquals(gameA, ScoreboardTarget.load(store).gameId)
        assertEquals("token-one", ScoreboardTarget.load(store).token)
    }

    @Test
    fun `a pick made just after a Director's game was written does not overwrite it`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val account = Account()
        val host = host(store, account)
        val desk = desk(store, Recorder(), account, host)
        desk.setAllowOverride(true)
        desk.start()
        runCurrent()
        // The operator's tap lands on the main thread right after the commit, before the receiver
        // has recorded the lease and long before the desk hears of it.
        val written = host.committer!!
        val rowC = ScoreboardEventRow(Account.gameIdC, "Comets at Pioneers", "2026-09-23T18:00:00Z", "later")
        var lockedThen: Boolean? = null
        host.committer = EventControlCommitter { assignment, check ->
            written.commit(assignment, check).also {
                lockedThen = desk.state.value.eventLocked
                desk.choose(rowC)
            }
        }
        val director = TestDirector(host.receiver)
        assertEquals(EventControlAckStatus.Applied, director.take(100, gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z"))
        assertEquals("the desk had not heard of the hold yet", false, lockedThen)
        assertEquals(gameB, ScoreboardTarget.load(store).gameId)

        assertEquals(EventControlBody.Ack(EventControlAckStatus.Applied, 100), director.release(100))
        runCurrent()
        desk.choose(rowC)
        assertEquals(Account.gameIdC, ScoreboardTarget.load(store).gameId)
    }

    @Test
    fun `a restart keeps consent and the last applied event, never the hold`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val account = Account()
        val host = host(store, account)
        val desk = desk(store, Recorder(), account, host)
        desk.setAllowOverride(true)
        desk.start()
        assertEquals(EventControlAckStatus.Applied, TestDirector(host.receiver).take(100, gameB, "Pioneers at Comets", "2026-09-22T01:30:00Z"))
        runCurrent()
        assertTrue(desk.state.value.eventLocked)
        desk.stop()
        runCurrent()
        assertFalse(desk.state.value.eventLocked)

        val again = desk(store, Recorder(), account, host(store, account))
        again.start()
        runCurrent()
        val state = again.state.value
        assertTrue(state.allowOverride)
        assertFalse(state.eventLocked)
        assertEquals("Pioneers at Comets", state.gameTitle)
        assertEquals("the cached key, no second fetch", 1, account.keyTokens.size)
    }

    @Test
    fun `an existing login is given its user ID, and a refused one loses it`() = runTest(UnconfinedTestDispatcher()) {
        val store = store(saved(userId = ""))
        val account = Account()
        val host = host(store, account)
        val desk = desk(store, Recorder(), account, host)
        desk.setAllowOverride(true)
        desk.start()
        runCurrent()
        assertEquals(1, account.meCalls)
        assertEquals("usr_11111111111111111111JG", ScoreboardTarget.load(store).userId)
        assertTrue(host.state.value.eligible)

        // Offline: the validated identity stays.
        account.me = { throw ScoreboardWireException("Cannot reach", 0) }
        desk.start()
        runCurrent()
        assertEquals("usr_11111111111111111111JG", ScoreboardTarget.load(store).userId)
        assertTrue(host.state.value.eligible)

        // Something else went wrong: also kept.
        account.me = { throw IllegalStateException("odd") }
        desk.start()
        assertEquals("usr_11111111111111111111JG", ScoreboardTarget.load(store).userId)

        // Refused: the identity and the key go; the token is the operator's to sign out.
        account.me = { throw ScoreboardWireException("Signed out", 401) }
        desk.start()
        runCurrent()
        assertEquals("", ScoreboardTarget.load(store).userId)
        assertEquals("token-one", ScoreboardTarget.load(store).token)
        assertFalse(host.state.value.eligible)
        assertNull(keys.credentials(server))
        desk.start()
        assertEquals("", ScoreboardTarget.load(store).userId)
    }

    @Test
    fun `a refused key fetch clears the identity too`() = runTest(UnconfinedTestDispatcher()) {
        val store = store()
        val account = Account()
        account.key = { throw ScoreboardWireException("Signed out", 401) }
        val host = host(store, account)
        val desk = desk(store, Recorder(), account, host)
        desk.start()
        runCurrent()
        assertEquals("", ScoreboardTarget.load(store).userId)
        assertFalse(host.state.value.eligible)
    }

    @Test
    fun `sign-in records the user ID, asks for it when missing, and sign-out discards the key`() = runTest(UnconfinedTestDispatcher()) {
        val store = InMemorySettingsStore()
        val account = Account()
        val host = host(store, account)
        val desk = desk(store, Recorder(), account, host)
        desk.start()
        assertFalse(desk.state.value.overrideToggleEnabled)
        desk.verify("griffey@example.test", "123456")
        runCurrent()
        assertEquals("usr_11111111111111111111JG", ScoreboardTarget.load(store).userId)
        assertEquals(0, account.meCalls)
        assertTrue(host.state.value.eligible)
        assertEquals(EventControlFixtures.one, keys.credentials(server))

        desk.signOut()
        runCurrent()
        assertEquals("", ScoreboardTarget.load(store).userId)
        assertNull(keys.credentials(server))
        assertFalse(host.state.value.eligible)

        account.signedIn = account.signedIn.copy(userId = "")
        account.me = { "usr_11111111111111111111JH" }
        account.key = { EventControlFixtures.credentials("two").toJson() }
        desk.verify("griffey@example.test", "123456")
        runCurrent()
        assertEquals(1, account.meCalls)
        assertEquals("usr_11111111111111111111JH", ScoreboardTarget.load(store).userId)
        assertEquals(EventControlCredentials.decode(EventControlFixtures.credentials("two").toJson()), keys.credentials(server))
        desk.ensureListening()
    }

    @Test
    fun `without event control the toggle is off and nothing listens`() = runTest(UnconfinedTestDispatcher()) {
        val desk = desk(store())
        desk.start()
        desk.setAllowOverride(true)
        desk.ensureListening()
        desk.stop()
        val state = desk.state.value
        assertFalse(state.overrideToggleEnabled)
        assertFalse(state.allowOverride)
        assertFalse(state.eventLocked)
    }

    @Test
    fun `a stored login from before event control loads with no user ID`() {
        val legacy = InMemorySettingsStore(
            mapOf(
                "app.teamstation.cameraman.scoreboard.route" to "event",
                "app.teamstation.cameraman.scoreboard.token" to "token-one",
                "app.teamstation.cameraman.scoreboard.gameId" to gameA
            )
        )
        val loaded = ScoreboardTarget.load(legacy)
        assertEquals("", loaded.userId)
        assertEquals(ScoreboardRoute.Event, loaded.route)
        // A user ID left without a token is not read.
        val orphan = InMemorySettingsStore(mapOf("app.teamstation.cameraman.scoreboard.userId" to "usr_11111111111111111111JG"))
        assertEquals("", ScoreboardTarget.load(orphan).userId)
        assertEquals("", ScoreboardTarget.signedOut(saved()).userId)
    }

    @Test
    fun `the app's settings file stores a whole saved scoreboard in one write`() {
        val store = PreferencesSettingsStore(context, "scoreboard.test")
        ScoreboardTarget.save(store, saved())
        assertEquals(saved(), ScoreboardTarget.load(store))
    }

    @Test
    fun `asking for a code still works beside event control`() = runTest(UnconfinedTestDispatcher()) {
        val desk = desk(InMemorySettingsStore())
        desk.sendCode("griffey@example.test")
        assertEquals("Check your email for a code", desk.state.value.status)
        assertTrue(desk.state.value.awaitingCode)
    }
}
