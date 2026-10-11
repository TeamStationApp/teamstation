package app.teamstation.cameraman.scoreboard

import android.content.Intent
import java.net.URI
import java.net.URLDecoder

/**
 * What a link handed to the app means for signing in: the twin of TeamStationKit's `SignInLink`.
 *
 * The server mails a sign-in asked for in the app to the app's own link host:
 * `<appOrigin>/signin/<token>?server=<the server that issued it>`. Android hands that address to
 * the app because the host is the app's, verified. The token is spent only against the server
 * that issued it, so a link from another server is never sent anywhere.
 */
internal sealed class SignInLink {
    /** This app's server issued it: spend the token. */
    data class Spend(val token: String) : SignInLink()

    /** Another name issued it; it is this app's server only if the server's OpenID issuer is `<server>/oauth`. */
    data class Confirm(val token: String, val server: String) : SignInLink()

    /** Not a sign-in link of this app's. */
    data object NotSignIn : SignInLink()

    companion object {
        private val TOKEN = Regex("^[A-Za-z0-9_-]{16,128}$")

        /** Reads [url] for an app whose link host is [appOrigin], signing in to [serverOrigin]. */
        fun read(url: String, appOrigin: String, serverOrigin: String): SignInLink {
            if (appOrigin.isEmpty()) return NotSignIn
            val link = runCatching { URI(url) }.getOrNull() ?: return NotSignIn
            val app = runCatching { URI(appOrigin) }.getOrNull() ?: return NotSignIn
            if (!link.scheme.equals("https", ignoreCase = true)) return NotSignIn
            if (!link.host.equals(app.host, ignoreCase = true) || link.port != app.port) return NotSignIn
            val segments = (link.rawPath ?: "").split('/').filter { it.isNotEmpty() }
            if (segments.size != 2 || segments[0] != "signin" || !TOKEN.matches(segments[1])) return NotSignIn
            val token = segments[1]
            val server = (link.rawQuery ?: "").split('&')
                .map { it.split('=', limit = 2) }
                .firstOrNull { it[0] == "server" && it.size == 2 }
                ?.let { URLDecoder.decode(it[1], Charsets.UTF_8) }
            return if (server.isNullOrEmpty() || server.equals(serverOrigin, ignoreCase = true)) {
                Spend(token)
            } else {
                Confirm(token, server)
            }
        }

        /** What the app says when a link was issued by another server. */
        fun wrongServer(server: String, own: String): String =
            "This link is for $server. This app signs in to $own."

        /**
         * What the app says when its server could not be asked whether another name is its own:
         * not another server's link, and opening it again asks again.
         */
        fun unreachable(own: String): String = "Couldn’t reach $own to check this link. Try again."
    }
}

/**
 * Hands an `ACTION_VIEW` https intent's address to [spend], the desk's `signIn`. When the desk
 * takes it as a sign-in link, the intent's data is cleared so a rotation or rebind does not spend
 * it twice. An activity reopened from Recents gets the intent that first launched it back, with
 * `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`: that link was already handled, and is left alone. Returns
 * whether it was taken.
 */
internal fun spendSignInIntent(intent: Intent?, spend: (String) -> Boolean): Boolean {
    if (intent?.action != Intent.ACTION_VIEW) return false
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return false
    val data = intent.data ?: return false
    if (!data.scheme.equals("https", ignoreCase = true)) return false
    if (!spend(data.toString())) return false
    intent.data = null
    return true
}
