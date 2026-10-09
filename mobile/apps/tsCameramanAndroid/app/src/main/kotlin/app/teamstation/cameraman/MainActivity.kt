package app.teamstation.cameraman

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.os.IBinder
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import app.teamstation.cameraman.core.ActivityPresence
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.harness.ControlChannel
import app.teamstation.cameraman.sentry.SentrySetup
import app.teamstation.cameraman.service.CameramanService
import app.teamstation.cameraman.ui.RootScreen
import app.teamstation.cameraman.ui.theme.CameramanTheme

/**
 * A window onto the service, and nothing more.
 *
 * Every piece of state that matters — the camera, the encoders, the listener, the identity — lives
 * in [CameramanService]. Closing this activity keeps that service only while a broadcast is on.
 * Otherwise the service is stopped, so a quiet camera is not a background process. The iOS build
 * cannot keep a broadcast up either way, because iOS suspends a backgrounded app.
 *
 * The camera stays landscape, so the encoded dimensions never change mid-stream. `sensorLandscape`
 * is the launch orientation; Settings switches the window to either orientation and back.
 * Both landscape holds are legitimate on a tripod; the 180° that separates them is applied
 * to the buffers by `CaptureRenderer`, not to the layout.
 */
class MainActivity : ComponentActivity() {

    private var environment by mutableStateOf<AppEnvironment?>(null)
    private var isBound = false
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Home and a dialog both stop the activity. A dialog comes back; home does not. Waiting briefly
     * tells them apart, and a destroy cancels the wait and stops immediately.
     */
    private val releaseIfIdle = Runnable {
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@Runnable
        val current = environment ?: return@Runnable
        if (!current.isBroadcasting) releaseService()
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = binder as? CameramanService.LocalBinder
            environment = local?.environment
            handleControlIntent(intent)
            // Left before the bind finished. The service may already have decided to stay because
            // the activity was still visible when it started.
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                environment?.isBroadcasting != true
            ) {
                mainHandler.post { releaseService() }
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            environment = null
        }
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        // The service is started whatever was granted. A refused camera is a diagnostic screen that
        // says so, which is more useful than an app that will not launch.
        startAndBind()
    }

    /**
     * Ask to be left off the battery optimisation list, once, if we are not already off it.
     *
     * A typed foreground service survives most of Doze, which is why a ten-minute test always
     * passes. Hours is a different question: Adaptive Battery on a Pixel will still throttle an
     * app it considers idle, and the operator has no way to tell that from a camera that simply
     * stopped. `isIgnoringBatteryOptimizations` is checked first so a phone that is already
     * exempt never sees a dialog, which matters because this runs at every launch.
     *
     * There is no iOS equivalent: an app in an audio/capture session is not throttled this way.
     */
    private fun requestBatteryOptimisationExemption() {
        val power = getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        if (power.isIgnoringBatteryOptimizations(packageName)) return
        runCatching {
            startActivity(
                Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")
                )
            )
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SentrySetup.handleTest(intent, savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        requestBatteryOptimisationExemption()
        // The iOS build sets `isIdleTimerDisabled` for the same reason: a screen lock is what makes
        // an unattended device run end early. The service's wake lock covers the rest.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setContent {
            CameramanTheme {
                Box(
                    // Compose test tags are not resource ids by default, so a Maestro `id:` selector
                    // finds nothing while the element is plainly on screen — the same class of trap
                    // as the invisible permission dialogs. This opts the whole tree in, once.
                    modifier = Modifier
                        .fillMaxSize()
                        .semantics { testTagsAsResourceId = true }
                ) {
                    val current = environment
                    if (current == null) {
                        Surface(
                            modifier = Modifier
                                .fillMaxSize()
                                .testTag("starting"),
                            color = MaterialTheme.colorScheme.background
                        ) {
                            Column(
                                modifier = Modifier.fillMaxSize(),
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.Center
                            ) {
                                CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.size(16.dp))
                                Text(
                                    "Starting TS Cameraman",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onBackground
                                )
                            }
                        }
                    } else {
                        RootScreen(current)
                    }
                }
            }
        }

        val missing = requiredPermissions().filterNot {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            // Asked before the service is started, because a camera-typed foreground service whose
            // camera permission was never granted is refused outright on API 34+.
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    override fun onStart() {
        super.onStart()
        ActivityPresence.visible = true
        mainHandler.removeCallbacks(releaseIfIdle)
        if (requiredPermissions().all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        ) {
            startAndBind()
        }
    }

    override fun onStop() {
        ActivityPresence.visible = false
        // A broadcast keeps the service, including across this stop. Anything else is released once
        // it is clear the activity is not coming straight back.
        mainHandler.postDelayed(releaseIfIdle, 400)
        super.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleControlIntent(intent)
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(releaseIfIdle)
        val keep = environment?.isBroadcasting == true
        if (isBound) {
            unbindService(connection)
            isBound = false
        }
        if (!keep) CameramanService.stop(this)
        super.onDestroy()
    }

    private fun releaseService() {
        if (isBound) {
            unbindService(connection)
            isBound = false
        }
        environment = null
        CameramanService.stop(this)
    }

    private fun startAndBind() {
        if (isBound) return
        // Started from a resumed activity, which is the only state Android 14 will let a
        // camera-typed foreground service begin from.
        CameramanService.start(this, intent)
        isBound = bindService(
            Intent(this, CameramanService::class.java),
            connection,
            Context.BIND_AUTO_CREATE
        )
    }

    /**
     * `tscameraman://test/<command>` as an intent, so a flow can drive the app with `adb shell am
     * start` on a device with no port forwarding set up. Ignored unless the app was launched for UI
     * testing, exactly as on iOS.
     */
    private fun handleControlIntent(intent: Intent?) {
        val data = intent?.data ?: return
        val current = environment ?: return
        if (!current.launch.isUITest) return
        ControlChannel.command(data.toString())?.let { current.handle(it) }
    }

    private fun requiredPermissions(): List<String> = listOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.POST_NOTIFICATIONS,
        Manifest.permission.BLUETOOTH_SCAN,
        Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.ACCESS_FINE_LOCATION
    )
}
