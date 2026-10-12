package app.teamstation.cameraman.eventcontrol

import android.content.Context
import app.teamstation.streamcore.core.InMemorySettingsStore
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.security.ProviderException
import java.security.Security

/** Seals nothing; the Keystore itself is [EventControlKeyStoreTest]'s. */
internal object ClearSealer : EventControlSealer {
    override fun seal(plain: ByteArray): ByteArray = plain
    override fun open(sealed: ByteArray): ByteArray = sealed
}

/**
 * Event control as the app runs it: consent kept across restarts, the key fetched with the
 * device's own token and kept per account, the listener up only while signed in with a key and
 * consent, and the lease ended by consent off, sign-out, another account and a restart.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlHostTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val io = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val hosts = ArrayList<EventControlHost>()
    private val settings = InMemorySettingsStore()
    private val keys = EventControlKeyStore(
        { context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE) },
        ClearSealer
    )
    private val server = "https://app.example.test"
    private val one = EventControlAccount(server, "1001", "token-one")
    private val two = EventControlAccount(server, "1002", "token-two")
    private var clock = 1_790_013_600_000L

    /** Answers by token; a token not listed throws [missing]. */
    private val replies = HashMap<String, () -> EventControlCredentials>()
    private val fetches = ArrayList<String>()
    private val fetcher = EventControlKeyFetcher { _, token ->
        fetches += token
        (replies[token] ?: { throw EventControlFetchException(EventControlFetchFailure.Offline, "offline") })()
    }

    @Before
    fun clean() {
        context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE).edit().clear().commit()
        replies["token-one"] = { EventControlFixtures.credentials("one") }
        replies["token-two"] = { EventControlFixtures.credentials("two") }
    }

    @After
    fun tearDown() {
        hosts.forEach { it.stop() }
        appScopes.forEach { it.cancel() }
        io.cancel()
    }

    private fun freePorts(): List<Int> = (0 until 2).map { ServerSocket(0).use { socket -> socket.localPort } }

    /** What would have reached the main thread's uncaught handler and ended the app. */
    private val uncaught = ArrayList<Throwable>()
    private val appScopes = ArrayList<CoroutineScope>()

    /** Shaped like the app's own scope: a supervisor and no handler but this test's recorder. */
    private fun TestScope.appScope(): CoroutineScope =
        CoroutineScope(
            SupervisorJob() + UnconfinedTestDispatcher(testScheduler) +
                CoroutineExceptionHandler { _, error -> uncaught += error }
        ).also { appScopes += it }

    private fun TestScope.host(
        ports: List<Int> = freePorts(),
        keys: EventControlKeyStore = this@EventControlHostTest.keys,
        scope: CoroutineScope = backgroundScope
    ): EventControlHost {
        val dispatcher = UnconfinedTestDispatcher(testScheduler)
        return EventControlHost(
            settings = settings,
            keys = keys,
            fetcher = fetcher,
            scope = scope,
            io = io,
            main = dispatcher,
            ioContext = dispatcher,
            retryMs = 60_000,
            ports = ports,
            leaseScope = null,
            now = { clock }
        ).also { hosts += it }
    }

    /** A committer that writes nothing and records what it was asked. */
    private class Commits : EventControlCommitter {
        val applied = ArrayList<EventAssignment>()
        var before: () -> Unit = {}
        override fun commit(assignment: EventAssignment, check: () -> EventControlAckStatus?): EventControlAckStatus {
            before()
            check()?.let { return it }
            applied += assignment
            return EventControlAckStatus.Applied
        }
    }

    @Test
    fun `consent is off by default, kept across a restart, and the instance ID with it`() = runTest(UnconfinedTestDispatcher()) {
        val first = host()
        assertFalse(first.state.value.consent)
        first.setConsent(true)
        first.setConsent(true)
        assertEquals("1", settings.string(EventControlHost.KEY_CONSENT))
        val second = host()
        assertTrue(second.state.value.consent)
        assertTrue(second.receiver.isConsenting)
        assertEquals(first.instanceId, second.instanceId)
        assertNull("a restart restores no lease", second.state.value.override)
    }

    @Test
    fun `the listener runs only while started, signed in with a key, and consenting`() = runTest(UnconfinedTestDispatcher()) {
        val ports = freePorts()
        val host = host(ports)
        host.setConsent(true)
        host.start()
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
        assertFalse(host.state.value.eligible)

        host.setAccount(one)
        assertEquals(listOf("token-one"), fetches)
        assertTrue(host.state.value.eligible)
        assertEquals(EventControlListenerState.Listening(ports[0]), host.state.value.listener)
        assertEquals(EventControlFixtures.one, keys.credentials(server))
        host.ensureListening()
        assertEquals(EventControlListenerState.Listening(ports[0]), host.state.value.listener)

        // Consent off: the listener goes; on again, it comes back with the cached key, no fetch.
        host.setConsent(false)
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
        host.setConsent(true)
        assertEquals(EventControlListenerState.Listening(ports[0]), host.state.value.listener)
        assertEquals(1, fetches.size)

        host.stop()
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
        host.ensureListening()
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
    }

    @Test
    fun `a cached key needs no fetch, offline included`() = runTest(UnconfinedTestDispatcher()) {
        keys.save(EventControlFixtures.one, server)
        replies.clear()
        val host = host()
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        assertTrue(host.state.value.eligible)
        assertTrue(fetches.isEmpty())
    }

    @Test
    fun `a cached key for another user of the server is discarded and fetched again`() = runTest(UnconfinedTestDispatcher()) {
        keys.save(EventControlFixtures.credentials("two"), server)
        val host = host()
        host.start()
        host.setAccount(one)
        assertEquals(listOf("token-one"), fetches)
        assertEquals(EventControlFixtures.one, keys.credentials(server))
    }

    @Test
    fun `offline waits and tries again, and a refused session clears eligibility`() = runTest(UnconfinedTestDispatcher()) {
        replies.remove("token-one")
        var refused = 0
        val host = host()
        host.onUnauthorized = { refused += 1 }
        host.setConsent(true)
        host.start()
        host.setAccount(one)
        assertFalse(host.state.value.eligible)
        assertEquals("Waiting for this account's Director key", host.state.value.status)
        advanceTimeBy(60_001)
        assertEquals(2, fetches.size)

        replies["token-one"] = { throw EventControlFetchException(EventControlFetchFailure.Unauthorized, "401") }
        advanceTimeBy(60_001)
        assertEquals(3, fetches.size)
        assertEquals(1, refused)
        assertFalse(host.state.value.eligible)
        assertEquals("", host.state.value.status)
        advanceTimeBy(120_000)
        assertEquals("no retry after a refusal", 3, fetches.size)
    }

    @Test
    fun `a server that does not offer event control is not asked again until the account changes`() =
        runTest(UnconfinedTestDispatcher()) {
            replies["token-one"] = { throw EventControlFetchException(EventControlFetchFailure.Unavailable, "503") }
            val host = host()
            host.setConsent(true)
            host.start()
            host.setAccount(one)
            assertEquals(listOf("token-one"), fetches)
            assertFalse(host.state.value.eligible)
            assertNull(keys.credentials(server))
            assertEquals("Not offered by this account server", host.state.value.status)
            advanceTimeBy(600_000)
            host.stop()
            host.start()
            assertEquals("not asked again, however long it runs or restarts", 1, fetches.size)

            host.setAccount(two)
            assertEquals(listOf("token-one", "token-two"), fetches)
            assertTrue(host.state.value.eligible)
            assertEquals("", host.state.value.status)
        }

    @Test
    fun `a reply that is no key is final until the account changes, and an unread reply is offline`() =
        runTest(UnconfinedTestDispatcher()) {
            replies["token-one"] = { throw IOException("connection reset while reading") }
            val host = host()
            host.setConsent(true)
            host.start()
            host.setAccount(one)
            assertEquals("Waiting for this account's Director key", host.state.value.status)
            replies["token-one"] = { EventControlCredentials.decode("{\"version\":1}") }
            advanceTimeBy(60_001)
            assertEquals(2, fetches.size)
            assertEquals("Not offered by this account server", host.state.value.status)
            advanceTimeBy(600_000)
            assertEquals(2, fetches.size)

            host.setAccount(null)
            assertEquals("", host.state.value.status)
            replies["token-one"] = { EventControlFixtures.credentials("one") }
            host.setAccount(one)
            assertEquals(3, fetches.size)
            assertTrue(host.state.value.eligible)
        }

    @Test
    fun `a key that names another user is not this session's`() = runTest(UnconfinedTestDispatcher()) {
        replies["token-one"] = { EventControlFixtures.credentials("two") }
        var refused = 0
        val host = host()
        host.onUnauthorized = { refused += 1 }
        host.start()
        host.setAccount(one)
        assertEquals(1, refused)
        assertNull(keys.credentials(server))
    }

    /** Fails to seal until [working]; counts the resets of its key. */
    private class BrokenSealer : EventControlSealer {
        var working = false
        var resets = 0
        override fun seal(plain: ByteArray): ByteArray =
            if (working) plain else throw ProviderException("Keystore operation failed")
        override fun open(sealed: ByteArray): ByteArray = sealed
        override fun reset() {
            resets += 1
        }
    }

    private fun preferences() = context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE)

    @Test
    fun `a key the Keystore cannot seal is kept in memory for this run, said in the status, and its alias reset`() =
        runTest(UnconfinedTestDispatcher()) {
            val sealer = BrokenSealer()
            val keys = EventControlKeyStore(::preferences, sealer)
            val ports = freePorts()
            val host = host(ports, keys, appScope())
            val commits = Commits()
            host.committer = commits
            host.setConsent(true)
            host.start()
            host.setAccount(one)

            assertEquals(listOf("token-one"), fetches)
            assertEquals(1, sealer.resets)
            assertEquals("nothing kept for the next launch", emptyMap<String, Any>(), preferences().all)
            assertTrue(host.state.value.eligible)
            assertEquals(EventControlListenerState.Listening(ports[0]), host.state.value.listener)
            assertEquals("Could not store this device's key", host.state.value.status)
            assertEquals(emptyList<Throwable>(), uncaught)

            // The receiver works with the key in memory.
            assertEquals(EventControlAckStatus.Applied, TestDirector(host.receiver).take(100, "gam_demoA"))
            assertEquals(listOf("gam_demoA"), commits.applied.map { it.gameId })

            // Signed in again, it fetches again, and a save that works clears the status.
            sealer.working = true
            host.setAccount(null)
            host.setAccount(one)
            assertEquals(2, fetches.size)
            assertEquals(EventControlFixtures.one, keys.credentials(server))
            assertEquals("", host.state.value.status)
        }

    @Test
    fun `a Keystore that cannot make its key leaves the receiver working on the key in memory`() =
        runTest(UnconfinedTestDispatcher()) {
            FakeKeys.keys.clear()
            FakeKeys.failGenerate = true
            Security.addProvider(FakeAndroidKeyStore())
            try {
                val keys = EventControlKeyStore(::preferences, KeystoreSealer(alias = "test.host"))
                val host = host(keys = keys, scope = appScope())
                host.committer = Commits()
                host.setConsent(true)
                host.start()
                host.setAccount(one)
                assertTrue(host.state.value.eligible)
                assertEquals("Could not store this device's key", host.state.value.status)
                assertNull(keys.credentials(server))
                assertEquals(EventControlAckStatus.Applied, TestDirector(host.receiver).take(100, "gam_demoA"))
                assertEquals(emptyList<Throwable>(), uncaught)
            } finally {
                FakeKeys.failGenerate = false
                Security.removeProvider("AndroidKeyStore")
            }
        }

    @Test
    fun `an error of the app's own while handling the key never leaves the fetch`() = runTest(UnconfinedTestDispatcher()) {
        // A refusal handler that throws.
        replies["token-one"] = { EventControlFixtures.credentials("two") }
        var refused = 0
        val host = host(scope = appScope())
        host.onUnauthorized = {
            refused += 1
            throw IllegalStateException("handler failed")
        }
        host.setConsent(true)
        host.start()
        host.setAccount(one)
        assertEquals(1, refused)
        assertFalse(host.state.value.eligible)
        assertEquals(emptyList<Throwable>(), uncaught)

        // A store that fails underneath a fetch for the current account: said in the status.
        var broken = false
        val failing = EventControlKeyStore({
            check(!broken) { "preferences unavailable" }
            preferences()
        }, ClearSealer)
        replies["token-two"] = {
            broken = true
            throw EventControlFetchException(EventControlFetchFailure.Unavailable, "503")
        }
        val other = host(keys = failing, scope = appScope())
        other.setConsent(true)
        other.start()
        other.setAccount(two)
        assertEquals(listOf("token-one", "token-two"), fetches)
        assertFalse(other.state.value.eligible)
        assertEquals("Could not get this account's Director key", other.state.value.status)
        assertEquals(emptyList<Throwable>(), uncaught)
    }

    @Test
    fun `an assignment commits through the app and takes the lease, and consent off releases it`() = runTest(UnconfinedTestDispatcher()) {
        val host = host()
        val commits = Commits()
        host.committer = commits
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        val director = TestDirector(host.receiver)
        assertEquals(EventControlAckStatus.Applied, director.take(100, "gam_demoA"))
        assertEquals(listOf("gam_demoA"), commits.applied.map { it.gameId })
        runCurrent()
        assertEquals("192.0.2.10", host.state.value.override?.ownerHost)

        host.setConsent(false)
        runCurrent()
        assertNull(host.state.value.override)
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
    }

    @Test
    fun `the commit refuses when consent, the account or the lease moved underneath it`() = runTest(UnconfinedTestDispatcher()) {
        val host = host()
        val commits = Commits()
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        val director = TestDirector(host.receiver)
        assertEquals("no committer yet", EventControlAckStatus.Failed, director.take(1, "gam_demoA"))
        host.committer = commits

        // Consent off stops the listener, which restarts the receiver: of the two interruptions of
        // this apply the last one wins (README.md, "Receiver"), so the Director hears expired.
        commits.before = { host.setConsent(false) }
        assertEquals(EventControlAckStatus.Expired, director.assign(2, "gam_demoA").let { (it as EventControlBody.Ack).status })
        assertTrue(commits.applied.isEmpty())
        host.setConsent(true)

        // Consent off stopped the listener, which took the session with it: discover again.
        commits.before = { host.setAccount(two) }
        assertEquals(EventControlAckStatus.WrongAccount, director.take(3, "gam_demoA"))
        assertTrue(commits.applied.isEmpty())
        commits.before = {}
    }

    @Test
    fun `the commit's own check sees another owner and an older revision`() = runTest(UnconfinedTestDispatcher()) {
        val host = host()
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        val guards = ArrayList<() -> EventControlAckStatus?>()
        var answer = EventControlAckStatus.Failed
        host.committer = EventControlCommitter { _, guard ->
            guards += guard
            guard() ?: answer
        }
        val a = TestDirector(host.receiver)
        val b = TestDirector(host.receiver, instance = "0000000000000000000000000000d002", connection = 2)
        // Two commits that failed, and so took no lease: B's at 50, A's at 90.
        assertEquals(EventControlAckStatus.Failed, b.take(50, "gam_demoB"))
        assertEquals(EventControlAckStatus.Failed, a.take(90, "gam_demoA"))
        answer = EventControlAckStatus.Applied
        assertEquals(EventControlAckStatus.Applied, a.assign(100, "gam_demoA").let { (it as EventControlBody.Ack).status })
        assertEquals(100L, host.receiver.overrideState?.revision)
        // Their checks, run now, see A's lease at 100.
        assertEquals(EventControlAckStatus.Busy, guards[0]())
        assertEquals(EventControlAckStatus.Stale, guards[1]())
        assertNull(guards[2]())
    }

    @Test
    fun `sign-out and another account discard the key and end the lease`() = runTest(UnconfinedTestDispatcher()) {
        val host = host()
        host.committer = Commits()
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        val events = ArrayList<EventOverride?>()
        backgroundScope.launch { host.state.collect { events += it.override } }
        assertEquals(EventControlAckStatus.Applied, TestDirector(host.receiver).take(100, "gam_demoA"))
        runCurrent()
        assertNotNull(host.state.value.override)

        host.setAccount(one.copy(token = "token-one"))
        assertNotNull("the same account again changes nothing", host.state.value.override)

        host.setAccount(two)
        runCurrent()
        assertNull(host.state.value.override)
        assertEquals(EventControlFixtures.credentials("two"), keys.credentials(server))
        assertTrue(host.state.value.eligible)

        host.setAccount(null)
        assertNull(keys.credentials(server))
        assertFalse(host.state.value.eligible)
        assertEquals(EventControlListenerState.Stopped, host.state.value.listener)
        assertTrue(events.contains(null))
    }

    @Test
    fun `a peer with another secret's key makes the device fetch its own again, once a minute`() = runTest(UnconfinedTestDispatcher()) {
        val host = host()
        host.committer = Commits()
        host.setConsent(true)
        host.setAccount(one)
        host.start()
        assertEquals(EventControlAckStatus.Applied, TestDirector(host.receiver).take(100, "gam_demoA"))
        replies["token-one"] = { EventControlFixtures.credentials("oneRotated") }

        val rotated = TestDirector(host.receiver, connection = 2, key = EventControlFixtures.credentials("oneRotated"))
        assertEquals(EventControlBody.Ack(EventControlAckStatus.KeyMismatch, 0), rotated.discover())
        runCurrent()
        assertEquals(2, fetches.size)
        assertEquals(EventControlFixtures.credentials("oneRotated"), keys.credentials(server))
        assertNull("a key from another secret ends the lease", host.state.value.override)

        TestDirector(host.receiver, connection = 3).discover()
        runCurrent()
        assertEquals("rate limited", 2, fetches.size)
    }

    @Test
    fun `both ports taken is said in the status`() = runTest(UnconfinedTestDispatcher()) {
        val ports = freePorts()
        val held = ports.map { port -> ServerSocket().apply { bind(InetSocketAddress(port)) } }
        try {
            val host = host(ports)
            host.setConsent(true)
            host.setAccount(one)
            host.start()
            runCurrent()
            assertEquals(EventControlListenerState.PortsUnavailable(ports), host.state.value.listener)
            assertEquals("Ports ${ports[0]} and ${ports[1]} are in use", host.state.value.status)
        } finally {
            held.forEach { it.close() }
        }
    }

    @Test
    fun `an account shows its token as redacted`() {
        assertFalse(one.toString().contains("token-one"))
    }
}
