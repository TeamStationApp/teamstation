package app.teamstation.cameraman.scoreboard

import app.teamstation.cameraman.BuildConfig
import app.teamstation.streamcore.core.SettingsStore
import app.teamstation.cameraman.eventcontrol.EventAssignment
import app.teamstation.cameraman.eventcontrol.EventControlAccount
import app.teamstation.cameraman.eventcontrol.EventControlAckStatus
import app.teamstation.cameraman.eventcontrol.EventControlHost
import app.teamstation.cameraman.eventcontrol.EventControlUiState
import app.teamstation.cameraman.radar.ScoreboardRoute
import app.teamstation.cameraman.radar.ScoreboardSaved
import app.teamstation.cameraman.radar.ScoreboardTarget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.ZoneId
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.coroutines.CoroutineContext

/** What Settings draws. The token stays in [ScoreboardSaved] and is not on this object. */
internal data class ScoreboardUiState(
    val route: ScoreboardRoute = ScoreboardRoute.V1,
    val signedIn: Boolean = false,
    val accountLabel: String = "",
    val apiServer: String = ScoreboardTarget.DEFAULT_V1_SERVER,
    val v1EventId: String = "",
    val accountServer: String = ScoreboardTarget.DEFAULT_ACCOUNT_SERVER,
    val accountHost: String = ScoreboardTarget.PRODUCTION_ACCOUNT_HOST,
    val gameTitle: String = "",
    val gameWhen: String = "",
    val status: String = "",
    val awaitingCode: Boolean = false,
    val pickerOpen: Boolean = false,
    val recent: List<ScoreboardEventRow> = emptyList(),
    val upcoming: List<ScoreboardEventRow> = emptyList(),
    val pickerStatus: String = "",
    /** "Allow Director Override". */
    val allowOverride: Boolean = false,
    /** Whether the toggle can be changed: only a signed-in device can be controlled. */
    val overrideToggleEnabled: Boolean = false,
    /** The controlling Director's observed address while it holds the lease; empty otherwise. */
    val overrideHost: String = "",
    /** A Director holds the event: the row is grayed and the picker and every other edit are off. */
    val eventLocked: Boolean = false,
    /** A problem with event control worth a line, such as both ports being taken. */
    val overrideStatus: String = "",
    /**
     * What the last sign-in link did, for [ScoreboardDesk.LINK_MESSAGE_MS] after it did it; empty
     * otherwise. The status line says it too, but only Settings shows that.
     */
    val linkMessage: String = ""
)

/**
 * Sign-in, the event list, and the socket a radar reading is published on.
 *
 * The event route is stored only while a token is present. Sign-out writes the V1 route back,
 * so a later launch does not look selected on a control that is grayed out.
 *
 * With [eventControl], a nearby Director on the same account may set the event through
 * [applyAssignedEvent] while the operator allows it. Moving to another event closes the old
 * socket, cancels its reconnect and its pending pitch clear, and drops anything queued for it, so
 * nothing meant for one event reaches the next; readings after the move go to the new one.
 */
internal class ScoreboardDesk(
    private val store: SettingsStore,
    private val scope: CoroutineScope,
    private val account: ScoreboardAccount = OkHttpScoreboardAccount(),
    liveSocket: ScoreboardPublisher? = null,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val origin: String = "android",
    /** This app's own link host, where its sign-in links are mailed; empty in a build without one. */
    private val appOrigin: String = BuildConfig.TS_APP_ORIGIN,
    private val deviceName: String = "TS Cameraman",
    private val accountOrigin: String = ScoreboardTarget.accountOrigin(BuildConfig.TS_PRIMARY_HOST),
    private val eventControl: EventControlHost? = null,
    private val io: CoroutineContext = Dispatchers.IO
) {
    @Volatile
    private var saved: ScoreboardSaved = run {
        val loaded = ScoreboardTarget.load(store)
        if (loaded.accountServer == accountOrigin) {
            loaded
        } else {
            val next = loaded.copy(accountServer = accountOrigin)
            ScoreboardTarget.save(store, next)
            next
        }
    }
    private var awaitingCode = false
    private var pickerOpen = false
    private var recent: List<ScoreboardEventRow> = emptyList()
    private var upcoming: List<ScoreboardEventRow> = emptyList()
    private var pickerStatus = ""
    private var status = ""
    private var linkMessage = ""
    private var linkMessageJob: Job? = null
    private var reconnectJob: Job? = null
    private var pitchGeneration = 0
    private var pitchHold: Job? = null

    /** Bumped whenever readings change destination; a delayed send for an older one is dropped. */
    @Volatile
    private var targetGeneration = 0

    /** Keeps a reading's choice of socket and its send together, apart from a move to another event. */
    private val targetLock = ReentrantLock()
    private var control: EventControlUiState = eventControl?.state?.value ?: EventControlUiState()
    private var identityJob: Job? = null
    private val mutable = MutableStateFlow(ui())
    val state: StateFlow<ScoreboardUiState> = mutable.asStateFlow()
    private val socket: ScoreboardPublisher = liveSocket ?: ScoreboardSocket(onStatus = { next ->
        scope.launch {
            status = next
            publish()
        }
    })

    init {
        eventControl?.let { host ->
            host.committer = app.teamstation.cameraman.eventcontrol.EventControlCommitter { assignment, check ->
                applyAssignedEvent(assignment, check)
            }
            host.onUnauthorized = { forgetIdentity() }
            scope.launch {
                host.state.collect { next ->
                    control = next
                    if (next.override != null) pickerOpen = false
                    publish()
                }
            }
        }
    }

    /** The service is up: confirm who the token belongs to, and let event control listen. */
    fun start() {
        syncEventControl()
        refreshIdentity()
        eventControl?.start()
    }

    /** The service is going: event control stops listening, and any lease ends. */
    fun stop() {
        identityJob?.cancel()
        eventControl?.stop()
    }

    /** From the service's start and a network change. */
    fun ensureListening() {
        eventControl?.ensureListening()
    }

    /** "Allow Director Override". Off ends a Director's hold at once and gives the picker back. */
    fun setAllowOverride(allowed: Boolean) {
        eventControl?.setConsent(allowed)
    }

    /**
     * The receiver's lease decides, not only the mirror of it in [control], which arrives a step
     * later: a pick made just after a Director's assignment was written must not overwrite it.
     */
    private val locked: Boolean get() = control.override != null || eventControl?.receiver?.holdsEvent == true

    fun selectRoute(route: ScoreboardRoute) {
        if (route == ScoreboardRoute.Event && saved.token.isEmpty()) return
        saved = saved.copy(route = route)
        persist()
        status = idleStatus()
        publish()
        reconnect()
    }

    fun setV1(apiServer: String, eventId: String) {
        if (saved.apiServer == apiServer && saved.v1EventId == eventId) return
        saved = saved.copy(apiServer = apiServer, v1EventId = eventId)
        persist()
        publish()
        scheduleReconnect()
    }

    /** The account server is the build's. A typed value is not kept. */
    @Suppress("UNUSED_PARAMETER")
    fun setAccountServer(server: String) {
        if (saved.accountServer == accountOrigin) return
        saved = saved.copy(accountServer = accountOrigin)
        persist()
        publish()
    }

    fun sendCode(email: String) {
        val trimmed = email.trim()
        if (trimmed.isEmpty()) {
            status = "Enter an email"
            publish()
            return
        }
        scope.launch {
            status = "Sending a code"
            publish()
            try {
                withContext(io) {
                    account.startSignIn(saved.accountServer, trimmed, origin, appOrigin.ifEmpty { null })
                }
                awaitingCode = true
                status = "Check your email for a code"
            } catch (error: Exception) {
                status = error.message ?: "Could not send the code"
            }
            publish()
        }
    }

    fun verify(email: String, code: String) {
        val trimmedEmail = email.trim()
        val trimmedCode = code.trim()
        if (trimmedEmail.isEmpty() || trimmedCode.isEmpty()) {
            status = "Enter the email and the code"
            publish()
            return
        }
        scope.launch {
            status = "Signing in"
            publish()
            try {
                val signedIn = withContext(io) {
                    account.completeSignIn(
                        saved.accountServer,
                        trimmedEmail,
                        trimmedCode,
                        deviceName
                    )
                }
                saved = saved.copy(
                    token = signedIn.token,
                    displayName = signedIn.displayName,
                    email = signedIn.email,
                    userId = signedIn.userId
                )
                awaitingCode = false
                status = "Signed in"
                persist()
                syncEventControl()
                if (saved.userId.isEmpty()) refreshIdentity()
            } catch (error: Exception) {
                status = error.message ?: "Could not sign in"
            }
            publish()
        }
    }

    /**
     * Signs in with a link Android handed the app: a `/signin/<token>` address on this app's own
     * link host. The token goes only to the account server, when the link names it or none, or names
     * another name the server reports as its own OpenID issuer; a link another server issued is
     * never sent anywhere. The outcome is left in the status line. False for any other address.
     */
    fun signIn(link: String): Boolean {
        val own = ScoreboardTarget.httpOrigin(saved.accountServer).trimEnd('/')
        val read = SignInLink.read(link, appOrigin, own)
        if (read is SignInLink.NotSignIn) return false
        scope.launch {
            status = "Signing in"
            publish()
            try {
                val token = when (read) {
                    is SignInLink.Spend -> read.token
                    is SignInLink.Confirm -> {
                        // Null: the server answered without an issuer, so it vouches for no other
                        // name. An IOException: it could not be asked, which says nothing either way.
                        val issuer = try {
                            withContext(io) { account.issuer(saved.accountServer) }
                        } catch (error: IOException) {
                            status = SignInLink.unreachable(own)
                            showLinkMessage(status)
                            publish()
                            return@launch
                        }
                        if (issuer != "${read.server}/oauth") {
                            status = SignInLink.wrongServer(read.server, own)
                            showLinkMessage(status)
                            publish()
                            return@launch
                        }
                        read.token
                    }
                    SignInLink.NotSignIn -> return@launch
                }
                val signedIn = withContext(io) { account.signInWithLink(saved.accountServer, token, deviceName) }
                saved = saved.copy(
                    token = signedIn.token,
                    displayName = signedIn.displayName,
                    email = signedIn.email,
                    userId = signedIn.userId
                )
                awaitingCode = false
                status = "Signed in to TeamStation as ${signedIn.displayName}"
                persist()
                syncEventControl()
                if (saved.userId.isEmpty()) refreshIdentity()
            } catch (error: Exception) {
                status = error.message ?: "Could not sign in"
            }
            showLinkMessage(status)
            publish()
        }
        return true
    }

    /** Puts a link's outcome over whatever screen is up, and takes it down again. */
    private fun showLinkMessage(message: String) {
        linkMessage = message
        linkMessageJob?.cancel()
        linkMessageJob = scope.launch {
            delay(LINK_MESSAGE_MS)
            linkMessage = ""
            publish()
        }
    }

    fun signOut() {
        identityJob?.cancel()
        saved = ScoreboardTarget.signedOut(saved)
        awaitingCode = false
        pickerOpen = false
        status = "Signed out"
        persist()
        // The key goes with the account, and a Director's hold with it.
        syncEventControl()
        publish()
        reconnect()
    }

    fun openEvents() {
        if (saved.token.isEmpty() || locked) return
        scope.launch {
            pickerOpen = true
            pickerStatus = "Loading events"
            publish()
            try {
                val lists = withContext(io) {
                    account.events(saved.accountServer, saved.token, zone)
                }
                recent = lists.recent
                upcoming = lists.upcoming
                pickerStatus = ""
            } catch (error: Exception) {
                pickerStatus = error.message ?: "Could not load events"
            }
            publish()
        }
    }

    fun dismissEvents() {
        pickerOpen = false
        publish()
    }

    fun choose(row: ScoreboardEventRow) {
        if (locked) {
            pickerOpen = false
            publish()
            return
        }
        saved = saved.copy(
            route = ScoreboardRoute.Event,
            gameId = row.gameId,
            gameTitle = row.title,
            gameStartAt = row.startAt
        )
        pickerOpen = false
        status = ""
        persist()
        publish()
        reconnect()
    }

    /**
     * A pitch or exit that just arrived. Zeros and dashes are not readings.
     *
     * A pitch above zero is sent, then cleared with `{"pitchSpeed":0}` five
     * seconds later unless another pitch arrives. Exit velocity does not
     * restart that wait, and the clear does not mention exit velocity.
     */
    fun publishSpeeds(pitchMph: Int, exitMph: Int) {
        val reading = ScoreboardTarget.reading(pitchMph, exitMph) ?: return
        targetLock.withLock {
            if (reading.restartsPitchHold) {
                pitchGeneration += 1
                val mine = pitchGeneration
                val target = targetGeneration
                pitchHold?.cancel()
                pitchHold = scope.launch {
                    delay(ScoreboardTarget.PITCH_HOLD_MS)
                    targetLock.withLock {
                        // A clear for the event readings have since left is not sent to the next one.
                        if (mine == pitchGeneration && target == targetGeneration) {
                            socket.send(ScoreboardTarget.target(saved), ScoreboardTarget.PITCH_CLEAR_PAYLOAD)
                        }
                    }
                }
            }
            socket.send(ScoreboardTarget.target(saved), reading.text)
        }
    }

    /**
     * A Director's assignment: the game's ID, title and start time, written together and nothing
     * else. The route, the account, the servers, the V1 event and the radar's Send radar speeds
     * stay as they are. [check] is called immediately before writing and refuses with its status
     * when consent, the account or the lease moved meanwhile. The socket moves only when readings
     * were going to the event route; a device on V1 keeps the event for when it switches.
     */
    internal fun applyAssignedEvent(
        gameId: String,
        title: String,
        startAt: String,
        check: () -> EventControlAckStatus? = { null }
    ): EventControlAckStatus {
        if (saved.token.isEmpty() || saved.userId.isEmpty()) return EventControlAckStatus.WrongAccount
        check()?.let { return it }
        val before = saved
        val next = before.copy(gameId = gameId, gameTitle = title, gameStartAt = startAt)
        try {
            ScoreboardTarget.save(store, next)
        } catch (error: Exception) {
            return EventControlAckStatus.Failed
        }
        targetLock.withLock {
            saved = next
            if (ScoreboardTarget.target(next) != ScoreboardTarget.target(before)) moveTarget()
        }
        pickerOpen = false
        if (status == "Choose an event") status = ""
        publish()
        return EventControlAckStatus.Applied
    }

    private fun applyAssignedEvent(
        assignment: EventAssignment,
        check: () -> EventControlAckStatus?
    ): EventControlAckStatus = applyAssignedEvent(assignment.gameId, assignment.title, assignment.startAt, check)

    /** Who the token belongs to. A refusal clears it; no answer keeps what was validated before. */
    private fun refreshIdentity() {
        val token = saved.token
        if (token.isEmpty()) return
        identityJob?.cancel()
        identityJob = scope.launch {
            val userId = try {
                withContext(io) { account.me(saved.accountServer, token) }
            } catch (error: ScoreboardWireException) {
                if (error.status == 401 && saved.token == token) forgetIdentity()
                return@launch
            } catch (error: Exception) {
                return@launch
            }
            if (saved.token != token || saved.userId == userId) return@launch
            saved = saved.copy(userId = userId)
            persist()
            syncEventControl()
            publish()
        }
    }

    /** The server refused this session: it is no longer a validated identity for event control. */
    private fun forgetIdentity() {
        if (saved.userId.isEmpty()) return
        saved = saved.copy(userId = "")
        persist()
        syncEventControl()
        publish()
    }

    private fun syncEventControl() {
        val host = eventControl ?: return
        host.setAccount(
            if (saved.token.isEmpty() || saved.userId.isEmpty()) {
                null
            } else {
                EventControlAccount(saved.accountServer, saved.userId, saved.token)
            }
        )
    }

    /**
     * Readings leave the old destination: its socket, its reconnect, its queued reading and its
     * pending pitch clear all go. Called with [targetLock] held.
     */
    private fun moveTarget() {
        targetGeneration += 1
        pitchHold?.cancel()
        pitchHold = null
        reconnectJob?.cancel()
        reconnectJob = null
        socket.close()
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(400)
            reconnect()
        }
    }

    /** Drops the current socket. The next reading opens the one the radios now point at. */
    private fun reconnect() {
        targetLock.withLock { moveTarget() }
    }

    private fun persist() {
        ScoreboardTarget.save(store, saved)
    }

    private fun idleStatus(): String = when {
        saved.route == ScoreboardRoute.Event && saved.gameId.isEmpty() -> "Choose an event"
        saved.route == ScoreboardRoute.V1 && saved.v1EventId.isBlank() -> "Enter a V1 event id"
        else -> ""
    }

    private fun publish() {
        mutable.value = ui()
    }

    private fun ui(): ScoreboardUiState {
        val label = when {
            saved.token.isEmpty() -> ""
            saved.email.isNotEmpty() -> saved.email
            else -> saved.displayName
        }
        val held = control.override
        val gameStartAt = held?.assignment?.startAt ?: saved.gameStartAt
        return ScoreboardUiState(
            route = saved.route,
            signedIn = saved.token.isNotEmpty(),
            accountLabel = label,
            apiServer = saved.apiServer,
            v1EventId = saved.v1EventId,
            accountServer = saved.accountServer,
            accountHost = ScoreboardTarget.accountHost(saved.accountServer),
            gameTitle = held?.assignment?.title ?: saved.gameTitle,
            gameWhen = if (gameStartAt.isEmpty()) {
                ""
            } else {
                ScoreboardTarget.localStartTime(gameStartAt, zone)
            },
            status = status,
            awaitingCode = awaitingCode,
            pickerOpen = pickerOpen,
            recent = recent,
            upcoming = upcoming,
            pickerStatus = pickerStatus,
            allowOverride = control.consent,
            overrideToggleEnabled = eventControl != null && saved.token.isNotEmpty(),
            overrideHost = held?.ownerHost.orEmpty(),
            eventLocked = held != null,
            overrideStatus = control.status,
            linkMessage = linkMessage
        )
    }

    internal companion object {
        /** How long a sign-in link's outcome stays over the screen. */
        const val LINK_MESSAGE_MS = 6_000L
    }
}
