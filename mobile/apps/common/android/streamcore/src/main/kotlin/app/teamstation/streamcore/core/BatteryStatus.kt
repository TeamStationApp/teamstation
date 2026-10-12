package app.teamstation.streamcore.core

/**
 * The phone's battery, as the overlay pill and the state dump show it.
 *
 * Pure so the colour threshold is unit-tested with no Android in the process, and so a remote client
 * decoding the dump arrives at the same value the phone draws.
 */
data class BatteryStatus(
    /** 0…100. */
    val percent: Int,
    val isCharging: Boolean = false
) {
    init {
        require(percent in 0..100) { "percent must already be clamped" }
    }

    val isLow: Boolean get() = percent < lowThresholdPercent

    val label: String get() = "$percent%"

    /** Green, or the low-power yellow once it dips under the threshold. */
    val hue: ThermalBadgeLevel.Hue
        get() = if (isLow) {
            ThermalBadgeLevel.Hue(0.85, 0.66, 0.08)
        } else {
            ThermalBadgeLevel.Hue(0.20, 0.78, 0.35)
        }

    companion object {
        /** Below this the pill turns the dark yellow a phone uses for its own low-power warning. */
        const val lowThresholdPercent = 20

        fun of(percent: Int, isCharging: Boolean = false): BatteryStatus =
            BatteryStatus(percent.coerceIn(0, 100), isCharging)

        /**
         * From a 0…1 level, which is what both platforms report. Returns null when the level is
         * unknown — an emulator has no battery, and drawing 0 % on one would look like a phone about
         * to die.
         */
        fun fromLevel(level: Double, isCharging: Boolean): BatteryStatus? {
            if (!level.isFinite() || level < 0) return null
            return of(Math.round(level * 100).toInt(), isCharging)
        }

        /**
         * From `ACTION_BATTERY_CHANGED`'s raw level and scale. The scale is not always 100 — it is
         * whatever the device reports — so dividing by it rather than assuming is the difference
         * between a percentage and a number that happens to look like one.
         */
        fun fromLevelAndScale(level: Int, scale: Int, isCharging: Boolean): BatteryStatus? {
            if (level < 0 || scale <= 0) return null
            return fromLevel(level.toDouble() / scale.toDouble(), isCharging)
        }
    }
}
