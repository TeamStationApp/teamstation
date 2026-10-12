package app.teamstation.app.stream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import app.teamstation.streamcore.phonestream.PhoneForegroundWork

/**
 * Keeps the phone's recording and uploads running with the screen off or the app in the
 * background: a foreground service of type `camera|microphone` while recording, and `dataSync` while
 * an upload runs, with a notification saying which. The engine says when each starts and ends
 * ([Work]); the service is started, retyped and stopped to match.
 */
class PhoneStreamService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val state = Work.current
        if (!state.active) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            startForeground(NOTIFICATION_ID, notification(state), serviceTypes(state.recording != null, state.uploading != null))
        } catch (error: RuntimeException) {
            // Started from the background, or a permission withdrawn: the work goes on without it.
            Log.w(TAG, "startForeground", error)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun notification(state: State): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Recording and uploads", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        return Notification.Builder(this, CHANNEL)
            .setContentTitle(title(state))
            .setSmallIcon(if (state.recording != null) android.R.drawable.presence_video_online else android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    /** What the engine is doing: the angle recording and the angle uploading, each null when not. */
    data class State(val recording: String? = null, val uploading: String? = null) {
        val active: Boolean get() = recording != null || uploading != null
    }

    /** The engine's [PhoneForegroundWork], which starts, retypes and stops the service. */
    class Work(context: Context) : PhoneForegroundWork {
        private val app = context.applicationContext

        override fun recordingStarted(angleName: String) = update(current.copy(recording = angleName))
        override fun recordingStopped() = update(current.copy(recording = null))
        override fun uploadStarted(angleName: String) = update(current.copy(uploading = angleName))
        override fun uploadsFinished() = update(current.copy(uploading = null))

        private fun update(next: State) {
            current = next
            val intent = Intent(app, PhoneStreamService::class.java)
            try {
                if (next.active) ContextCompat.startForegroundService(app, intent) else app.stopService(intent)
            } catch (error: RuntimeException) {
                Log.w(TAG, "foreground service", error)
            }
        }

        companion object {
            @Volatile
            internal var current = State()
        }
    }

    companion object {
        private const val TAG = "PhoneStreamService"
        private const val CHANNEL = "phoneStream"
        private const val NOTIFICATION_ID = 4720

        /** `camera|microphone` while recording, `dataSync` while uploading, all three for both. */
        fun serviceTypes(recording: Boolean, uploading: Boolean): Int {
            var types = 0
            if (recording) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (uploading) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            return types
        }

        fun title(state: State): String {
            val recording = state.recording
            val uploading = state.uploading
            return when {
                recording != null && uploading != null -> "Recording $recording · uploading $uploading"
                recording != null -> "Recording $recording"
                uploading != null -> "Uploading $uploading"
                else -> "TeamStation"
            }
        }
    }
}
