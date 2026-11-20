package app.teamstation.speedy.core

import android.content.SharedPreferences

/** Whether TS Speedy speaks. On until the operator turns it off, and remembered across launches. */
class AudioSetting(private val preferences: SharedPreferences) {
    var isOn: Boolean
        get() = preferences.getBoolean(KEY, true)
        set(value) {
            preferences.edit().putBoolean(KEY, value).apply()
        }

    companion object {
        const val FILE = "app.teamstation.speedy"
        const val KEY = "app.teamstation.speedy.audio"
    }
}
