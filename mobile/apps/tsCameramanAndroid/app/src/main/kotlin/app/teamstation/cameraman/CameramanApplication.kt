package app.teamstation.cameraman

import android.app.Application
import app.teamstation.cameraman.sentry.SentrySetup
import app.teamstation.cameraman.observability.AppLog

class CameramanApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppLog.start(this)
        SentrySetup.start(this)
    }
}
