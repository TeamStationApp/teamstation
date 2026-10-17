package app.teamstation.streamcore.phonestream

import android.os.Build

/**
 * What TeamStation lists this phone as beside its camera angle: `Build.MODEL`, prefixed with
 * `Build.MANUFACTURER` unless the model already starts with it ("Google Pixel 10", "Samsung
 * SM-S921U", but "OnePlus 12" rather than "OnePlus OnePlus 12").
 */
object DeviceModelName {
    val current: String get() = of(Build.MANUFACTURER, Build.MODEL)

    fun of(manufacturer: String?, model: String?): String {
        val maker = manufacturer?.trim().orEmpty().replaceFirstChar { it.uppercase() }
        val name = model?.trim().orEmpty()
        return when {
            name.isEmpty() -> maker.ifEmpty { "Android" }
            maker.isEmpty() || name.startsWith(maker, ignoreCase = true) -> name
            else -> "$maker $name"
        }
    }
}
