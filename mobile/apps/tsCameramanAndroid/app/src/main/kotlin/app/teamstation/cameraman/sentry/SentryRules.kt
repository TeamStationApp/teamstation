package app.teamstation.cameraman.sentry

/**
 * What a crash report from TS Cameraman may carry: the same rules the TeamStation app and server
 * follow (`src/common/sentry` in the TeamStation repository). Plain Kotlin, so the JVM tests run it.
 *
 * Nothing that signs a person in leaves the phone: no session token, password hash, sign-in code
 * or link, invite code, stream key, media signature, CSRF token or cookie, and no email address.
 * These rules are the only scrub; the Sentry server's own is off.
 */
object SentryRules {
    const val FILTERED = "[Filtered]"
    const val PRODUCT_HOST = "app.teamstation.app"

    /**
     * Names that may hold a secret. A bare `code` and anything `session` stay in, though they also
     * name harmless things, because the sign-in code and the session token travel under them.
     */
    private val secretKey = Regex(
        "token|secret|passw|clienthash|code|cookie|authorization|bearer|session|credential|csrf|" +
            "api[-_]?key|private[-_]?key|stream[-_]?key|dsn|email",
        RegexOption.IGNORE_CASE,
    )

    /** Names that contain a secret's word but hold none: status and error codes. */
    private val safeKey = Regex(
        "^(http\\.(response\\.)?)?status_?code$|^(error|exit)_?code$",
        RegexOption.IGNORE_CASE,
    )
    private val textRules = listOf(
        Regex("(rtmps?://[^\\s/]+(?:/[^\\s/]+)*)/[^\\s/]+") to "$1/$FILTERED",
        // A query follows a URL or path character and starts with a word character, so `a?.b()`
        // and `'?'` in an error message are left alone.
        Regex("([\\w/.%-])\\?[\\w%-][^\\s#'\"()]*") to "$1",
        Regex("/signin/[^\\s/?#]+") to "/signin/$FILTERED",
        Regex("/(i|join|invite|approvals|native-approval)/[^\\s/?#]+") to "/$1/$FILTERED",
        Regex("/media/[^\\s/?#]+/[^\\s/?#]+/") to "/media/$FILTERED/",
        Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}") to "[email]",
    )

    /** Text — a URL, a message, an exception's value — with the secrets in it filtered. */
    fun scrubText(text: String): String =
        textRules.fold(text) { out, (rule, replacement) -> rule.replace(out, replacement) }

    /** Whether a field of this name may hold a secret. */
    fun isSecret(key: String): Boolean = secretKey.containsMatchIn(key) && !safeKey.matches(key)

    /** A copy of any JSON-like value with secret-named fields and URLs filtered. */
    fun scrubValue(value: Any?, depth: Int = 0): Any? = when {
        value is String -> scrubText(value)
        depth > 8 -> FILTERED
        value is List<*> -> value.map { scrubValue(it, depth + 1) }
        value is Map<*, *> -> scrubMap(value, depth)
        else -> value
    }

    fun scrubMap(map: Map<*, *>, depth: Int = 0): Map<String, Any?> =
        map.entries.associate { (key, item) ->
            val name = key.toString()
            name to if (isSecret(name)) FILTERED else scrubValue(item, depth + 1)
        }

    /** Headers with every secret-named one removed. */
    fun scrubHeaders(headers: Map<String, String>): Map<String, String> =
        headers.filterKeys { !isSecret(it) }.mapValues { scrubText(it.value) }

    /** `<appId>@<version>+<build>`, with the build as dist, as the TeamStation app names itself. */
    fun release(appId: String, version: String, build: String?): Pair<String, String?> =
        if (build.isNullOrEmpty()) "$appId@$version" to null else "$appId@$version+$build" to build

    /**
     * `production` for the product host, a development seat's own name for its host, and
     * `development` for anything local; an empty host is the product host.
     */
    fun environment(host: String?): String {
        var name = host?.trim()?.lowercase().orEmpty().ifEmpty { PRODUCT_HOST }
        if (!name.startsWith("[")) name = name.substringBefore(':')
        return when {
            name == "localhost" || name.endsWith(".local") || name.startsWith("[") -> "development"
            name.all { it.isDigit() || it == '.' } -> "development"
            name == PRODUCT_HOST -> "production"
            else -> name.substringBefore('.')
        }
    }

    /** What the `sentryTest` launch extra asks for: `error`, `crash`, or nothing. */
    fun test(extra: String?): String? = extra?.takeIf { it == "error" || it == "crash" }
}
