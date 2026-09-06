package co.gamestation.cameraman.core

/**
 * The thermal state as the overlay pill shows it.
 *
 * Deliberately *not* the state dump's `nominal` / `fair` / `serious` / `critical` names: those are
 * the platform's words and belong in telemetry, and these are the operator's. Copied from the iOS
 * build, which took them from GS Director, so all three show the same Cool / Fair / Warm / Hot
 * chrome and an operator reading a bench of mixed handsets sees one vocabulary.
 *
 * Pure, so the colour and the wording are unit-tested with no Android in the process.
 */
enum class ThermalBadgeLevel(val rawValue: String) {
    COOL("cool"),
    FAIR("fair"),
    WARM("warm"),
    HOT("hot");

    enum class Shimmer { PULSE, UP }

    /** RECORD/STREAM-style caps. The accessibility value stays the lowercase [rawValue]. */
    val label: String get() = rawValue.uppercase()

    val showsFlames: Boolean get() = this == HOT

    val shimmer: Shimmer
        get() = when (this) {
            COOL, FAIR, WARM -> Shimmer.PULSE
            HOT -> Shimmer.UP
        }

    /** Seconds for one cycle: the fill pulse, or enter-to-exit travel for hot. */
    val cycleSeconds: Double
        get() = when (this) {
            COOL, FAIR -> 3.0
            WARM -> 2.0
            HOT -> 1.0
        }

    val hue: Hue
        get() = when (this) {
            COOL -> Hue(0.18, 0.48, 0.95)
            FAIR -> Hue(0.98, 0.84, 0.18)
            WARM -> Hue(0.98, 0.52, 0.12)
            HOT -> Hue(0.95, 0.24, 0.28)
        }

    /**
     * A colour as components rather than as a platform colour.
     *
     * The pure packages have no Compose dependency — that is what lets them be tested on the JVM —
     * so a colour crosses that boundary as three numbers and the UI makes it drawable.
     */
    data class Hue(val red: Double, val green: Double, val blue: Double)

    companion object {
        /**
         * From the state dump's word, so the pill and the telemetry can never disagree about what
         * the phone is doing. Anything unrecognised reads as cool, because a badge that vanishes on
         * an unexpected value is worse than one that under-reports.
         */
        fun fromTelemetryName(name: String): ThermalBadgeLevel = when (name) {
            "fair" -> FAIR
            "serious" -> WARM
            "critical" -> HOT
            else -> COOL
        }

        /**
         * From `PowerManager.getCurrentThermalStatus`, via the same collapse [ProcessLoad] applies.
         *
         * Android has seven levels to iOS's four. Going through the telemetry name rather than
         * mapping the seven directly means there is exactly one place the collapse happens, so the
         * pill and the dump cannot drift apart.
         */
        fun fromThermalStatus(status: Int): ThermalBadgeLevel =
            fromTelemetryName(ProcessLoad.thermalStateName(status))
    }
}
