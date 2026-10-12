package app.teamstation.streamcore.radar

import android.content.Context

/**
 * [RadarFleetStore] in SharedPreferences: the switch under [enabledKey], and the serials under
 * [serialsKey] joined by commas. One pairing is therefore the plain serial that the single-radar
 * builds wrote, and that they still read.
 */
class PreferencesRadarFleetStore(
    context: Context,
    file: String,
    private val serialsKey: String,
    private val enabledKey: String,
    private val enabledByDefault: Boolean
) : RadarFleetStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(file, Context.MODE_PRIVATE)

    override fun readSerials(): List<String> = serialsFrom(preferences.getString(serialsKey, null))

    override fun writeSerials(serials: List<String>) {
        val editor = preferences.edit()
        if (serials.isEmpty()) editor.remove(serialsKey)
        else editor.putString(serialsKey, serials.joinToString(SEPARATOR) { RadarPairingRecord.stored(it) })
        editor.apply()
    }

    override fun readEnabled(): Boolean = preferences.getBoolean(enabledKey, enabledByDefault)

    override fun writeEnabled(enabled: Boolean) {
        preferences.edit().putBoolean(enabledKey, enabled).apply()
    }

    companion object {
        const val SEPARATOR = ","

        /** TS Cameraman's file and keys from before the fleet. Its radar is on until turned off. */
        const val CAMERAMAN_FILE = "app.teamstation.cameraman.radar"
        const val CAMERAMAN_ENABLED = "enabled"

        fun cameraman(context: Context) = PreferencesRadarFleetStore(
            context,
            CAMERAMAN_FILE,
            serialsKey = RadarPairingRecord.KEY,
            enabledKey = CAMERAMAN_ENABLED,
            enabledByDefault = true
        )

        /** The TAG One names in a stored value, once each, in order. */
        fun serialsFrom(stored: String?): List<String> = stored.orEmpty()
            .split(SEPARATOR)
            .mapNotNull { RadarPairingRecord.serialFrom(it) }
            .distinctBy { it.uppercase() }
    }
}
