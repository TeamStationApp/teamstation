package app.teamstation.cameraman.sentry

import android.content.Context
import android.content.Intent
import app.teamstation.cameraman.BuildConfig
import app.teamstation.cameraman.observability.LogEndpoint
import app.teamstation.observability.NativeSentryPrivacy
import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions

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
        if (LogEndpoint.from(dsn) == null) return
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
            NativeSentryPrivacy.configure(options)
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

    fun scrub(event: SentryEvent): SentryEvent = NativeSentryPrivacy.scrub(event)
}
