package co.gamestation.cameraman.radar

import co.gamestation.cameraman.core.SettingsStore
import java.net.URLEncoder
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId

/** Which scoreboard a radar reading is aimed at. */
internal enum class ScoreboardRoute {
    /** The 1.0 autoState socket. No account. */
    V1,

    /** One event's publish socket. Needs a signed-in account and a chosen event. */
    Event
}

/** A socket to open, and the bearer token to say at the door when the route needs one. */
internal data class ScoreboardSocketTarget(
    val url: String,
    val authorization: String?
)

/** What Settings saved. An empty token is signed out. */
internal data class ScoreboardSaved(
    val route: ScoreboardRoute,
    val apiServer: String,
    val v1EventId: String,
    val accountServer: String,
    val token: String,
    val displayName: String,
    val email: String,
    val gameId: String,
    val gameTitle: String,
    val gameStartAt: String
)

/**
 * Where a TAG One reading goes, matching GS Watcher.
 *
 * V1 is `<apiServer>/sockets/api/v1/autoState/<eventId>` with the server string used as typed.
 * An event is `<server>/api/v1/scoreboard/<gameId>/publish` over `wss://` (`ws://` for an `http://`
 * server), with the session bearer token.
 */
internal object ScoreboardTarget {
    const val DEFAULT_V1_SERVER = "wss://app.gamestation.co"
    const val DEFAULT_ACCOUNT_SERVER = "https://gamestation.co"

    private const val KEY_ROUTE = "co.gamestation.cameraman.scoreboard.route"
    private const val KEY_API_SERVER = "co.gamestation.cameraman.scoreboard.apiServer"
    private const val KEY_V1_EVENT = "co.gamestation.cameraman.scoreboard.v1EventId"
    private const val KEY_ACCOUNT_SERVER = "co.gamestation.cameraman.scoreboard.accountServer"
    private const val KEY_TOKEN = "co.gamestation.cameraman.scoreboard.token"
    private const val KEY_DISPLAY_NAME = "co.gamestation.cameraman.scoreboard.displayName"
    private const val KEY_EMAIL = "co.gamestation.cameraman.scoreboard.email"
    private const val KEY_GAME_ID = "co.gamestation.cameraman.scoreboard.gameId"
    private const val KEY_GAME_TITLE = "co.gamestation.cameraman.scoreboard.gameTitle"
    private const val KEY_GAME_START = "co.gamestation.cameraman.scoreboard.gameStartAt"

    fun trimmed(origin: String): String = origin.trim().trimEnd('/')

    /** `ws://` and `wss://` read as `http://` and `https://`. */
    fun httpOrigin(server: String): String {
        val origin = trimmed(server)
        return when {
            origin.startsWith("wss://", ignoreCase = true) -> "https://" + origin.substring(6)
            origin.startsWith("ws://", ignoreCase = true) -> "http://" + origin.substring(5)
            else -> origin
        }
    }

    /** `https://` becomes `wss://`, `http://` becomes `ws://`. */
    fun socketOrigin(server: String): String {
        val origin = trimmed(server)
        return when {
            origin.startsWith("https://", ignoreCase = true) -> "wss://" + origin.substring(8)
            origin.startsWith("http://", ignoreCase = true) -> "ws://" + origin.substring(7)
            else -> origin
        }
    }

    /**
     * The event route only sends while a token is saved. Otherwise the V1 socket is the one
     * that is live, which is also what the radio falls back to after sign-out.
     */
    fun effectiveRoute(selected: ScoreboardRoute, token: String): ScoreboardRoute =
        if (selected == ScoreboardRoute.Event && token.isNotEmpty()) ScoreboardRoute.Event
        else ScoreboardRoute.V1

    fun target(saved: ScoreboardSaved): ScoreboardSocketTarget? {
        return when (effectiveRoute(saved.route, saved.token)) {
            ScoreboardRoute.V1 -> v1Url(saved.apiServer, saved.v1EventId)?.let {
                ScoreboardSocketTarget(it, null)
            }
            ScoreboardRoute.Event -> eventTarget(saved.accountServer, saved.gameId, saved.token)
        }
    }

    fun v1Url(apiServer: String, eventId: String): String? {
        if (apiServer.isBlank() || eventId.isBlank()) return null
        return "${trimmed(apiServer)}/sockets/api/v1/autoState/${encode(eventId)}"
    }

    fun eventTarget(server: String, gameId: String, token: String): ScoreboardSocketTarget? {
        if (server.isBlank() || gameId.isBlank() || token.isBlank()) return null
        return ScoreboardSocketTarget(
            url = "${socketOrigin(server)}/api/v1/scoreboard/${encode(gameId)}/publish",
            authorization = "Bearer $token"
        )
    }

    /** Pitch and exit only, and only the numbers that just arrived. A dash is not a reading. */
    fun payload(pitchMph: Int, exitMph: Int): String? {
        val parts = ArrayList<String>(2)
        if (pitchMph > 0) parts += "\"pitchSpeed\":$pitchMph"
        if (exitMph > 0) parts += "\"exitVelocity\":$exitMph"
        if (parts.isEmpty()) return null
        return "{" + parts.joinToString(",") + "}"
    }

    /** What a radar packet puts on the wire, and whether it starts the pitch hold. */
    data class PitchReading(val text: String, val restartsPitchHold: Boolean)

    const val PITCH_HOLD_MS = 5_000L

    /** A pitch clear. Exit velocity is absent, so a held exit is left alone. */
    const val PITCH_CLEAR_PAYLOAD = "{\"pitchSpeed\":0}"

    const val PRODUCTION_ACCOUNT_HOST = "gamestation.co"

    fun reading(pitchMph: Int, exitMph: Int): PitchReading? {
        val text = payload(pitchMph, exitMph) ?: return null
        return PitchReading(text, pitchMph > 0)
    }

    /** Bare host. Empty, or an unsubstituted build setting, is gamestation.co. */
    fun accountHost(primaryHost: String?): String {
        var text = primaryHost?.trim().orEmpty()
        if (text == "\$(GS_PRIMARY_HOST)") return PRODUCTION_ACCOUNT_HOST
        text = text.replace(Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://"), "")
        val cut = text.indexOfAny(charArrayOf('/', '?', '#'))
        if (cut >= 0) text = text.substring(0, cut)
        return text.ifEmpty { PRODUCTION_ACCOUNT_HOST }
    }

    fun accountOrigin(primaryHost: String?): String {
        val host = accountHost(primaryHost)
        val plain = host == "localhost" || host.matches(Regex("""\d{1,3}(\.\d{1,3}){3}"""))
        return (if (plain) "http" else "https") + "://$host"
    }

    /** The server closed the door. Retrying would only repeat the refusal. */
    fun stopsRetry(closeCode: Int): Boolean =
        closeCode == 4401 || closeCode == 4403 || closeCode == 4404

    fun eventTitle(away: String, home: String): String = "$away at $home"

    /** "Mon 9/28 3:05 PM" in [zone]. An unreadable stamp is returned as typed. */
    fun localStartTime(startAt: String, zone: ZoneId): String {
        val instant = runCatching { Instant.parse(startAt) }.getOrNull() ?: return startAt
        val zoned = instant.atZone(zone)
        val names = arrayOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
        val day = names[if (zoned.dayOfWeek == DayOfWeek.SUNDAY) 0 else zoned.dayOfWeek.value]
        val hour = zoned.hour
        val hour12 = if (hour % 12 == 0) 12 else hour % 12
        val meridiem = if (hour < 12) "AM" else "PM"
        val minutes = zoned.minute.toString().padStart(2, '0')
        return "$day ${zoned.monthValue}/${zoned.dayOfMonth} $hour12:$minutes $meridiem"
    }

    fun load(store: SettingsStore): ScoreboardSaved {
        val token = store.string(KEY_TOKEN).orEmpty()
        val route = if (store.string(KEY_ROUTE) == "event" && token.isNotEmpty()) {
            ScoreboardRoute.Event
        } else {
            ScoreboardRoute.V1
        }
        return ScoreboardSaved(
            route = route,
            apiServer = store.string(KEY_API_SERVER) ?: DEFAULT_V1_SERVER,
            v1EventId = store.string(KEY_V1_EVENT).orEmpty(),
            accountServer = store.string(KEY_ACCOUNT_SERVER) ?: DEFAULT_ACCOUNT_SERVER,
            token = token,
            displayName = store.string(KEY_DISPLAY_NAME).orEmpty(),
            email = store.string(KEY_EMAIL).orEmpty(),
            gameId = store.string(KEY_GAME_ID).orEmpty(),
            gameTitle = store.string(KEY_GAME_TITLE).orEmpty(),
            gameStartAt = store.string(KEY_GAME_START).orEmpty()
        )
    }

    fun save(store: SettingsStore, saved: ScoreboardSaved) {
        store.setString(if (saved.route == ScoreboardRoute.Event) "event" else "v1", KEY_ROUTE)
        store.setString(saved.apiServer, KEY_API_SERVER)
        store.setString(saved.v1EventId, KEY_V1_EVENT)
        store.setString(saved.accountServer, KEY_ACCOUNT_SERVER)
        store.setString(saved.token, KEY_TOKEN)
        store.setString(saved.displayName, KEY_DISPLAY_NAME)
        store.setString(saved.email, KEY_EMAIL)
        store.setString(saved.gameId, KEY_GAME_ID)
        store.setString(saved.gameTitle, KEY_GAME_TITLE)
        store.setString(saved.gameStartAt, KEY_GAME_START)
    }

    /** Sign-out drops the account and the event route. The last chosen game stays for next time. */
    fun signedOut(saved: ScoreboardSaved): ScoreboardSaved = saved.copy(
        route = ScoreboardRoute.V1,
        token = "",
        displayName = "",
        email = ""
    )

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
