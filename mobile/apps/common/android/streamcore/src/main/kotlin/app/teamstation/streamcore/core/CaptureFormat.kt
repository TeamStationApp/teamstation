package app.teamstation.streamcore.core

import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.roundToInt
import kotlin.math.tan

/**
 * One capture format, reduced to the facts that decide whether it is usable.
 *
 * A plain value type rather than a `CameraCharacteristics` stream configuration so the selection
 * rules can be tested without a camera, which matters because a JVM unit test has none.
 */
data class CaptureFormatDescriptor(
    val width: Int,
    val height: Int,
    val minimumFrameRate: Double,
    val maximumFrameRate: Double,
    /**
     * False when selecting this format collapses the logical device to a single lens. On Android
     * the high-speed (slow-motion) configurations are the ones that do this, and losing lens
     * switching silently would remove the app's headline feature.
     */
    val supportsMultiLensSwitching: Boolean,
    val isBinned: Boolean = false
) {
    val pixelCount: Int get() = width * height
    val label: String get() = "${width}x$height@${maximumFrameRate.toInt()}"

    fun supports(frameRate: Double): Boolean =
        frameRate >= minimumFrameRate - 0.01 && frameRate <= maximumFrameRate + 0.01
}

/**
 * 35 mm-equivalent focal length from a measured field of view.
 *
 * Blackmagic's 13 / 24 / 48 / 77 mm labels are this conversion, not a per-model table. Full-frame
 * width is 36 mm, so `f = 18 / tan(fov/2)`.
 */
object LensOptics {
    fun equivalentFocalLengthMM(horizontalFieldOfViewDegrees: Double): Int? {
        if (!horizontalFieldOfViewDegrees.isFinite() ||
            horizontalFieldOfViewDegrees <= 1 ||
            horizontalFieldOfViewDegrees >= 179
        ) {
            return null
        }
        val radians = horizontalFieldOfViewDegrees * Math.PI / 180
        val millimetres = 18 / tan(radians / 2)
        if (!millimetres.isFinite() || millimetres <= 0 || millimetres >= 500) return null
        return millimetres.roundToInt()
    }

    /**
     * The horizontal field of view of a lens, from the two numbers Camera2 publishes about it.
     *
     * iOS hands `videoFieldOfView` over directly; Camera2 gives the focal length and the physical
     * sensor size instead, which is the same statement about the optics one step earlier.
     */
    fun horizontalFieldOfViewDegrees(focalLengthMM: Double, sensorWidthMM: Double): Double? {
        if (!focalLengthMM.isFinite() || !sensorWidthMM.isFinite()) return null
        if (focalLengthMM <= 0 || sensorWidthMM <= 0) return null
        return 2 * atan(sensorWidthMM / (2 * focalLengthMM)) * 180 / Math.PI
    }

    /** True when two zoom ratios name the same lens, within the tolerance the catalogue uses. */
    fun isSameZoom(one: Double, other: Double): Boolean = abs(one - other) < 0.08
}
