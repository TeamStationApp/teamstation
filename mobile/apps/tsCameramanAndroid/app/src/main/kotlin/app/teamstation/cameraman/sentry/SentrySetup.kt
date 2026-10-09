package app.teamstation.cameraman.sentry

import android.content.Context
import android.content.Intent
import app.teamstation.cameraman.BuildConfig
import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions
import io.sentry.protocol.Message
import io.sentry.protocol.User

/**
 * Crash reporting for TS Cameraman, from the DSN and server host the build was made with
 * (`BuildConfig.TS_SENTRY_DSN`, `BuildConfig.TS_PRIMARY_HOST`). A build without a DSN reports
 * nothing. Java and native (NDK) crashes are both caught; every event goes through `SentryRules`.
 */
object SentrySetup {
    private const val APP_ID = "app.teamstation.cameraman"

    fun start(
        context: Context,
        dsn: String = BuildConfig.TS_SENTRY_DSN,
        configure: (SentryAndroidOptions) -> Unit = {},
    ) {
        if (dsn.isEmpty()) return
        val (release, dist) = SentryRules.release(
            APP_ID,
            BuildConfig.VERSION_NAME,
            BuildConfig.VERSION_CODE.toString(),
        )
        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.release = release
            options.dist = dist
            options.environment = SentryRules.environment(BuildConfig.TS_PRIMARY_HOST)
            options.isSendDefaultPii = false
            options.setBeforeSend { event, _ -> scrub(event) }
            options.setBeforeBreadcrumb { crumb, _ ->
                if (crumb.category == "console") {
                    null
                } else {
                    crumb.message = crumb.message?.let(SentryRules::scrubText)
                    val data = SentryRules.scrubMap(crumb.data)
                    crumb.data.clear()
                    data.forEach { (key, value) -> if (value != null) crumb.setData(key, value) }
                    crumb
                }
            }
            configure(options)
        }
    }

    /**
     * `sentryTest=error` sends a test error; `sentryTest=crash` crashes in native code. Only in a
     * build made for testing it (`TS_SENTRY_TESTS=1`), since any app can start the exported
     * launcher activity; only on a fresh launch; and the extra is consumed, so an activity
     * recreated from the same intent (a rotation, a task restored from recents) does not send or
     * crash again.
     */
    fun handleTest(
        intent: Intent?,
        savedInstanceState: Any?,
        enabled: Boolean = BuildConfig.TS_SENTRY_TESTS,
        crash: () -> Unit = SentryTest::nativeCrash,
    ) {
        if (!enabled || intent == null || savedInstanceState != null) return
        val test = SentryRules.test(intent.getStringExtra("sentryTest"))
        intent.removeExtra("sentryTest")
        when (test) {
            "error" -> Sentry.captureException(IllegalStateException("Sentry test error"))
            "crash" -> crash()
        }
    }

    fun scrub(event: SentryEvent): SentryEvent {
        event.message?.formatted?.let { event.message = Message().apply { formatted = SentryRules.scrubText(it) } }
        // A transaction can be named after a raw request path.
        event.transaction = event.transaction?.let(SentryRules::scrubText)
        event.exceptions?.forEach { exception -> exception.value = exception.value?.let(SentryRules::scrubText) }
        event.request?.let { request ->
            request.cookies = null
            request.queryString = null
            request.data = null
            request.url = request.url?.let(SentryRules::scrubText)
            request.headers = request.headers?.let(SentryRules::scrubHeaders)
        }
        event.serverName = null
        event.user = event.user?.id?.let { id -> User().apply { this.id = id } }
        event.extras?.let { extras ->
            val clean = SentryRules.scrubMap(extras)
            event.extras = clean.filterValues { it != null }.mapValues { it.value!! }
        }
        // The SDK's own contexts (device, app, OS) are typed and hold no secret; one an app sets
        // is a map, and is scrubbed like `extras`.
        val contexts = event.contexts
        for (key in contexts.keys().toList()) {
            val value = contexts.get(key)
            when {
                SentryRules.isSecret(key) -> contexts.remove(key)
                value is Map<*, *> -> contexts.put(key, SentryRules.scrubMap(value))
            }
        }
        event.breadcrumbs = event.breadcrumbs?.filter { it.category != "console" }?.onEach { crumb ->
            crumb.message = crumb.message?.let(SentryRules::scrubText)
        }
        return event
    }
}
