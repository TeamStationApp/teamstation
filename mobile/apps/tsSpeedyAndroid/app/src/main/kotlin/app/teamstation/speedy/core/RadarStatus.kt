package app.teamstation.speedy.core

/** The paired radar's link as Settings describes it. */
data class RadarStatus(
    val serial: String? = null,
    val link: Link? = null,
    val blocker: Blocker? = null,
    val batteryPercent: Int? = null,
    /** While pairing: the unpaired radars in range. */
    val nearby: List<String> = emptyList(),
    val pairing: Boolean = false
) {
    enum class Link { OFF, SEARCHING, CONNECTING, CONNECTED, BLUETOOTH_OFF }

    /** What stops the radar before any link: Bluetooth off, Location off, or no permission. */
    enum class Blocker { BLUETOOTH_OFF, LOCATION_OFF, PERMISSION }

    val isPaired: Boolean get() = serial != null

    /** The status line: what blocks the radar first, then whether one is paired, then its link. */
    val text: String
        get() = when (blocker) {
            Blocker.BLUETOOTH_OFF -> "Bluetooth off"
            Blocker.LOCATION_OFF -> "Turn on Location"
            Blocker.PERMISSION -> "Allow Bluetooth"
            null -> when (if (serial == null) null else link) {
                null -> "No radar paired"
                Link.OFF -> "Off"
                Link.SEARCHING -> "Searching"
                Link.CONNECTING -> "Connecting"
                Link.CONNECTED -> "Connected"
                Link.BLUETOOTH_OFF -> "Bluetooth off"
            }
        }
}
