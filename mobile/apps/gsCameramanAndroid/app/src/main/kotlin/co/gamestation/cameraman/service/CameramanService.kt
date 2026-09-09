package co.gamestation.cameraman.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.IBinder
import android.view.OrientationEventListener
import android.view.Surface
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import co.gamestation.cameraman.MainActivity
import co.gamestation.cameraman.R
import co.gamestation.cameraman.engine.AppEnvironment
import co.gamestation.cameraman.harness.LaunchConfiguration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach

/**
 * The foreground service that owns the camera, the encoders and the RTSP listener.
 *
 * This is the whole difference between the two builds. On iOS the pipeline lives in the app process
 * and iOS suspends it the moment the app is backgrounded — the listener stops accepting and, from
 * the Mac driving a test, that is indistinguishable from a server that never bound. Android will let
 * a process keep the camera and the network while backgrounded, but only from a foreground service
 * that declares which resources it is holding, and only if it was started while the app was in the
 * foreground. So:
 *
 * - `foregroundServiceType="camera|microphone"` in the manifest, and the same types passed to
 *   `startForeground`. Both are needed: the manifest declares what the service *may* hold, the call
 *   declares what it *is* holding, and a mismatch throws rather than degrading.
 * - `FOREGROUND_SERVICE_CAMERA` / `_MICROPHONE` permissions, which are install-time but are enforced
 *   at the `startForeground` call — without them it throws `SecurityException` on the first start.
 * - Started from the activity while it is resumed. A service started from the background gets
 *   `ForegroundServiceStartNotAllowedException`, and one that starts anyway without the camera type
 *   has its `CameraDevice` closed by the system as soon as the activity stops.
 * - `START_STICKY` plus the engine's `PARTIAL_WAKE_LOCK`, so a camera on a tripod with the screen
 *   off keeps encoding rather than being scheduled out.
 *
 * The notification is not decoration: it is what the platform requires in exchange, and it is the
 * only way back into a Cameraman whose activity has been swiped away.
 */
class CameramanService : Service() {

    inner class LocalBinder : Binder() {
        val environment: AppEnvironment? get() = this@CameramanService.environment
    }

    private val binder = LocalBinder()
    private var environment: AppEnvironment? = null
    private var scope: CoroutineScope? = null
    private var notificationJob: Job? = null

    /**
     * Which way up the handset is, taken from the accelerometer rather than from the display.
     *
     * The display's rotation is the wrong signal for this service. It reports how the *foreground
     * window* is oriented, so once the activity is swiped away it follows the launcher — a phone
     * clamped in landscape with the launcher in portrait reports ROTATION_0, and deriving the
     * capture rotation from that turns the stream on its side. The service outliving its activity
     * is the whole point of this build, so the frame of reference has to be the device itself.
     *
     * `onConfigurationChanged` is no use either: it does not fire for the 180° between the two
     * landscape holds, because landscape-left and landscape-right share an orientation, a size and
     * a layout. That half turn is the one that matters on a tripod.
     */
    private var orientationListener: OrientationEventListener? = null

    private fun startWatchingOrientation() {
        val listener = object : OrientationEventListener(this) {
            override fun onOrientationChanged(orientation: Int) {
                val rotation = landscapeSurfaceRotation(orientation) ?: return
                val current = environment ?: return
                current.camera.setDisplayRotation(
                    when (rotation) {
                        Surface.ROTATION_90 -> 90
                        Surface.ROTATION_270 -> 270
                        else -> 0
                    }
                )
            }
        }
        // A handset with no accelerometer cannot report, and enabling anyway would silently never
        // fire; the capture rotation then stays at whatever the activity last supplied.
        if (listener.canDetectOrientation()) {
            listener.enable()
            orientationListener = listener
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (environment == null) {
            val launch = LaunchConfiguration.from(intent)
            if (launch.unknownKeys.isNotEmpty()) {
                // A silently ignored launch argument produces a green run that proved nothing.
                android.util.Log.w(
                    AppEnvironment.tag,
                    "CAMERAMAN_UNKNOWN_LAUNCH_KEYS " + launch.unknownKeys.joinToString(",")
                )
            }

            val created = AppEnvironment(applicationContext, launch)
            created.setPermissions(
                camera = granted(Manifest.permission.CAMERA),
                microphone = granted(Manifest.permission.RECORD_AUDIO),
                notifications = granted(Manifest.permission.POST_NOTIFICATIONS)
            )
            environment = created

            startForegroundWithTypes(created)
            created.start()
            // Reports immediately on enable, so a service started while the phone is already in
            // the other hold does not wait for a change that may never come.
            startWatchingOrientation()

            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
            this.scope = scope
            // The notification carries the address and the client count, so an operator can read
            // both from the shade without bringing the app forward.
            notificationJob = combine(created.serverStatus, created.identity) { status, _ -> status }
                .onEach { status ->
                    val manager = getSystemService(NotificationManager::class.java)
                    manager?.notify(notificationId, buildNotification(created, status.clientCount))
                }
                .launchIn(scope)
        }
        // START_STICKY with a null intent on restart is correct: the launch configuration belonged
        // to that test run, and a soak that came back with different settings than it started with
        // would be unreadable.
        return START_STICKY
    }

    override fun onDestroy() {
        orientationListener?.disable()
        orientationListener = null
        notificationJob?.cancel()
        scope?.cancel()
        scope = null
        environment?.stop()
        environment = null
        super.onDestroy()
    }

    /**
     * Both types together, because the app holds both. Passing only `CAMERA` while an `AudioRecord`
     * is open is the case Android 14 added a `SecurityException` for.
     *
     * The microphone type is dropped when audio is off or the permission was refused — claiming a
     * resource that was denied is refused on every build, and claiming one that is not held is
     * refused on some OEM ones.
     */
    private fun startForegroundWithTypes(environment: AppEnvironment) {
        createNotificationChannel()
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (environment.settings.value.audioEnabled && granted(Manifest.permission.RECORD_AUDIO)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        ServiceCompat.startForeground(
            this,
            notificationId,
            buildNotification(environment, clients = 0),
            types
        )
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            channelId,
            getString(R.string.notification_channel_name),
            // Low rather than default: this is a status line an operator glances at, not something
            // that should make a phone on a tripod buzz mid-match.
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.notification_channel_description)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(environment: AppEnvironment, clients: Int): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_IMMUTABLE
        )

        val watchers = when (clients) {
            0 -> "no clients"
            1 -> "1 client"
            else -> "$clients clients"
        }

        return Notification.Builder(this, channelId)
            .setContentTitle(environment.identity.value.name)
            .setContentText("${environment.streamURL} — $watchers")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentIntent(open)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .build()
    }

    companion object {

        /**
         * Landscape-only, so only the two landscape holds are meaningful and a portrait reading is
         * held rather than applied — the app cannot be in portrait, and a phone tipped upright on
         * its way to being re-clamped should not send a quarter-turned picture on the way past.
         * `ORIENTATION_UNKNOWN`, which is what a handset lying flat reports, is held for the same
         * reason.
         */
        fun landscapeSurfaceRotation(degrees: Int): Int? = when {
            degrees == OrientationEventListener.ORIENTATION_UNKNOWN -> null
            degrees in 45..134 -> Surface.ROTATION_270
            degrees in 225..314 -> Surface.ROTATION_90
            else -> null
        }

        const val channelId = "co.gamestation.cameraman.streaming"
        const val notificationId = 1

        fun start(context: Context, intent: Intent?) {
            val service = Intent(context, CameramanService::class.java)
            // The launch extras are forwarded so `am start --es codec hevc` reaches the engine,
            // which lives here rather than in the activity.
            intent?.extras?.let { service.putExtras(it) }
            context.startForegroundService(service)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CameramanService::class.java))
        }
    }
}
