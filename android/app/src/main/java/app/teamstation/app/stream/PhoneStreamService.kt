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
 *
 * Every start goes through `startForegroundService`, and Android ends the app if such a service
 * stops before it has called `startForeground`. So the service always calls `startForeground` first,
 * and stops itself afterwards if the work has ended meanwhile; [Work] never stops a service whose
 * start is still on its way ([Book]).
 */
class PhoneStreamService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val requested = intent?.let { State(it.getStringExtra(EXTRA_RECORDING), it.getStringExtra(EXTRA_UPLOADING)) }
        val shown = book.shown(requested)
        val started = try {
            startForeground(NOTIFICATION_ID, notification(shown), book.types(shown))
            true
        } catch (error: RuntimeException) {
            // Started from the background, or a permission withdrawn: the work goes on without it.
            Log.w(TAG, "startForeground", error)
            false
        }
        // Only this start: a newer one already on its way still gets its onStartCommand.
        if (book.afterStart(started)) stopSelf(startId)
        return START_NOT_STICKY
    }

    /**
     * Android 15 and later: the day's `dataSync` time is spent. Recording keeps the service as
     * `camera|microphone`; with nothing else to keep it, it stops, as Android requires.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        val remaining = book.dataSyncTimedOut()
        if (remaining != null) {
            try {
                startForeground(NOTIFICATION_ID, notification(remaining), book.types(remaining))
                return
            } catch (error: RuntimeException) {
                Log.w(TAG, "startForeground after the dataSync timeout", error)
            }
        }
        stopSelf()
    }

    override fun onDestroy() {
        book.destroyed()
        super.onDestroy()
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

        override fun recordingStarted(angleName: String) = update { it.copy(recording = angleName) }
        override fun recordingStopped() = update { it.copy(recording = null) }
        override fun uploadStarted(angleName: String) = update { it.copy(uploading = angleName) }
        override fun uploadsFinished() = update { it.copy(uploading = null) }

        private fun update(change: (State) -> State) {
            val (next, action) = book.changed(change)
            val intent = Intent(app, PhoneStreamService::class.java)
                .putExtra(EXTRA_RECORDING, next.recording)
                .putExtra(EXTRA_UPLOADING, next.uploading)
            try {
                when (action) {
                    Action.START -> ContextCompat.startForegroundService(app, intent)
                    Action.STOP -> app.stopService(intent)
                    Action.NONE -> Unit
                }
            } catch (error: RuntimeException) {
                Log.w(TAG, "foreground service", error)
                if (action == Action.START) book.startFailed()
            }
        }
    }

    /** What [Work] does with the service after a change in the work. */
    enum class Action { START, STOP, NONE }

    /**
     * The bookkeeping between [Work], on the engine's thread, and the service, on the main thread:
     * the work in hand, the starts asked for that have not reached `onStartCommand`, and whether the
     * service is in the foreground.
     */
    class Book {
        private var current = State()
        private var pendingStarts = 0
        private var foreground = false
        private var dataSyncSpent = false

        val state: State @Synchronized get() = current

        /**
         * Applies a change to the work, answering the new state and what to do: start (or retype)
         * the service while there is work; stop it once there is none, but only a service that is
         * in the foreground with no start on its way, since one still starting stops itself after
         * its `startForeground`.
         */
        @Synchronized
        fun changed(change: (State) -> State): Pair<State, Action> {
            val next = change(current)
            current = next
            // A new upload is a new try at dataSync.
            if (next.uploading == null) dataSyncSpent = false
            val action = when {
                next.active -> {
                    pendingStarts += 1
                    Action.START
                }
                pendingStarts > 0 -> Action.NONE
                foreground -> Action.STOP
                else -> Action.NONE
            }
            return next to action
        }

        /** A start that Android refused never reaches `onStartCommand`. */
        @Synchronized
        fun startFailed() {
            if (pendingStarts > 0) pendingStarts -= 1
        }

        /**
         * What a start shows: the work in hand, or, when it ended before the service got here, the
         * work the start was asked for, which its `startForeground` still has to name.
         */
        @Synchronized
        fun shown(requested: State?): State = when {
            current.active -> current
            requested != null && requested.active -> requested
            else -> State()
        }

        /**
         * After a start's `startForeground`: whether the service should stop. It stops when the work
         * has ended, or when it never reached the foreground at all. A re-type that failed keeps the
         * foreground it already has, so a recording it protects is not dropped.
         */
        @Synchronized
        fun afterStart(started: Boolean): Boolean {
            if (pendingStarts > 0) pendingStarts -= 1
            val wasForeground = foreground
            if (started) foreground = true
            val stop = !current.active || (!started && !wasForeground)
            if (stop && pendingStarts == 0) foreground = false
            return stop && pendingStarts == 0
        }

        /** The service's types for [state]: without dataSync once its time is spent. */
        @Synchronized
        fun types(state: State): Int {
            val types = serviceTypes(state.recording != null, state.uploading != null && !dataSyncSpent)
            return if (types == 0) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else types
        }

        /** The dataSync time ran out: what the service still shows, or null when nothing is left. */
        @Synchronized
        fun dataSyncTimedOut(): State? {
            dataSyncSpent = true
            return if (current.recording != null) current else null
        }

        @Synchronized
        fun destroyed() {
            foreground = false
        }
    }

    companion object {
        private const val TAG = "PhoneStreamService"
        private const val CHANNEL = "phoneStream"
        private const val NOTIFICATION_ID = 4720
        private const val EXTRA_RECORDING = "recording"
        private const val EXTRA_UPLOADING = "uploading"

        /** The process's one book, which [Work] and the service share. */
        internal val book = Book()

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
