package app.teamstation.speedy

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import app.teamstation.speedy.core.ControlCommand
import app.teamstation.speedy.radar.FleetRadar
import app.teamstation.speedy.ui.SpeedyScreen

/**
 * The one screen. It keeps the display on, asks for Bluetooth at launch so a paired radar connects
 * without a visit to Settings, starts the radar once that is answered, and passes UI-test links on.
 */
class MainActivity : ComponentActivity() {
    lateinit var environment: SpeedyEnvironment
        private set
    private var radarStarted = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { onPermissionResult() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        environment = SpeedyEnvironment.get(this, ControlCommand.isUITest(intent?.extras?.get(UI_TEST)))
        setContent {
            SpeedyScreen(
                model = environment.model,
                onAllowBluetooth = ::askForPermissions,
                keepsScreenOn = { window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0 }
            )
        }
        handleLink(intent)
        if (SpeedyEnvironment.missingPermissions(this).isEmpty()) startRadar() else askForPermissions()
    }

    override fun onResume() {
        super.onResume()
        if (radarStarted) environment.model.refresh()
    }

    public override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    fun askForPermissions() {
        permissionLauncher.launch(FleetRadar.permissions(Build.VERSION.SDK_INT).toTypedArray())
    }

    /** Whatever was granted, the radar starts, and looks again at what it may now use. */
    fun onPermissionResult() {
        startRadar()
        environment.model.refresh()
    }

    private fun startRadar() {
        if (radarStarted) return
        radarStarted = true
        environment.model.start()
    }

    private fun handleLink(intent: Intent?) {
        val link = intent?.dataString ?: return
        environment.model.handle(link)
    }

    companion object {
        const val UI_TEST = "uiTest"
    }
}
