package app.teamstation.speedy.radar

import android.Manifest
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.SpeedyRadar
import app.teamstation.streamcore.radar.RadarConnection
import app.teamstation.streamcore.radar.RadarFleet
import app.teamstation.streamcore.radar.RadarPermissions
import app.teamstation.streamcore.radar.RadarPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** The shared TAG One fleet, held to one radar and always on, as TS Speedy's [SpeedyRadar]. */
class FleetRadar(
    val fleet: RadarFleet,
    private val scope: CoroutineScope
) : SpeedyRadar {
    override var onChange: (() -> Unit)? = null
    override var onSpeeds: ((Int, Int) -> Unit)? = null
    private var started = false

    init {
        fleet.onSpeeds = { _, pitch, exit -> onSpeeds?.invoke(pitch, exit) }
    }

    override val status: RadarStatus
        get() {
            val device = fleet.devices.value.firstOrNull()
            return RadarStatus(
                serial = device?.serial,
                link = device?.let { link(it.connection) },
                blocker = blocker(fleet.cameramanState.value.phase),
                batteryPercent = device?.batteryPercent,
                nearby = fleet.nearby.value,
                pairing = fleet.scanning.value
            )
        }

    /** Once: the stored pairing comes back, the radar turns on, and every change is passed on. */
    override fun start() {
        if (started) return
        started = true
        fleet.start()
        if (!fleet.enabled.value) fleet.setEnabled(true)
        scope.launch {
            combine(fleet.devices, fleet.nearby, fleet.scanning, fleet.cameramanState) { _, _, _, _ -> }
                .collect { onChange?.invoke() }
        }
    }

    override fun refresh() {
        if (started) fleet.refresh()
    }

    override fun startPairing() = fleet.scan()
    override fun stopPairing() = fleet.stopScan()

    override fun pair(name: String) {
        fleet.pair(name)
    }

    override fun unpair() = fleet.unpairAll()

    companion object {
        /** The preferences file and keys TS Speedy keeps its pairing under. */
        const val FILE = "app.teamstation.speedy.radar"
        const val SERIALS = "serial"
        const val ENABLED = "enabled"

        /**
         * What TS Speedy asks for. From Android 12 a request for fine location without coarse is
         * ignored, so coarse goes with the shared list.
         */
        fun permissions(sdkInt: Int): List<String> =
            (RadarPermissions.required(sdkInt) + Manifest.permission.ACCESS_COARSE_LOCATION).distinct()

        fun link(connection: RadarConnection): RadarStatus.Link = when (connection) {
            RadarConnection.off -> RadarStatus.Link.OFF
            RadarConnection.scanning -> RadarStatus.Link.SEARCHING
            RadarConnection.connecting -> RadarStatus.Link.CONNECTING
            RadarConnection.connected -> RadarStatus.Link.CONNECTED
            RadarConnection.bluetoothOff -> RadarStatus.Link.BLUETOOTH_OFF
        }

        fun blocker(phase: RadarPhase): RadarStatus.Blocker? = when (phase) {
            RadarPhase.bluetoothOff -> RadarStatus.Blocker.BLUETOOTH_OFF
            RadarPhase.locationOff -> RadarStatus.Blocker.LOCATION_OFF
            RadarPhase.permission -> RadarStatus.Blocker.PERMISSION
            else -> null
        }
    }
}
