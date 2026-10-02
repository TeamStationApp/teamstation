package app.teamstation.cameraman.radar

internal enum class GattState { Down, Connecting, Up }

internal enum class LinkAction { Idle, ScanPicker, ScanSerial, Hold }

internal data class LinkDecision(
    val action: LinkAction,
    val status: String?
)

internal object LinkPolicy {
    const val BLUETOOTH_OFF = "Bluetooth is off"
    const val LOCATION_OFF = "Location is off"
    const val PERMISSION = "Bluetooth permission is required"
    const val OFF = "Off"

    fun action(
        serial: String?,
        bluetoothOn: Boolean,
        locationOn: Boolean,
        permissionsGranted: Boolean,
        pickerOpen: Boolean,
        gatt: GattState,
        suppressed: Boolean,
        enabled: Boolean = true
    ): LinkDecision {
        if (suppressed) return LinkDecision(LinkAction.Idle, null)
        if (!enabled) return LinkDecision(LinkAction.Idle, OFF)
        if (!bluetoothOn) return LinkDecision(LinkAction.Idle, BLUETOOTH_OFF)
        if (!locationOn) return LinkDecision(LinkAction.Idle, LOCATION_OFF)
        if (!permissionsGranted) return LinkDecision(LinkAction.Idle, PERMISSION)
        if (gatt == GattState.Connecting) return LinkDecision(LinkAction.Hold, null)
        if (gatt == GattState.Up) return LinkDecision(LinkAction.Hold, null)
        if (serial == null) {
            return if (pickerOpen) {
                LinkDecision(LinkAction.ScanPicker, null)
            } else {
                LinkDecision(LinkAction.Idle, null)
            }
        }
        return LinkDecision(LinkAction.ScanSerial, null)
    }

    /** Delays after a drop: 1s, 2s, 4s, then 8s. [dropsSinceLive] is 1 for the first drop. */
    fun reconnectDelayMs(dropsSinceLive: Int): Long {
        val shift = (dropsSinceLive - 1).coerceAtLeast(0).coerceAtMost(3)
        return 1_000L shl shift
    }

    fun acceptsScanResult(savedSerial: String?, name: String?): Boolean {
        if (savedSerial == null || name == null) return false
        return name.equals(savedSerial, ignoreCase = true)
    }
}
