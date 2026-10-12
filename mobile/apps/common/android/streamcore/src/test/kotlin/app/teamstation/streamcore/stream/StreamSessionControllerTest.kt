package app.teamstation.streamcore.stream

import android.content.Context
import android.net.ConnectivityManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

/**
 * The redial schedule, its reset after 30 s live, the redial when the network comes back, and a 410
 * that ends the stream: TS Director's `StreamSessionControllerTests`, on the port.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StreamSessionControllerTest {
    private class FakePublisher : StreamPublishing {
        val starts = mutableListOf<String>()
        var stops = 0
        var failNext: Throwable? = null
        var gate: CompletableDeferred<Unit>? = null
        var drop: ((String) -> Unit)? = null
        override var running = false
        override var metrics = ProgramStreamer.Metrics(megabitsPerSecond = 2.5, queuedBytes = 1_000)

        override suspend fun start(urlString: String, settings: StreamSettings, onFailure: ((String) -> Unit)?) {
            starts += urlString
            gate?.await()
            failNext?.let {
                failNext = null
                throw it
            }
            drop = onFailure
            running = true
        }

        override fun stop() {
            stops += 1
            running = false
        }
    }

    private class FakeScheduler : StreamRetryScheduling {
        val waits = mutableListOf<Double>()
        var pending: (() -> Unit)? = null
        var cancelled = 0

        override fun schedule(afterSeconds: Double, action: () -> Unit): StreamRetryTimer {
            waits += afterSeconds
            pending = action
            return StreamRetryTimer {
                cancelled += 1
                pending = null
            }
        }

        fun fire() {
            val action = pending
            pending = null
            action?.invoke()
        }
    }

    private class FakeMonitor : NetworkPathMonitoring {
        var restored: (() -> Unit)? = null
        var cancels = 0

        override fun start(onSatisfied: () -> Unit) {
            restored = onSatisfied
        }

        override fun cancel() {
            cancels += 1
            restored = null
        }
    }

    /** Holds every timer until the test fires it, oldest first, as TS Director's `ManualScheduler`. */
    private class ManualScheduler : StreamRetryScheduling {
        inner class Pending(val seconds: Double, val action: () -> Unit) {
            var cancelled = false
        }

        val scheduled = mutableListOf<Pending>()
        val waiting: List<Pending> get() = scheduled.filter { !it.cancelled }

        override fun schedule(afterSeconds: Double, action: () -> Unit): StreamRetryTimer {
            val pending = Pending(afterSeconds, action)
            scheduled += pending
            return StreamRetryTimer { pending.cancelled = true }
        }

        fun fire() {
            val next = waiting.firstOrNull() ?: return
            next.cancelled = true
            next.action()
        }
    }

    private val publisher = FakePublisher()
    private val scheduler = FakeScheduler()
    private val monitor = FakeMonitor()
    private var clock = 0.0
    private val reasons = mutableListOf<StreamSessionController.DialReason>()
    private val events = mutableListOf<String>()
    private var urlFailure: Throwable? = null

    private fun TestScope.controller(retryable: (String) -> Boolean = { true }) = StreamSessionController(
        publisher = publisher,
        host = StreamSessionController.Host(
            requestURL = { reason ->
                reasons += reason
                urlFailure?.let { throw it }
                "rtmp://ingest.example.test/live/${reasons.size}"
            },
            settings = { StreamSettings() },
            isRetryable = retryable,
            willDial = { events += "dial ${it.rawValue}" },
            dropped = { events += "dropped $it" },
            redialing = { events += "redialing" },
            gaveUp = { events += "gave up $it" },
            ended = { events += "ended $it" }
        ),
        scope = this,
        scheduler = scheduler,
        pathMonitor = monitor,
        now = { clock }
    )

    private fun TestScope.stallController(manual: ManualScheduler, retryable: (String) -> Boolean = { true }) =
        StreamSessionController(
            publisher = publisher,
            host = StreamSessionController.Host(
                requestURL = { reason ->
                    reasons += reason
                    urlGate?.await()
                    urlFailure?.let { throw it }
                    "rtmp://ingest.example.test/live/${reasons.size}"
                },
                settings = { StreamSettings() },
                isRetryable = retryable,
                dropped = { events += "dropped $it" },
                redialing = { events += "redialing" },
                gaveUp = { events += "gave up $it" },
                ended = { events += "ended $it" }
            ),
            scope = this,
            scheduler = manual,
            pathMonitor = monitor,
            stallRedialSeconds = 6.0,
            now = { clock }
        )

    private var urlGate: CompletableDeferred<Unit>? = null

    private fun sent(bytes: Long, queued: Int = 1_000) {
        publisher.metrics = publisher.metrics.copy(bytesSent = bytes, queuedBytes = queued)
    }

    @Test
    fun withoutAStallSettingNothingWatchesTheSession() = runTest(UnconfinedTestDispatcher()) {
        val manual = ManualScheduler()
        val controller = StreamSessionController(
            publisher = publisher,
            host = StreamSessionController.Host(requestURL = { "rtmp://ingest.example.test/live/key" }, settings = { StreamSettings() }),
            scope = this,
            scheduler = manual,
            now = { clock }
        )
        controller.start()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertNull(controller.stallRedialSeconds)
        assertTrue(manual.waiting.isEmpty())
    }

    @Test
    fun aStuckSessionIsReplacedAndDialsGoEveryTwoSecondsUntilOneIsLive() = runTest(UnconfinedTestDispatcher()) {
        val manual = ManualScheduler()
        val controller = stallController(manual)
        controller.start()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        // The socket takes bytes until 3 s in, then nothing while bytes wait.
        for (second in 1..8) {
            clock = second.toDouble()
            if (second <= 3) sent(second * 1_000L)
            assertEquals(listOf(1.0), manual.waiting.map { it.seconds })
            manual.fire()
            assertEquals("still live at $second s", StreamSessionController.Phase.LIVE, controller.phase)
        }
        // Six seconds without progress: replaced at once, and the next dial is refused.
        publisher.failNext = IllegalStateException("connection refused")
        clock = 9.0
        val stuck = publisher.drop!!
        manual.fire()
        assertEquals("dropped ${StreamSessionController.stalledError}", events.first { it.startsWith("dropped") })
        assertTrue(controller.replacingStall)
        assertEquals(listOf(StreamSessionController.DialReason.START, StreamSessionController.DialReason.REDIAL), reasons)
        assertEquals(2, publisher.starts.size)
        // That dial failed at once: the next goes 2 s after it began.
        assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
        assertEquals(2.0, controller.retryInSeconds)
        // The stuck session's own drop, reported late, is not acted on.
        stuck("send timed out")
        assertEquals(2.0, controller.retryInSeconds)
        clock = 11.0
        val gate = CompletableDeferred<Unit>()
        urlGate = gate
        manual.fire()
        assertEquals(StreamSessionController.Phase.CONNECTING, controller.phase)
        // This one hangs, as a dial into an outage does: at 2 s it is given up for the next.
        assertEquals(listOf(2.0), manual.waiting.map { it.seconds })
        urlGate = null
        clock = 13.0
        manual.fire()
        assertEquals("dropped ${StreamSessionController.stalledDialError}", events.last { it.startsWith("dropped") })
        assertEquals(0.0, controller.retryInSeconds)
        manual.fire()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertFalse(controller.replacingStall)
        assertNull(controller.lastError)
        assertEquals(4, reasons.size)
        // The hung dial's late answer belongs to a dial given up.
        gate.complete(Unit)
        runCurrent()
        assertEquals(3, publisher.starts.size)
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        // The new session is watched in its turn, and a drop of it waits the normal 3 s.
        assertEquals(listOf(1.0), manual.waiting.map { it.seconds })
        publisher.drop!!("socket write failed")
        assertEquals(3.0, controller.retryInSeconds)
        assertEquals(listOf(3.0), manual.waiting.map { it.seconds })
    }

    @Test
    fun aSlowSessionOrOneWithNothingToSendIsNotStuck() = runTest(UnconfinedTestDispatcher()) {
        val manual = ManualScheduler()
        val controller = stallController(manual)
        controller.start()
        for (second in 1..20) {
            clock = second.toDouble()
            // A byte a second for ten seconds, then nothing queued for ten.
            if (second <= 10) sent(second.toLong()) else sent(10, queued = 0)
            manual.fire()
        }
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertTrue(events.none { it.startsWith("dropped") })
        controller.stop()
        assertTrue(manual.waiting.isEmpty())
    }

    @Test
    fun aStallFollowedByAnEndedStreamOrARefusedAddressStopsReplacing() = runTest(UnconfinedTestDispatcher()) {
        val manual = ManualScheduler()
        val controller = stallController(manual, retryable = { !it.startsWith("stream URL") })
        controller.start()
        urlFailure = StreamEndedError()
        for (second in 1..7) {
            clock = second.toDouble()
            manual.fire()
        }
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertEquals(StreamSessionController.endedError, controller.lastError)
        assertFalse(controller.replacingStall)
        assertTrue(manual.waiting.isEmpty())

        urlFailure = null
        controller.start()
        for (second in 8..14) {
            clock = second.toDouble()
            if (second == 13) publisher.failNext = IllegalStateException("stream URL must start with rtmp://")
            manual.fire()
        }
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertEquals("gave up stream URL must start with rtmp://", events.last())
        assertFalse(controller.replacingStall)
    }

    @Test
    fun theStallWatchOnItsOwn() {
        val watch = StreamStallWatch(6.0)
        watch.live(0.0)
        val readings = listOf(
            Triple(1.0, 10L, 5), Triple(5.0, 10L, 5),
            // Progress, then nothing queued, each start the six seconds again.
            Triple(6.0, 11L, 5), Triple(11.0, 11L, 5), Triple(12.0, 11L, 0), Triple(17.0, 11L, 5), Triple(18.0, 11L, 5)
        ).map { (at, bytes, queued) -> watch.check(at, bytes, queued) }
        assertEquals(listOf(false, false, false, false, false, false, true), readings)
        watch.live(20.0)
        assertTrue(watch.check(26.0, 10, 5))
        assertEquals(StreamStallWatch.checkSeconds, StreamStallWatch(0.0).redialSeconds, 0.0)
        assertEquals(1.5, StreamStallWatch.waitAfterFailedDial(0.5), 0.0)
        assertEquals(0.0, StreamStallWatch.waitAfterFailedDial(3.0), 0.0)
        assertEquals(2.0, StreamStallWatch.waitAfterFailedDial(-1.0), 0.0)
    }

    @Test
    fun theWaitDoublesToThirtyAndResetsAfterThirtySecondsLive() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller()
        controller.start()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertEquals(listOf(StreamSessionController.DialReason.START), reasons)
        // Five drops a second after each dial: 3, 6, 12, 24, 30.
        repeat(5) {
            clock += 1
            publisher.drop!!("socket write failed")
            assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
            scheduler.fire()
        }
        assertEquals(listOf(3.0, 6.0, 12.0, 24.0, 30.0), scheduler.waits)
        assertEquals(StreamSessionController.DialReason.REDIAL, reasons.last())
        // A session that held 45 s: the next wait starts over at 3.
        clock += 45
        publisher.drop!!("socket write failed")
        assertEquals(3.0, controller.retryInSeconds)
        assertEquals(6.0, controller.nextRetrySeconds, 0.0)
        assertEquals("socket write failed", controller.lastError)
        assertTrue(events.contains("redialing"))
        controller.stop()
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertEquals(1, scheduler.cancelled)
        assertFalse(controller.wanted)
    }

    @Test
    fun theNetworkComingBackRedialsAtOnce() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller()
        controller.start()
        publisher.drop!!("no route to host")
        assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
        val dials = publisher.starts.size
        monitor.restored!!()
        runCurrent()
        assertEquals(dials + 1, publisher.starts.size)
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertNull(scheduler.pending)
        // Restored while live is nothing to act on.
        controller.networkRestored()
        assertEquals(dials + 1, publisher.starts.size)
    }

    @Test
    fun aGoneStreamEndsTheControllerUntilItsHostStartsAgain() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller()
        controller.start()
        publisher.drop!!("server closed the socket")
        urlFailure = StreamEndedError()
        scheduler.fire()
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertEquals(StreamSessionController.endedError, controller.lastError)
        assertFalse(controller.wanted)
        assertTrue(events.last().startsWith("ended This camera was ended"))
        assertEquals(1, monitor.cancels)
        // Nothing dials until the host starts again, with .start.
        controller.networkRestored()
        urlFailure = null
        controller.start()
        assertEquals(StreamSessionController.DialReason.START, reasons.last())
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
    }

    @Test
    fun aFailureItWillNotRetryGivesUp() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller(retryable = { !it.startsWith("stream URL") })
        publisher.failNext = IllegalStateException("stream URL must start with rtmp://")
        controller.start()
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertEquals("gave up stream URL must start with rtmp://", events.last())
        assertTrue(scheduler.waits.isEmpty())
    }

    @Test
    fun anAddressThatCannotBeHadIsRetried() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller()
        urlFailure = IllegalStateException("offline")
        controller.start()
        assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
        assertEquals("offline", controller.lastError)
        urlFailure = null
        scheduler.fire()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertNull(controller.lastError)
        assertEquals(2.5, controller.refreshCongestion().megabitsPerSecond, 0.0)
        assertEquals(2.5, controller.congestion.megabitsPerSecond, 0.0)
    }

    @Test
    fun aDropForAReplacedSessionIsIgnored() = runTest(UnconfinedTestDispatcher()) {
        val controller = controller()
        controller.start()
        val stale = publisher.drop!!
        controller.stop()
        stale("late")
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
        assertNull(controller.lastError)
        // A stop while the address is being asked for leaves nothing to dial.
        val gate = CompletableDeferred<Unit>()
        publisher.gate = gate
        controller.start()
        assertEquals(StreamSessionController.Phase.CONNECTING, controller.phase)
        controller.stop()
        gate.complete(Unit)
        assertEquals(StreamSessionController.Phase.IDLE, controller.phase)
    }

    @Test
    fun theDefaultSchedulerWaitsOnTheScope() = runTest {
        val controller = StreamSessionController(
            publisher = publisher,
            host = StreamSessionController.Host(requestURL = { "rtmp://ingest.example.test/live/key" }, settings = { StreamSettings() }),
            scope = this,
            now = { clock }
        )
        controller.start()
        runCurrent()
        publisher.drop!!("gone")
        runCurrent()
        assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
        advanceTimeBy(2_999)
        runCurrent()
        assertEquals(1, publisher.starts.size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, publisher.starts.size)
        controller.stop()
    }

    @Test
    fun theNetworkCallbackReportsOnlyAReturn() {
        val context = RuntimeEnvironment.getApplication() as Context
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val monitor = ConnectivityNetworkMonitor(context)
        var restored = 0
        monitor.start { restored += 1 }
        val callback = shadowOf(connectivity).networkCallbacks.single()
        val network = ShadowNetwork.newInstance(7)
        callback.onAvailable(network)
        assertEquals(0, restored)
        callback.onLost(network)
        callback.onAvailable(network)
        assertEquals(1, restored)
        monitor.start { restored += 10 }
        assertEquals(1, shadowOf(connectivity).networkCallbacks.size)
        monitor.cancel()
        monitor.cancel()
        assertTrue(shadowOf(connectivity).networkCallbacks.isEmpty())
    }

    @Test
    fun aDropRedialsAsSoonAsTheDefaultNetworkReturns() = runTest(UnconfinedTestDispatcher()) {
        val context = RuntimeEnvironment.getApplication() as Context
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        val controller = StreamSessionController(
            publisher = publisher,
            host = StreamSessionController.Host(requestURL = { "rtmp://ingest.example.test/live/key" }, settings = { StreamSettings() }),
            scope = this,
            scheduler = scheduler,
            pathMonitor = ConnectivityNetworkMonitor(context),
            now = { clock }
        )
        controller.start()
        val callback = shadowOf(connectivity).networkCallbacks.single()
        val network = ShadowNetwork.newInstance(3)
        callback.onAvailable(network)
        callback.onLost(network)
        publisher.drop!!("network is unreachable")
        assertEquals(StreamSessionController.Phase.RETRYING, controller.phase)
        assertEquals(3.0, controller.retryInSeconds)
        callback.onAvailable(network)
        runCurrent()
        assertEquals(StreamSessionController.Phase.LIVE, controller.phase)
        assertEquals(2, publisher.starts.size)
        assertEquals(1, scheduler.cancelled)
        controller.stop()
        assertTrue(shadowOf(connectivity).networkCallbacks.isEmpty())
    }
}
