package co.gamestation.cameraman.core

import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.roundToInt
import kotlin.math.tan

/**
 * One optical camera the handset actually has.
 *
 * IDs and millimetre values are measured from the device, never hardcoded per model. The settings
 * list is this array, one toggle per entry.
 *
 * One field of the iOS type is deliberately absent. `isSecondaryNative` marks a native sensor crop —
 * the 48 mm 2x on a 48 MP wide — read from `secondaryNativeResolutionZoomFactors`, and Camera2
 * publishes no equivalent. Android reports the physical cameras and nothing else, so a Pixel lists
 * three back lenses where a 15 Pro lists four. Inventing a fourth row from a zoom ratio would be a
 * lens that does not exist.
 */
data class CameraLens(
    val id: String,
    val position: CameraPosition,
    /** The physical camera id, which is what Camera2 knows it by. */
    val physicalCameraID: String,
    val focalLengthMM: Int?,
    val displayedZoom: Double,
    val deviceZoom: Double
) {
    /** `13 mm` when the field of view was readable, otherwise the zoom label the operator knows. */
    val title: String
        get() = focalLengthMM?.let { "$it mm" } ?: ZoomMapping.label(displayedZoom)

    val subtitle: String
        get() {
            val side = if (position == CameraPosition.BACK) "Back" else "Front"
            return "$side · ${ZoomMapping.label(displayedZoom)}"
        }

    /** Compact settings row: millimetres plus which camera, so five rows fit a landscape column. */
    val settingsLabel: String
        get() = "$title · ${if (position == CameraPosition.BACK) "Back" else "Front"}"

    val testTag: String
        get() = "settings-lens-${position.rawValue}-${ZoomMapping.label(displayedZoom)}"
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
