package app.teamstation.streamcore.stream

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** What a stream session publishes through: [ProgramStreamer], or a fake in a test. */
interface StreamPublishing {
    val running: Boolean
    val metrics: ProgramStreamer.Metrics

    /**
     * Opens an encoder and a publish to [urlString]. [onFailure] is told once when the publish drops
     * by itself afterwards.
     */
    suspend fun start(urlString: String, settings: StreamSettings, onFailure: ((String) -> Unit)?)

    fun stop()
}

/** Tells the controller when the device's network comes back. */
interface NetworkPathMonitoring {
    /** Starts watching. [onSatisfied] is called each time the network goes from unusable to usable. */
    fun start(onSatisfied: () -> Unit)

    fun cancel()
}

/**
 * The device's default network through `ConnectivityManager.NetworkCallback`, reporting only its
 * returns: TS Director's `NWPathMonitor` transitions to `satisfied`. The callback's first
 * `onAvailable` is the state at registration, not a change, so it reports nothing.
 */
class ConnectivityNetworkMonitor(context: Context) : NetworkPathMonitoring {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun start(onSatisfied: () -> Unit) {
        cancel()
        val registered = object : ConnectivityManager.NetworkCallback() {
            private var satisfied: Boolean? = null

            override fun onAvailable(network: Network) {
                val was = satisfied
                satisfied = true
                if (was == false) onSatisfied()
            }

            override fun onLost(network: Network) {
                satisfied = false
            }
        }
        callback = registered
        connectivity?.registerDefaultNetworkCallback(registered)
    }

    override fun cancel() {
        val registered = callback ?: return
        callback = null
        runCatching { connectivity?.unregisterNetworkCallback(registered) }
    }
}

/** Runs work after a delay, cancellably. Injected so a test can run the redial schedule without waiting. */
fun interface StreamRetryScheduling {
    fun schedule(afterSeconds: Double, action: () -> Unit): StreamRetryTimer
}

fun interface StreamRetryTimer {
    fun cancel()
}

/**
 * The waits between redials: 3 s, doubling to 30 s, back to 3 s after a session that held for 30 s.
 * Pure, so the schedule is a fixture shared with TS Director's `StreamRetrySchedule`.
 */
class StreamRetrySchedule {
    /** What the next redial waits. */
    var next: Double = firstRetrySeconds
        private set

    /** A host started streaming: the first redial waits the least again. */
    fun started() {
        next = firstRetrySeconds
    }

    /**
     * A session dropped after [liveFor] seconds live (null: it never went live). Answers how long to
     * wait before the redial, and doubles the wait after it.
     */
    fun dropped(liveFor: Double?): Double {
        if (liveFor != null && liveFor >= liveResetSeconds) next = firstRetrySeconds
        val wait = next
        next = minOf(wait * 2, longestRetrySeconds)
        return wait
    }

    companion object {
        const val firstRetrySeconds = 3.0
        const val longestRetrySeconds = 30.0
        const val liveResetSeconds = 30.0
    }
}

/**
 * Tells a live session that has stopped moving from one that is only slow, and paces the dials that
 * replace it. Pure, so its decisions are a fixture shared with TS Director's `StreamStallWatch`.
 *
 * A session is stuck when the socket has taken no byte for [redialSeconds] while bytes are waiting for
 * it. A link that carries anything at all is not stuck, however slowly it drains, and a session with
 * nothing queued is idle, not stuck. Once stuck, its replacements are dialled every [retrySeconds],
 * counted from when each dial began, until one goes live.
 */
class StreamStallWatch(redialSeconds: Double) {
    /** How long a session may take nothing while bytes wait before it counts as stuck. */
    val redialSeconds: Double = maxOf(redialSeconds, checkSeconds)
    private var lastBytesSent: Long? = null
    private var movedAt = 0.0

    /** A session went live at [now]: it has moved as of then. */
    fun live(now: Double) {
        lastBytesSent = null
        movedAt = now
    }

    /** One reading of the session: whether it is stuck now. */
    fun check(now: Double, bytesSent: Long, queuedBytes: Int): Boolean {
        val last = lastBytesSent
        lastBytesSent = bytesSent
        if (last == null) return now - movedAt >= redialSeconds && queuedBytes > 0
        if (bytesSent != last || queuedBytes <= 0) {
            movedAt = now
            return false
        }
        return now - movedAt >= redialSeconds
    }

    companion object {
        /** How often a live session's progress is read. */
        const val checkSeconds = 1.0

        /** How far apart the dials that replace a stuck session start. */
        const val retrySeconds = 2.0

        /** How long after a replacement dial failed, [dialledFor] seconds after it began, the next one goes. */
        fun waitAfterFailedDial(dialledFor: Double): Double = maxOf(0.0, retrySeconds - maxOf(0.0, dialledFor))
    }
}

/**
 * Thrown by a host's URL request when the server has ended the stream this device holds (a 410): the
 * controller stops redialling until its host starts streaming again.
 */
class StreamEndedError(
    override val message: String = "This camera was ended. Start streaming again to go live."
) : Exception(message)

/**
 * Keeps one programme stream on the air for as long as its host wants it there. A port of TS
 * Director's `StreamSessionController`.
 *
 * It asks its host for the address to publish to, opens a [ProgramStreamer] session on it, and puts
 * the stream back when it drops by itself.
 * - The first redial waits 3 s, and each one after doubles the wait, to 30 s at most.
 * - A session that stayed live for 30 s puts the wait back to 3 s.
 * - The network coming back (`NetworkCallback.onAvailable` after a loss) redials at once.
 * - A URL request that throws [StreamEndedError] is terminal: the controller goes to `IDLE` with
 *   [lastError] "ended" and dials nothing until its host calls [start] again.
 *
 * - With [stallRedialSeconds] set, a live session whose socket has taken nothing for that long while
 *   bytes wait for it ([StreamStallWatch]) is stuck: the controller goes to `RETRYING`, closes it and
 *   dials a fresh one at once, rather than waiting for the system's TCP backoff or the server's
 *   stale-publisher timeout to notice. Until a dial goes live, dials start every
 *   [StreamStallWatch.retrySeconds], and one that has not gone live by then is given up for the next;
 *   after that the normal waits apply again. A phone sets it; TS Director leaves it null.
 *
 * The first dial of a [start] asks for the address with [DialReason.START]; every redial asks with
 * [DialReason.REDIAL], which a host passes on to the server so that an ended stream stays ended.
 *
 * Every method, and every host closure, runs on [scope]'s dispatcher, which must run one thing at a
 * time: the main thread on a device, TS Director's main actor.
 */
class StreamSessionController(
    private val publisher: StreamPublishing,
    private val host: Host,
    private val scope: CoroutineScope,
    scheduler: StreamRetryScheduling? = null,
    private val pathMonitor: NetworkPathMonitoring? = null,
    /** How long a live session may take nothing while bytes wait before it is replaced; null: never. */
    val stallRedialSeconds: Double? = null,
    private val now: () -> Double = { System.nanoTime() / 1e9 }
) {
    enum class Phase(val rawValue: String) {
        IDLE("idle"),
        CONNECTING("connecting"),
        LIVE("live"),
        RETRYING("retrying")
    }

    /** Why the address is being asked for. */
    enum class DialReason(val rawValue: String) {
        /** The host started streaming: anything may be handed out, including a fresh stream. */
        START("start"),

        /** Putting back a stream that dropped: only the stream already held. */
        REDIAL("redial")
    }

    /** What the host does around a session. */
    class Host(
        /** The address to publish to. */
        val requestURL: suspend (DialReason) -> String,
        /** The settings the next session opens with. */
        val settings: () -> StreamSettings,
        /** Words for a dial that failed. */
        val explainDialFailure: suspend (Throwable) -> String = { it.message ?: it.javaClass.simpleName },
        /** Words for an address that could not be had. */
        val explainURLFailure: (Throwable) -> String = { it.message ?: it.javaClass.simpleName },
        /** Whether a failure is worth dialling again after. */
        val isRetryable: (String) -> Boolean = { true },
        /** Before every dial, the first included. */
        val willDial: (DialReason) -> Unit = {},
        /** The session dropped or never opened, with why. */
        val dropped: (String) -> Unit = {},
        /** A redial is starting, after its wait. */
        val redialing: () -> Unit = {},
        /** The controller gave up on a failure it will not retry, while its host still wanted it. */
        val gaveUp: (String) -> Unit = {},
        /** The server ended the stream ([StreamEndedError]). */
        val ended: (String) -> Unit = {}
    )

    var phase: Phase = Phase.IDLE
        private set

    /** How long until the next redial, while retrying. */
    var retryInSeconds: Double? = null
        private set

    /** Why the last session dropped or failed to open; "ended" after a 410. */
    var lastError: String? = null
        private set

    /** The publish's own numbers: throughput, packets shed, bytes queued, and the bitrate controller. */
    var congestion: ProgramStreamer.Metrics = ProgramStreamer.Metrics()
        private set

    /** Whether the host wants the stream on the air. */
    var wanted: Boolean = false
        private set

    /** What the next redial waits. */
    val nextRetrySeconds: Double get() = schedule.next

    /** From a stuck session until a dial goes live: dials then go every [StreamStallWatch.retrySeconds]. */
    var replacingStall: Boolean = false
        private set

    private val schedule = StreamRetrySchedule()
    private var stallWatch: StreamStallWatch? = null
    private var stallTimer: StreamRetryTimer? = null
    private var dialTimer: StreamRetryTimer? = null
    private var dialStartedAt = 0.0
    private val scheduler: StreamRetryScheduling = scheduler ?: StreamRetryScheduling { seconds, action ->
        val job: Job = scope.launch {
            delay((seconds * 1000).toLong())
            action()
        }
        StreamRetryTimer { job.cancel() }
    }
    private var retryTimer: StreamRetryTimer? = null

    /** Counts dials, so a drop reported for a session already replaced is not acted on twice. */
    private var attempt = 0
    private var liveSince: Double? = null

    /**
     * Puts the stream on the air, and keeps it there until [stop]. [reason] is the first dial's: a
     * host putting back a stream that was live when the app stopped starts with [DialReason.REDIAL].
     */
    fun start(reason: DialReason = DialReason.START) {
        wanted = true
        schedule.started()
        lastError = null
        replacingStall = false
        cancelRetry()
        pathMonitor?.start { scope.launch { networkRestored() } }
        dial(reason)
    }

    /** Takes the stream off the air. A drop reported after this is ignored. */
    fun stop() {
        wanted = false
        attempt += 1
        replacingStall = false
        cancelRetry()
        pathMonitor?.cancel()
        liveSince = null
        phase = Phase.IDLE
        publisher.stop()
        congestion = ProgramStreamer.Metrics()
    }

    /** Reads the publish's numbers into [congestion], and returns them. */
    fun refreshCongestion(): ProgramStreamer.Metrics {
        congestion = publisher.metrics
        return congestion
    }

    /** The network came back. A redial that is waiting goes now. */
    fun networkRestored() {
        if (!wanted || phase != Phase.RETRYING) return
        cancelRetry()
        redial()
    }

    private fun dial(reason: DialReason) {
        attempt += 1
        val mine = attempt
        phase = Phase.CONNECTING
        retryInSeconds = null
        dialStartedAt = now()
        host.willDial(reason)
        if (replacingStall) {
            // A replacement that has not gone live by the next one's turn is given up for it.
            dialTimer = scheduler.schedule(StreamStallWatch.retrySeconds) {
                if (mine == attempt && phase == Phase.CONNECTING) handleDrop(stalledDialError, mine)
            }
        }
        scope.launch {
            val url = try {
                host.requestURL(reason)
            } catch (ended: StreamEndedError) {
                if (mine == attempt) end(ended.message)
                return@launch
            } catch (error: Throwable) {
                if (mine == attempt) handleDrop(host.explainURLFailure(error), mine)
                return@launch
            }
            if (mine != attempt || !wanted) return@launch
            try {
                publisher.start(url, host.settings()) { message -> scope.launch { handleDrop(message, mine) } }
            } catch (error: Throwable) {
                val message = host.explainDialFailure(error)
                handleDrop(message, mine)
                return@launch
            }
            if (mine != attempt) return@launch
            phase = Phase.LIVE
            liveSince = now()
            lastError = null
            wentLive(mine)
        }
    }

    /** A dial went live: a stall being replaced is over, and this session's progress is watched. */
    private fun wentLive(mine: Int) {
        replacingStall = false
        dialTimer?.cancel()
        dialTimer = null
        val seconds = stallRedialSeconds ?: return
        stallWatch = StreamStallWatch(seconds).also { it.live(now()) }
        scheduleStallCheck(mine)
    }

    private fun scheduleStallCheck(mine: Int) {
        stallTimer = scheduler.schedule(StreamStallWatch.checkSeconds) { checkStall(mine) }
    }

    private fun checkStall(mine: Int) {
        stallTimer = null
        val watch = stallWatch
        if (mine != attempt || phase != Phase.LIVE || !wanted || watch == null) return
        val metrics = publisher.metrics
        if (watch.check(now(), metrics.bytesSent, metrics.queuedBytes)) {
            replaceStuckSession()
        } else {
            scheduleStallCheck(mine)
        }
    }

    /** The live session stopped moving: it is closed, and a fresh one dialled at once. */
    private fun replaceStuckSession() {
        // A drop the stuck session reports later belongs to a session already replaced.
        attempt += 1
        stallWatch = null
        lastError = stalledError
        host.dropped(stalledError)
        publisher.stop()
        congestion = ProgramStreamer.Metrics()
        liveSince = null
        replacingStall = true
        phase = Phase.RETRYING
        retryInSeconds = 0.0
        redial()
    }

    private fun handleDrop(message: String, dropped: Int) {
        if (dropped != attempt || (phase != Phase.CONNECTING && phase != Phase.LIVE)) return
        cancelRetry()
        lastError = message
        host.dropped(message)
        publisher.stop()
        congestion = ProgramStreamer.Metrics()
        val liveFor = liveSince?.let { now() - it }
        liveSince = null
        if (!wanted || !host.isRetryable(message)) {
            val wasWanted = wanted
            wanted = false
            replacingStall = false
            phase = Phase.IDLE
            pathMonitor?.cancel()
            if (wasWanted) host.gaveUp(message)
            return
        }
        // Replacing a stuck session, dials go every [StreamStallWatch.retrySeconds]; otherwise a
        // session that held for long enough was a good one, and its wait starts over.
        val wait = if (replacingStall) {
            StreamStallWatch.waitAfterFailedDial(now() - dialStartedAt)
        } else {
            schedule.dropped(liveFor)
        }
        phase = Phase.RETRYING
        retryInSeconds = wait
        retryTimer = scheduler.schedule(wait) {
            retryTimer = null
            redial()
        }
    }

    private fun redial() {
        if (!wanted) return
        host.redialing()
        dial(DialReason.REDIAL)
    }

    private fun end(message: String) {
        wanted = false
        replacingStall = false
        cancelRetry()
        pathMonitor?.cancel()
        publisher.stop()
        congestion = ProgramStreamer.Metrics()
        liveSince = null
        phase = Phase.IDLE
        lastError = endedError
        host.ended(message)
    }

    private fun cancelRetry() {
        retryTimer?.cancel()
        retryTimer = null
        retryInSeconds = null
        dialTimer?.cancel()
        dialTimer = null
        stallTimer?.cancel()
        stallTimer = null
        stallWatch = null
    }

    companion object {
        const val firstRetrySeconds = StreamRetrySchedule.firstRetrySeconds
        const val longestRetrySeconds = StreamRetrySchedule.longestRetrySeconds

        /** How long a session has to stay live for the next drop to wait only [firstRetrySeconds] again. */
        const val liveResetSeconds = StreamRetrySchedule.liveResetSeconds

        /** [lastError] after the server ended the stream. */
        const val endedError = "ended"

        /** [lastError] after a session stopped moving and was replaced. */
        const val stalledError = "the stream server stopped taking the stream"

        /** Why a replacement dial was given up for the next. */
        const val stalledDialError = "the stream server did not answer in time"
    }
}
