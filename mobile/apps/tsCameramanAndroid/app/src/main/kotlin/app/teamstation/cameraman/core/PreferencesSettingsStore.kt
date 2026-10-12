package app.teamstation.cameraman.core

import android.content.Context
import app.teamstation.streamcore.core.SettingsStore

/**
 * Ordinary preferences, in the app's own file.
 *
 * Deliberately not the same file as the identity: settings are meant to go away with the app, and
 * keeping them apart means a future decision to back one up cannot accidentally take the other.
 */
class PreferencesSettingsStore(
    context: Context,
    fileName: String = "app.teamstation.cameraman.settings"
) : SettingsStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(fileName, Context.MODE_PRIVATE)

    override fun string(key: String): String? = preferences.getString(key, null)

    override fun setString(value: String, key: String) {
        // Applied rather than committed: settings are written on every change and a lost final write
        // costs one preference, where the identity's would cost the camera's name on the field.
        preferences.edit().putString(key, value).apply()
    }

    /** One editor, one apply: the values land together or not at all. */
    override fun setStrings(values: Map<String, String>) {
        val editor = preferences.edit()
        for ((key, value) in values) editor.putString(key, value)
        editor.apply()
    }
}
