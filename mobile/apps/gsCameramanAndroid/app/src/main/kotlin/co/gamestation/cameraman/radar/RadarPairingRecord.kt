package co.gamestation.cameraman.radar

internal object RadarPairingRecord {
    const val KEY = "serial"

    fun serialFrom(stored: String?): String? {
        val trimmed = stored?.trim().orEmpty()
        if (!TAG_NAME.containsMatchIn(trimmed)) return null
        return trimmed
    }

    fun stored(serial: String): String = serial
}
