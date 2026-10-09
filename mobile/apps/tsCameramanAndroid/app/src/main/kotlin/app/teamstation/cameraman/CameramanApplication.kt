package app.teamstation.cameraman

import android.app.Application
import app.teamstation.cameraman.sentry.SentrySetup

class CameramanApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        SentrySetup.start(this)
    }
}
