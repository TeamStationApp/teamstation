package app.teamstation.streamcore.phonestream

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.util.Log
import app.teamstation.streamcore.radar.PreferencesRadarFleetStore
import app.teamstation.streamcore.radar.RadarDeviceState
import app.teamstation.streamcore.radar.RadarFleet
import app.teamstation.streamcore.radar.systemRadarRadio
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The phone's radars as the overlay's Radar card shows them: on or off, Bluetooth, every paired radar
 * with its connection, battery and last speeds, and what a scan has found.
 */
data class PhoneRadarState(
    val enabled: Boolean,
    val scanning: Boolean,
    /** `on`, `off` or `unknown`, as TS Cameraman's `RadarPower` names it. */
    val bluetooth: String,
    val devices: List<RadarDeviceState>,
    /** Radars in range that are not paired, while scanning. */
    val nearby: List<String>
)

/** Any number of paired radars, through TS Cameraman's [RadarFleet]. */
class PhoneRadar(val fleet: RadarFleet, private val bluetoothOn: () -> Boolean?) {
    private var started = false
    private var watching: Job? = null

    val state: PhoneRadarState
        get() = PhoneRadarState(
            enabled = fleet.enabled.value,
            scanning = fleet.scanning.value,
            bluetooth = when (bluetoothOn()) {
                true -> "on"
                false -> "off"
                null -> "unknown"
            },
            devices = fleet.devices.value,
            nearby = fleet.nearby.value
        )

    /** Brings the paired radars up when the radar is on, and reports every change after. Once. */
    fun start(scope: CoroutineScope, onChange: (PhoneRadarState) -> Unit) {
        if (started) return
        started = true
        fleet.start()
        watching = scope.launch {
            combine(fleet.enabled, fleet.scanning, fleet.devices, fleet.nearby) { _, _, _, _ -> state }
                .collect { onChange(it) }
        }
    }

    fun stop() {
        watching?.cancel()
        watching = null
    }

    fun setEnabled(enabled: Boolean) = fleet.setEnabled(enabled)
    fun scan() = fleet.scan()
    fun stopScan() = fleet.stopScan()
    fun pair(serial: String): Boolean = fleet.pair(serial)
    fun unpair(serial: String) = fleet.unpair(serial)

    /** Bluetooth or a permission changed. */
    fun refresh() = fleet.refresh()

    companion object {
        /** The phone's radar switch and pairings: any number of radars, off until turned on. */
        const val PREFERENCES_FILE = "app.teamstation.phoneStream.radar"
        const val SERIALS_KEY = "serials"
        const val ENABLED_KEY = "enabled"

        fun store(context: Context) = PreferencesRadarFleetStore(
            context,
            PREFERENCES_FILE,
            serialsKey = SERIALS_KEY,
            enabledKey = ENABLED_KEY,
            enabledByDefault = false
        )

        /**
         * What the phone asks for before a scan: the Bluetooth pair on Android 12 and later, where the
         * app declares its scan `neverForLocation`, and fine location on Android 11.
         */
        @SuppressLint("InlinedApi")
        fun permissions(sdkInt: Int = Build.VERSION.SDK_INT): List<String> =
            if (sdkInt >= Build.VERSION_CODES.S) {
                listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
            } else {
                listOf(Manifest.permission.ACCESS_FINE_LOCATION)
            }

        /** The phone's own radios, store and permissions. */
        fun system(context: Context): PhoneRadar {
            val app = context.applicationContext
            val bluetooth = { (app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter?.isEnabled }
            val fleet = RadarFleet(
                store = store(app),
                newRadio = { systemRadarRadio(app) },
                bluetoothOn = { bluetooth() == true },
                // Android 12 scans without location once `neverForLocation` is declared.
                locationOn = {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ||
                        app.getSystemService(LocationManager::class.java)?.isLocationEnabled == true
                },
                permissionsGranted = { permissions().all { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED } },
                log = { Log.i("PhoneStreamRadar", it) }
            )
            return PhoneRadar(fleet, bluetooth)
        }
    }
}
