package co.gamestation.cameraman.radar

import android.content.Context

internal class PreferencesRadarPairingStore(context: Context) : RadarPairingStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(FILE, Context.MODE_PRIVATE)

    override fun read(): String? = RadarPairingRecord.serialFrom(
        preferences.getString(RadarPairingRecord.KEY, null)
    )

    override fun write(serial: String?) {
        val editor = preferences.edit()
        if (serial == null) editor.remove(RadarPairingRecord.KEY)
        else editor.putString(RadarPairingRecord.KEY, RadarPairingRecord.stored(serial))
        editor.apply()
    }

    override fun readEnabled(): Boolean = preferences.getBoolean(ENABLED, true)

    override fun writeEnabled(enabled: Boolean) {
        preferences.edit().putBoolean(ENABLED, enabled).apply()
    }

    companion object {
        const val FILE = "co.gamestation.cameraman.radar"
        const val ENABLED = "enabled"
    }
}
