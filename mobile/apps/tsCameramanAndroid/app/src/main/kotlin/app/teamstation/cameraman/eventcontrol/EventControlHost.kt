package app.teamstation.cameraman.eventcontrol

import android.os.SystemClock
import app.teamstation.streamcore.core.SettingsStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import kotlin.coroutines.CoroutineContext

/** The signed-in account a key is fetched for: its server, its user ID in decimal, its own token. */
internal data class EventControlAccount(val server: String, val userId: String, val token: String) {
    override fun toString(): String = "EventControlAccount(server=$server, userId=$userId, token=<redacted>)"
}

/**
 * Why fetching the key failed: only [Unauthorized] says the session itself was refused.
 * [Unavailable] (404 or 503) says the server does not offer event control.
 */
internal enum class EventControlFetchFailure { Unauthorized, Unavailable, Offline }

internal class EventControlFetchException(val failure: EventControlFetchFailure, message: String) : Exception(message)

/** `GET /api/v1/device-event-control/key` with the device's own token. Blocking; called off the main thread. */
internal fun interface EventControlKeyFetcher {
    fun fetch(server: String, token: String): EventControlCredentials
}

/**
 * The app's commit, run in the app's own context: [check] is called immediately before anything
 * is written and refuses with its status when consent, the account or the lease moved meanwhile.
 */
internal fun interface EventControlCommitter {
    fun commit(assignment: EventAssignment, check: () -> EventControlAckStatus?): EventControlAckStatus
}

/** What Settings draws for event control. */
internal data class EventControlUiState(
    /** "Allow Director Override". */
    val consent: Boolean = false,
    /** Signed in with a validated identity and this account's key. */
    val eligible: Boolean = false,
    /** The lease, while a Director holds it. */
    val override: EventOverride? = null,
    val listener: EventControlListenerState = EventControlListenerState.Stopped,
    /** One line for problems: both ports taken, no key yet, a key the Keystore could not keep. Empty when all is well. */
    val status: String = ""
)

/**
 * Device event control as the app runs it: the receiver, its listener, this account's key, and the
 * operator's consent, tied to the foreground service's lifetime.
 *
 * The listener runs while the service is up, the device is signed in, it holds a valid key for that
 * account and "Allow Director Override" is on. Consent off releases the lease at once and restores
 * local editing, then stops the listener. Sign-out or another account discards the key and ends any
 * lease. A restart restores consent, never a lease.
 *
 * Every public method is called on the main thread; the listener's connections run on [io], and an
 * assignment's commit hops back to [main].
 */
internal class EventControlHost(
    private val settings: SettingsStore,
    private val keys: EventControlKeyStore,
    private val fetcher: EventControlKeyFetcher,
    private val scope: CoroutineScope,
    /** Where the listener's blocking accept loop and connections run. */
    private val io: CoroutineScope,
    /** The app's own thread, where the commit runs. */
    private val main: CoroutineContext,
    private val ioContext: CoroutineContext = Dispatchers.IO,
    private val retryMs: Long = 60_000L,
    private val ports: List<Int> = EventControlProtocol.PORTS,
    private val leaseScope: CoroutineScope? = scope,
    /** Milliseconds on a clock that setting the time of day does not move. */
    private val now: () -> Long = SystemClock::elapsedRealtime
) {
    private val mutable = MutableStateFlow(EventControlUiState(consent = settings.string(KEY_CONSENT) == "1"))
    val state: StateFlow<EventControlUiState> = mutable.asStateFlow()

    /** Set by the scoreboard before [start]; answers `failed` until then. */
    var committer: EventControlCommitter? = null

    /** Called when the server refused the session, so the app stops counting it as validated. */
    var onUnauthorized: (() -> Unit)? = null

    val instanceId: EventControlInstanceId = EventControlInstanceId.of(settings.string(KEY_INSTANCE).orEmpty())
        ?: EventControlInstanceId.random().also { settings.setString(it.hex, KEY_INSTANCE) }

    private var account: EventControlAccount? = null
    @Volatile
    private var accountGeneration = 0L
    private var running = false
    private var fetchJob: Job? = null

    /**
     * The server does not offer event control (404 or 503), or answered the key request with
     * something unusable. As on iOS, it is not asked again until the account changes.
     */
    private var keyUnavailable = false

    /** This account's key is held in memory only: the Keystore could not seal it. */
    private var keyNotStored = false

    /** The last fetch for this account ended in an error of the app's own, not the server's. */
    private var fetchFaulted = false
    private var lastMismatchFetch = Long.MIN_VALUE / 2

    val receiver = EventControlReceiver(
        instanceId = instanceId,
        credentials = null,
        consent = mutable.value.consent,
        apply = { assignment, context -> commit(assignment, context) },
        now = now,
        timers = leaseScope,
        onEvent = { event -> scope.launch { handle(event) } }
    )

    private val listener = EventControlListener(
        receiver = receiver,
        scope = io,
        ports = ports,
        onStateChange = { next -> scope.launch { update { it.copy(listener = next) } } }
    )

    /** The service started: listen if everything else allows it. */
    fun start() {
        running = true
        if (account != null && !receiver.hasCredentials) fetchKey()
        reconcile()
        listener.ensureListening()
    }

    /** The service is going: no listener, no lease. */
    fun stop() {
        running = false
        reconcile()
    }

    /** From the service's start and a network change: bind again if the socket went. */
    fun ensureListening() {
        if (shouldListen()) listener.ensureListening()
    }

    fun setConsent(allowed: Boolean) {
        if (allowed == mutable.value.consent) return
        settings.setString(if (allowed) "1" else "0", KEY_CONSENT)
        // Off: the lease goes first, so editing is back before the socket is.
        receiver.setConsent(allowed)
        update { it.copy(consent = allowed, override = receiver.overrideState) }
        reconcile()
    }

    /**
     * The signed-in account whose identity is established, or null while signed out or while it
     * cannot be. Another account discards the old one's key and ends any lease.
     */
    fun setAccount(next: EventControlAccount?) {
        val previous = account
        if (previous == next) return
        val sameAccount = previous != null && next != null &&
            previous.server == next.server && previous.userId == next.userId
        account = next
        if (sameAccount) return
        accountGeneration += 1
        keyUnavailable = false
        keyNotStored = false
        fetchFaulted = false
        fetchJob?.cancel()
        fetchJob = null
        if (previous != null) keys.remove(previous.server)
        receiver.setCredentials(null)
        if (next != null) {
            val cached = keys.credentials(next.server)
            if (cached != null && cached.userId == next.userId) {
                receiver.setCredentials(cached)
            } else {
                if (cached != null) keys.remove(next.server)
                if (running) fetchKey()
            }
        }
        update { it.copy(override = receiver.overrideState) }
        reconcile()
    }

    /**
     * Fetches this account's key with its own token. [force] asks again even with a key in hand,
     * after a peer showed a key ID from another server secret.
     */
    private fun fetchKey(force: Boolean = false) {
        val current = account ?: return
        if (keyUnavailable) return
        if (fetchJob?.isActive == true && !force) return
        fetchJob?.cancel()
        val generation = accountGeneration
        fetchJob = scope.launch {
            try {
                fetchKeyOnce(current, generation)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // The scope has no handler: anything let through here would reach the main
                // thread's uncaught handler and end the app.
                if (generation == accountGeneration) {
                    fetchFaulted = true
                    runCatching { update { it } }
                }
            }
        }
    }

    private suspend fun fetchKeyOnce(current: EventControlAccount, generation: Long) {
        val result = runCatching {
            withContext(ioContext) { fetcher.fetch(current.server, current.token) }
        }
        // A fetch replaced or stopped meanwhile says nothing about the server.
        currentCoroutineContext().ensureActive()
        if (generation != accountGeneration) return
        fetchFaulted = false
        val credentials = result.getOrNull()
        if (credentials != null && credentials.userId == current.userId) {
            // A Keystore that cannot seal it leaves the key in memory for this run; the next
            // launch fetches it again.
            keyNotStored = !keys.save(credentials, current.server)
            // The same key again changes nothing; one from another secret ends the lease.
            receiver.setCredentials(credentials)
            update { it.copy(override = receiver.overrideState) }
            reconcile()
            return
        }
        val error = result.exceptionOrNull()
        val failure = (error as? EventControlFetchException)?.failure
            ?: if (error is IOException) EventControlFetchFailure.Offline else null
        if (failure == EventControlFetchFailure.Unauthorized || credentials != null) {
            // Refused, or a key for someone else: this session is not a validated identity.
            keys.remove(current.server)
            receiver.setCredentials(null)
            account = null
            accountGeneration += 1
            update { it.copy(override = null) }
            reconcile()
            onUnauthorized?.invoke()
            return
        }
        if (failure != EventControlFetchFailure.Offline) {
            // Not offered (404 or 503), or a reply that is no key: final until the account
            // changes, as on iOS. Whatever key was kept for this server goes with it.
            keyUnavailable = true
            keys.remove(current.server)
            receiver.setCredentials(null)
            update { it.copy(override = null) }
            reconcile()
            return
        }
        // Offline: a cached key, if any, stays; try again later.
        update { it }
        delay(retryMs)
        if (generation == accountGeneration && running && !receiver.hasCredentials) {
            fetchJob = null
            fetchKey()
        }
    }

    private suspend fun commit(assignment: EventAssignment, context: EventControlApplyContext): EventControlAckStatus {
        // Taken as the assignment arrives: an account change queued ahead of the commit refuses it.
        val generation = accountGeneration
        return withContext(main) {
            val committer = committer ?: return@withContext EventControlAckStatus.Failed
            committer.commit(assignment) {
                val held = receiver.overrideState
                when {
                    !mutable.value.consent || !receiver.isConsenting -> EventControlAckStatus.Disabled
                    generation != accountGeneration || account == null -> EventControlAckStatus.WrongAccount
                    held != null && held.owner != context.owner -> EventControlAckStatus.Busy
                    held != null && java.lang.Long.compareUnsigned(context.revision, held.revision) < 0 ->
                        EventControlAckStatus.Stale
                    else -> null
                }
            }
        }
    }

    private fun handle(event: EventControlReceiverEvent) {
        when (event) {
            is EventControlReceiverEvent.OverrideChanged -> update { it.copy(override = event.current) }
            is EventControlReceiverEvent.OverrideEnded -> update { it.copy(override = receiver.overrideState) }
            is EventControlReceiverEvent.KeyMismatch -> {
                // Another server secret: this device's key may be the stale one. Ask again, at most
                // once a minute, whatever a peer keeps sending.
                val at = now()
                if (account == null || at - lastMismatchFetch < retryMs) return
                lastMismatchFetch = at
                fetchKey(force = true)
            }
        }
    }

    private fun shouldListen(): Boolean = running && mutable.value.consent && receiver.hasCredentials

    private fun reconcile() {
        if (shouldListen()) listener.start() else listener.stop()
        val eligible = account != null && receiver.hasCredentials
        update { it.copy(eligible = eligible, listener = listener.state) }
    }

    private fun status(state: EventControlUiState): String {
        val listening = state.listener
        return when {
            !state.consent || account == null -> ""
            fetchFaulted -> "Could not get this account's Director key"
            !state.eligible && keyUnavailable -> "Not offered by this account server"
            !state.eligible -> "Waiting for this account's Director key"
            listening is EventControlListenerState.PortsUnavailable ->
                "Ports ${listening.ports.joinToString(" and ")} are in use"
            keyNotStored -> "Could not store this device's key"
            else -> ""
        }
    }

    private fun update(change: (EventControlUiState) -> EventControlUiState) {
        mutable.value = change(mutable.value).let { it.copy(status = status(it)) }
    }

    companion object {
        const val KEY_CONSENT = "app.teamstation.cameraman.eventControl.allowOverride"
        const val KEY_INSTANCE = "app.teamstation.cameraman.eventControl.instanceId"
    }
}
