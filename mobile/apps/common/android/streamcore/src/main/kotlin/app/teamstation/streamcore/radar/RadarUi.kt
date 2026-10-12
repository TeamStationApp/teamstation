package app.teamstation.streamcore.radar

import org.json.JSONObject

enum class RadarPhase {
    idle,
    bluetoothOff,
    locationOff,
    permission,
    connecting,
    connected
}

data class RadarUiState(
    val serial: String? = null,
    val phase: RadarPhase = RadarPhase.idle,
    val board: SpeedBoard = SpeedBoard(),
    val linkSuppressed: Boolean = false,
    val connectingStep: Int = 0,
    val pickerOpen: Boolean = false,
    val pickerNames: List<String> = emptyList(),
    val statusText: String? = null,
    val enabled: Boolean = true,
    val batteryPercent: Int? = null
) {
    val speedsText: String?
        get() = if (phase == RadarPhase.connected) board.visible() else null

    /** Lightning bolt, charge, a space, then the pitch/exit pair. Speeds alone until the first battery byte. */
    val readoutText: String?
        get() {
            val speeds = speedsText ?: return null
            val battery = batteryPercent ?: return speeds
            return "⚡$battery% $speeds"
        }

    val showsPair: Boolean get() = serial == null
}

object RadarSnapshot {
    fun putInto(json: JSONObject, state: RadarUiState) {
        json.put("radarSerial", state.serial ?: JSONObject.NULL)
        json.put("radarPhase", state.phase.name)
        json.put("radarSpeeds", state.readoutText ?: JSONObject.NULL)
        json.put("radarBattery", state.batteryPercent ?: JSONObject.NULL)
        json.put("radarEnabled", state.enabled)
        json.put("radarLinkSuppressed", state.linkSuppressed)
    }
}

sealed class RadarCommand {
    data class Show(val serial: String, val phase: RadarPhase, val step: Int) : RadarCommand()
    data class Feed(val pitch: Int, val exit: Int, val now: Long) : RadarCommand()
    data object Unpair : RadarCommand()
}

object RadarControl {
    fun parse(action: String, query: Map<String, String>): RadarCommand? = when (action) {
        "radar-unpair" -> RadarCommand.Unpair
        "radar-feed" -> {
            val pitch = query["pitch"]?.toIntOrNull() ?: return null
            val exit = query["exit"]?.toIntOrNull() ?: return null
            val now = query["now"]?.toLongOrNull() ?: return null
            RadarCommand.Feed(pitch, exit, now)
        }
        "radar-show" -> {
            val serial = RadarPairingRecord.serialFrom(query["serial"]) ?: return null
            val phase = when (query["phase"]) {
                "connecting" -> RadarPhase.connecting
                "connected" -> RadarPhase.connected
                "idle" -> RadarPhase.idle
                "bluetoothOff" -> RadarPhase.bluetoothOff
                "locationOff" -> RadarPhase.locationOff
                "permission" -> RadarPhase.permission
                else -> return null
            }
            val step = query["step"]?.toIntOrNull() ?: 0
            RadarCommand.Show(serial, phase, step)
        }
        else -> null
    }
}
