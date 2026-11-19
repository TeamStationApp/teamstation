package app.teamstation.speedy.core

/**
 * Where TS Speedy's numbers and line go, for a screen of a given size.
 *
 * The line sits 15% below the vertical center. The pitch is sized so "88" spans 80% of the width,
 * and the exit is three quarters of that size, so its "88" spans 60%. A number with more digits
 * shrinks to fit 90% of the width rather than run off the screen.
 */
data class ReadoutMetrics(
    val lineY: Float,
    val gap: Float,
    val pitchSize: Float,
    val exitSize: Float,
    val maxTextWidth: Float
) {
    /** The size that keeps a number [textWidthAtSize] wide at [size] inside the widest allowed. */
    fun fitted(size: Float, textWidthAtSize: Float): Float =
        if (textWidthAtSize <= maxTextWidth || textWidthAtSize <= 0f) size else size * maxTextWidth / textWidthAtSize

    companion object {
        const val LINE_FRACTION = 0.65f
        const val PITCH_WIDTH_FRACTION = 0.80f
        const val EXIT_SCALE = 0.75f
        const val MAX_TEXT_WIDTH_FRACTION = 0.90f
        const val GAP_FRACTION = 0.03f
        const val REFERENCE = "88"

        /** [unitWidth88] is how wide "88" draws at a font size of 1 in the readout's font. */
        fun of(width: Float, height: Float, unitWidth88: Float): ReadoutMetrics {
            val pitch = pitchSize(unitWidth88, width)
            return ReadoutMetrics(
                lineY = height * LINE_FRACTION,
                gap = height * GAP_FRACTION,
                pitchSize = pitch,
                exitSize = pitch * EXIT_SCALE,
                maxTextWidth = width * MAX_TEXT_WIDTH_FRACTION
            )
        }

        fun pitchSize(unitWidth88: Float, width: Float): Float =
            if (unitWidth88 <= 0f) 0f else width * PITCH_WIDTH_FRACTION / unitWidth88
    }
}
