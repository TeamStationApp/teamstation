package app.teamstation.cameraman.scoreboard

import app.teamstation.cameraman.BuildConfig
import app.teamstation.cameraman.core.SettingsStore
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
import java.time.ZoneId

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
    val pickerStatus: String = ""
)

/**
 * Sign-in, the event list, and the socket a radar reading is published on.
 *
 * The event route is stored only while a token is present. Sign-out writes the V1 route back,
 * so a later launch does not look selected on a control that is grayed out.
 */
internal class ScoreboardDesk(
    private val store: SettingsStore,
    private val scope: CoroutineScope,
    private val account: ScoreboardAccount = OkHttpScoreboardAccount(),
    liveSocket: ScoreboardSocket? = null,
    private val zone: ZoneId = ZoneId.systemDefault(),
    private val origin: String = "android",
    private val deviceName: String = "TS Cameraman",
    private val accountOrigin: String = ScoreboardTarget.accountOrigin(BuildConfig.TS_PRIMARY_HOST)
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
    private var reconnectJob: Job? = null
    private var pitchGeneration = 0
    private var pitchHold: Job? = null
    private val mutable = MutableStateFlow(ui())
    val state: StateFlow<ScoreboardUiState> = mutable.asStateFlow()
    private val socket: ScoreboardSocket = liveSocket ?: ScoreboardSocket(onStatus = { next ->
        scope.launch {
            status = next
            publish()
        }
    })

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
                withContext(Dispatchers.IO) {
                    account.startSignIn(saved.accountServer, trimmed, origin)
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
                val signedIn = withContext(Dispatchers.IO) {
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
                    email = signedIn.email
                )
                awaitingCode = false
                status = "Signed in"
                persist()
            } catch (error: Exception) {
                status = error.message ?: "Could not sign in"
            }
            publish()
        }
    }

    fun signOut() {
        saved = ScoreboardTarget.signedOut(saved)
        awaitingCode = false
        pickerOpen = false
        status = "Signed out"
        persist()
        publish()
        reconnect()
    }

    fun openEvents() {
        if (saved.token.isEmpty()) return
        scope.launch {
            pickerOpen = true
            pickerStatus = "Loading events"
            publish()
            try {
                val lists = withContext(Dispatchers.IO) {
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
        if (reading.restartsPitchHold) {
            pitchGeneration += 1
            val mine = pitchGeneration
            pitchHold?.cancel()
            pitchHold = scope.launch {
                delay(ScoreboardTarget.PITCH_HOLD_MS)
                if (mine == pitchGeneration) {
                    socket.send(ScoreboardTarget.target(saved), ScoreboardTarget.PITCH_CLEAR_PAYLOAD)
                }
            }
        }
        socket.send(ScoreboardTarget.target(saved), reading.text)
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
        socket.close()
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
        return ScoreboardUiState(
            route = saved.route,
            signedIn = saved.token.isNotEmpty(),
            accountLabel = label,
            apiServer = saved.apiServer,
            v1EventId = saved.v1EventId,
            accountServer = saved.accountServer,
            accountHost = ScoreboardTarget.accountHost(saved.accountServer),
            gameTitle = saved.gameTitle,
            gameWhen = if (saved.gameStartAt.isEmpty()) {
                ""
            } else {
                ScoreboardTarget.localStartTime(saved.gameStartAt, zone)
            },
            status = status,
            awaitingCode = awaitingCode,
            pickerOpen = pickerOpen,
            recent = recent,
            upcoming = upcoming,
            pickerStatus = pickerStatus
        )
    }
}
