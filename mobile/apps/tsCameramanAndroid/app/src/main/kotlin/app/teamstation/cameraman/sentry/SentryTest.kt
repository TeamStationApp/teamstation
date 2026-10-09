package app.teamstation.cameraman.sentry

/**
 * A crash in the app's own native code, so a test can see the NDK handler report it with the
 * function named. It lives in `libsocketqueue`, the app's one native library, loaded here because
 * the test runs at launch, before `SocketQueue` would have loaded it.
 */
object SentryTest {
    init {
        System.loadLibrary("socketqueue")
    }

    external fun nativeCrash()
}
