package app.teamstation.speedy

import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import app.teamstation.speedy.audio.ClipPlayer
import app.teamstation.speedy.audio.SpeechCapture
import app.teamstation.speedy.audio.SystemFocus
import app.teamstation.speedy.audio.SystemTrack
import app.teamstation.speedy.core.AudioSetting
import app.teamstation.speedy.core.Cancellable
import app.teamstation.speedy.core.Scheduler
import app.teamstation.speedy.core.SpeedyModel
import app.teamstation.speedy.radar.FleetRadar
import app.teamstation.streamcore.radar.PreferencesRadarFleetStore
import app.teamstation.streamcore.radar.RadarFleet
import app.teamstation.streamcore.radar.systemRadarRadio
import kotlinx.coroutines.MainScope

/** The app's one model, its radar and its player, made once per process. */
class SpeedyEnvironment(context: Context, uiTest: Boolean) {
    private val app = context.applicationContext

    val radar = FleetRadar(
        fleet = RadarFleet(
            store = PreferencesRadarFleetStore(
                app,
                FleetRadar.FILE,
                serialsKey = FleetRadar.SERIALS,
                enabledKey = FleetRadar.ENABLED,
                enabledByDefault = true
            ),
            newRadio = { systemRadarRadio(app) },
            bluetoothOn = {
                app.getSystemService(BluetoothManager::class.java)?.adapter?.isEnabled == true
            },
            locationOn = { app.getSystemService(LocationManager::class.java)?.isLocationEnabled == true },
            permissionsGranted = { permissionsGranted(app) },
            log = { Log.i("SpeedyRadar", it) },
            limit = 1
        ),
        scope = MainScope()
    )

    val player = ClipPlayer(
        clipBytes = { name -> runCatching { app.assets.open("$name.wav").use { it.readBytes() } }.getOrNull() },
        tracks = { SystemTrack.of(it) },
        focus = SystemFocus(app),
        capture = if (uiTest) SpeechCapture(java.io.File(app.filesDir, SpeechCapture.NAME)) else null
    )

    val model = SpeedyModel(
        radar = radar,
        player = player,
        audioSetting = AudioSetting(app.getSharedPreferences(AudioSetting.FILE, Context.MODE_PRIVATE)),
        scheduler = MainScheduler(),
        uiTest = uiTest
    )

    companion object {
        @Volatile
        private var shared: SpeedyEnvironment? = null

        /** The process's environment; the first launch decides whether it is a UI test. */
        fun get(context: Context, uiTest: Boolean): SpeedyEnvironment =
            shared ?: synchronized(this) { shared ?: SpeedyEnvironment(context, uiTest).also { shared = it } }

        /** Tests only: the next [get] makes a new environment. */
        fun forget() {
            shared = null
        }

        fun missingPermissions(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): List<String> =
            FleetRadar.permissions(sdkInt).filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }

        fun permissionsGranted(context: Context): Boolean = missingPermissions(context).isEmpty()
    }
}

/** The 250 ms hold and the UI tests' sequences, on the main thread. */
class MainScheduler(private val handler: Handler = Handler(Looper.getMainLooper())) : Scheduler {
    override fun after(delayMs: Long, work: () -> Unit): Cancellable {
        val runnable = Runnable { work() }
        handler.postDelayed(runnable, delayMs)
        return Cancellable { handler.removeCallbacks(runnable) }
    }
}
