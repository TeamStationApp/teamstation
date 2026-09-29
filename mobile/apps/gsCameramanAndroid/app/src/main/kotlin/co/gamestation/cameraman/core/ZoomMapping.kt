package co.gamestation.cameraman.core

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Conversions between the two zoom scales a logical multi-lens camera exposes.
 *
 * These are separated from any capture code on purpose, because conflating them is *the* classic
 * bug in this feature. The wrinkle is not the same one iOS has, and that difference is the whole
 * reason [displayMultiplier] survives the port rather than being deleted as an Apple-ism:
 *
 * - On iOS `AVCaptureDevice.videoZoomFactor` is `1.0` at the **widest constituent**, so on a triple
 *   camera device zoom `1.0` reads as `0.5x` and `displayVideoZoomFactorMultiplier` is `0.5`.
 * - On Android `CONTROL_ZOOM_RATIO` is already in the units the operator reads: the ultra-wide is
 *   `0.5` and the main lens is `1.0`, and `CONTROL_ZOOM_RATIO_RANGE` starts below one to say so.
 *
 * So Android sets the multiplier to `1.0` and the two scales coincide. Keeping the conversion means
 * every call site is still explicit about which scale it is in, and the arithmetic and its tests are
 * the iOS build's rather than a second implementation that agrees by luck.
 */
class ZoomMapping(
    minimumDeviceZoom: Double = 1.0,
    maximumDeviceZoom: Double,
    displayMultiplier: Double = 1.0,
    switchOverDeviceZooms: List<Double> = emptyList(),
    softwareZoomStartDeviceZoom: Double? = null
) {
    val minimumDeviceZoom: Double
    val maximumDeviceZoom: Double

    /** 1.0 on Android, where `CONTROL_ZOOM_RATIO` is already the number an operator reads. */
    val displayMultiplier: Double

    /**
     * Device-zoom values at which the logical device hands over to the next physical lens. Android
     * publishes no equivalent of `virtualDeviceSwitchOverVideoZoomFactors`, so `CameraSession`
     * derives these from the constituent physical cameras' focal lengths — see that file for why
     * that is a reading of the hardware rather than a guess.
     */
    val switchOverDeviceZooms: List<Double>

    /**
     * Device zoom where the camera's own range ends and Cameraman's software zoom begins: above it
     * the camera stays at this ratio and the renderer crops the rest. Everything past it is drawn in
     * yellow. Null when there is no software range.
     */
    val softwareZoomStartDeviceZoom: Double?

    init {
        val minimum = if (minimumDeviceZoom > 0) minimumDeviceZoom else 1.0
        val maximum = max(maximumDeviceZoom, minimum)
        this.minimumDeviceZoom = minimum
        this.maximumDeviceZoom = maximum
        this.displayMultiplier = if (displayMultiplier > 0) displayMultiplier else 1.0
        // A switchover at or below the minimum is unreachable, and one above the maximum can never
        // be crossed; either would produce a preset pill that does nothing when tapped.
        this.switchOverDeviceZooms = switchOverDeviceZooms
            .filter { it > minimum && it <= maximum }
            .sorted()
        // At the minimum is allowed: a camera with no zoom of its own is software from end to end.
        this.softwareZoomStartDeviceZoom = softwareZoomStartDeviceZoom
            ?.takeIf { it >= minimum && it < maximum }
    }

    /** The camera's ceiling in displayed units, where the software range starts. */
    val softwareZoomStartDisplayedZoom: Double?
        get() = softwareZoomStartDeviceZoom?.let { displayedZoom(it) }

    /**
     * This mapping with a software range of [softwareZoomExtension] on top of its ceiling, or itself
     * when it already has one: 20x becomes 40x on a Pixel, and a range clamped below a lens that is
     * switched off still zooms past it, in software, on the lens that is on.
     */
    fun extendedBySoftwareZoom(): ZoomMapping {
        if (softwareZoomStartDeviceZoom != null) return this
        return ZoomMapping(
            minimumDeviceZoom = minimumDeviceZoom,
            maximumDeviceZoom = maximumDeviceZoom * softwareZoomExtension,
            displayMultiplier = displayMultiplier,
            switchOverDeviceZooms = switchOverDeviceZooms,
            softwareZoomStartDeviceZoom = maximumDeviceZoom
        )
    }

    /**
     * The optical stops in displayed units: the widest lens and each lens switchover. Everything
     * past the last of them is digital, whether the camera or Cameraman does the cropping.
     */
    val opticalDisplayedZooms: List<Double>
        get() = (listOf(minimumDeviceZoom) + switchOverDeviceZooms).map { displayedZoom(it) }

    /**
     * True past the longest lens: the camera's own digital zoom and Cameraman's software zoom both.
     * What the rail draws in yellow, so an operator can see which stops are the lenses.
     */
    fun isDigitalZoom(displayedZoom: Double): Boolean {
        val longest = opticalDisplayedZooms.lastOrNull() ?: return false
        return label(displayedZoom) != label(longest) && displayedZoom > longest
    }

    /** True for a scale segment that starts at or past the longest lens. */
    fun isDigitalSegment(segment: Int): Boolean {
        val presets = presetDisplayedZooms
        if (segment < 0 || segment + 1 >= presets.size) return false
        return isDigitalZoom(presets[segment + 1])
    }

    /** True above the camera's own ceiling, where only Cameraman's software zoom reaches. */
    fun isSoftwareZoom(displayedZoom: Double): Boolean {
        val start = softwareZoomStartDisplayedZoom ?: return false
        return label(displayedZoom) != label(start) && displayedZoom > start
    }

    /** True for the scale segment that runs from the camera's ceiling to the software maximum. */
    fun isSoftwareSegment(segment: Int): Boolean {
        val presets = presetDisplayedZooms
        if (softwareZoomStartDeviceZoom == null || segment < 0 || segment + 1 >= presets.size) return false
        return isSoftwareZoom(presets[segment + 1]) && !isSoftwareZoom(presets[segment])
    }

    /**
     * How a device zoom is reached: the ratio the camera is asked for, and the crop the renderer
     * applies on top (1 inside the camera's own range).
     */
    fun cameraAndSoftwareZoom(deviceZoom: Double): Pair<Double, Double> {
        val clamped = clampDeviceZoom(deviceZoom)
        val start = softwareZoomStartDeviceZoom
        if (start == null || clamped <= start) return clamped to 1.0
        return start to clamped / start
    }

    fun displayedZoom(deviceZoom: Double): Double = deviceZoom * displayMultiplier

    fun deviceZoom(displayedZoom: Double): Double = displayedZoom / displayMultiplier

    fun clampDeviceZoom(value: Double): Double {
        if (!value.isFinite()) return minimumDeviceZoom
        return min(max(value, minimumDeviceZoom), maximumDeviceZoom)
    }

    fun clampDisplayedZoom(value: Double): Double =
        displayedZoom(clampDeviceZoom(deviceZoom(value)))

    /** Which physical lens is active: 0 is the widest, incrementing past each switchover. */
    fun lensIndex(deviceZoom: Double): Int = switchOverDeviceZooms.count { deviceZoom >= it }

    /**
     * Preset pills in displayed units: one per lens (the minimum and every lens switchover), then
     * the camera's digital ceiling, then Cameraman's software maximum. The lens pills are the
     * optical stops and nothing else, so an operator aiming to avoid digital zoom can land on one.
     *
     * The far-right mark is the zoom ceiling even when that value is digital rather than a
     * constituent lens. A literal `0.5 / 1 / 2 / 5` is wrong on most handsets and wrong on the
     * front camera of all of them. With a software range, the camera's ceiling is a pill of its own
     * and the software maximum sits above it, so the last segment is exactly the software zoom.
     */
    val presetDisplayedZooms: List<Double>
        get() {
            val marks = opticalDisplayedZooms.toMutableList()
            for (ceiling in listOfNotNull(softwareZoomStartDeviceZoom, maximumDeviceZoom)) {
                val value = displayedZoom(ceiling)
                val last = marks.lastOrNull()
                if (last != null && label(value) == label(last)) continue
                marks.add(value)
            }
            return marks
        }

    /**
     * Pinch is multiplicative against the zoom captured when the gesture began, which is what makes
     * it track the fingers instead of drifting.
     */
    fun pinchedDeviceZoom(start: Double, scale: Double): Double {
        if (scale <= 0 || !scale.isFinite()) return clampDeviceZoom(start)
        return clampDeviceZoom(start * scale)
    }

    /**
     * How far along the drawn scale a displayed zoom sits, 0 at the widest pill and 1 at the
     * tightest.
     *
     * Segments are equal in *screen* space, not in zoom ratio: on a Pixel 0.5x→1x, 1x→5x and
     * 5x→20x each occupy a third of the column. A drag that covers one pill-to-pill gap therefore
     * walks one of those segments, which is the contract for the full-screen scrub.
     */
    fun scaleProgress(displayedZoom: Double): Double {
        val presets = presetDisplayedZooms
        val zoom = clampDisplayedZoom(displayedZoom)
        if (presets.size < 2) return 0.0
        if (zoom <= presets[0]) return 0.0
        val last = presets.size - 1
        if (zoom >= presets[last]) return 1.0
        val segments = last.toDouble()
        for (index in 0 until last) {
            val lo = presets[index]
            val hi = presets[index + 1]
            if (hi <= lo || zoom < lo || zoom > hi) continue
            return (index.toDouble() + (zoom - lo) / (hi - lo)) / segments
        }
        return 1.0
    }

    fun displayedZoomForProgress(progress: Double): Double {
        val presets = presetDisplayedZooms
        val first = presets.firstOrNull() ?: return 1.0
        if (presets.size < 2) return first
        val clamped = min(max(progress, 0.0), 1.0)
        val scaled = clamped * (presets.size - 1).toDouble()
        var index = scaled.toInt()
        if (index >= presets.size - 1) index = presets.size - 2
        val t = scaled - index.toDouble()
        return presets[index] + (presets[index + 1] - presets[index]) * t
    }

    /**
     * Relative scrub along the scale. [draggedPoints] is up-positive; a drag equal to
     * [pointsPerSegment] moves from one pill to the next.
     */
    fun displayedZoomByDragging(
        start: Double,
        draggedPoints: Double,
        pointsPerSegment: Double
    ): Double {
        if (!draggedPoints.isFinite() || pointsPerSegment <= 0 || !pointsPerSegment.isFinite()) {
            return clampDisplayedZoom(start)
        }
        val segments = max(scaleSegmentCount, 1).toDouble()
        val progress = scaleProgress(start) + draggedPoints / (pointsPerSegment * segments)
        return clampDisplayedZoom(displayedZoomForProgress(progress))
    }

    val scaleSegmentCount: Int get() = max(presetDisplayedZooms.size - 1, 0)

    fun scaleHighlight(displayedZoom: Double): ScaleHighlight {
        val zoom = clampDisplayedZoom(displayedZoom)
        val presets = presetDisplayedZooms
        val last = presets.lastOrNull() ?: return ScaleHighlight.Preset(zoom)

        val match = presets.firstOrNull { label(zoom) == label(it) }
        if (match != null) return ScaleHighlight.Preset(match)

        if (scaleSegmentCount <= 0) return ScaleHighlight.Preset(last)

        if (zoom >= last) {
            return ScaleHighlight.Tick(scaleSegmentCount - 1, scaleTicksPerSegment - 1)
        }

        for (segment in 0 until presets.size - 1) {
            val lo = presets[segment]
            val hi = presets[segment + 1]
            if (zoom < lo || zoom >= hi || hi <= lo) continue
            // Work in thousandths so 0.7 − 0.5 does not become 0.199999 and land on the wrong bar.
            val milli = (zoom * 1000).roundToLong()
            val loMilli = (lo * 1000).roundToLong()
            val hiMilli = (hi * 1000).roundToLong()
            val span = hiMilli - loMilli
            if (span <= 0) continue
            var index = ((milli - loMilli) * scaleTicksPerSegment / span).toInt()
            if (index >= scaleTicksPerSegment) index = scaleTicksPerSegment - 1
            if (index < 0) index = 0
            return ScaleHighlight.Tick(segment, index)
        }

        return ScaleHighlight.Preset(last)
    }

    override fun equals(other: Any?): Boolean =
        other is ZoomMapping &&
            other.minimumDeviceZoom == minimumDeviceZoom &&
            other.maximumDeviceZoom == maximumDeviceZoom &&
            other.displayMultiplier == displayMultiplier &&
            other.switchOverDeviceZooms == switchOverDeviceZooms &&
            other.softwareZoomStartDeviceZoom == softwareZoomStartDeviceZoom

    override fun hashCode(): Int {
        var result = minimumDeviceZoom.hashCode()
        result = result * 31 + maximumDeviceZoom.hashCode()
        result = result * 31 + displayMultiplier.hashCode()
        result = result * 31 + switchOverDeviceZooms.hashCode()
        return result * 31 + softwareZoomStartDeviceZoom.hashCode()
    }

    /**
     * Which mark on the zoom scale should light up for a displayed zoom.
     *
     * A preset lights when the rounded label matches that lens (`1.04` still reads `1x`). Anything
     * else lights one of the five bars in the segment that contains it, so a pinch between 1x and 5x
     * is never a row of identical dark marks.
     */
    sealed interface ScaleHighlight {
        data class Preset(val displayedZoom: Double) : ScaleHighlight
        data class Tick(val segment: Int, val index: Int) : ScaleHighlight
    }

    companion object {
        /**
         * Picks the zoom ceiling to expose to the operator.
         *
         * The iOS build has to reject `maxAvailableVideoZoomFactor` — 189 on an iPhone 13 Pro, a
         * displayed 94.5x of almost entirely invented pixels — in favour of
         * `systemRecommendedVideoZoomRange`. Android publishes no recommendation at all: the upper
         * bound of `CONTROL_ZOOM_RATIO_RANGE` is the same kind of digital-upscaling number. So the
         * cap lives here instead — whichever is smaller of what the hardware allows and what is
         * worth putting under a finger.
         *
         * @param recommended a platform recommendation where one exists; null on Android.
         * @param available the hardware ceiling, `CONTROL_ZOOM_RATIO_RANGE.upper`.
         */
        fun resolveMaximumDeviceZoom(recommended: Double?, available: Double): Double {
            if (recommended == null || recommended <= 1) {
                // Single-lens cameras — the front camera on most handsets is one — get the same
                // fallback the iOS build gives them rather than an invented number.
                return min(available, singleLensZoomFallback)
            }
            return min(recommended, available)
        }

        const val singleLensZoomFallback: Double = 5.0

        /**
         * How far past the camera's ceiling Cameraman's software zoom reaches, the same 2x the iOS
         * build gives.
         */
        const val softwareZoomExtension: Double = 2.0

        /**
         * The most digital zoom worth putting on the control for a multi-lens camera, as a multiple
         * of the longest real lens.
         *
         * Handing a Pixel's full range to a pinch makes the useful part of the range a few
         * millimetres of travel, which is the failure the iOS build documents at 189x. Four times
         * past the longest optical lens is where the picture stops being worth sending.
         */
        const val multiLensDigitalHeadroom: Double = 4.0

        /** Formats a displayed zoom the way a camera app does: `0.5x`, `1x`, `5x`, `10x`. */
        fun label(displayedZoom: Double): String {
            val rounded = (displayedZoom * 10).roundToLong() / 10.0
            if (abs(rounded - rounded.roundToLong().toDouble()) < 0.05) {
                return "${rounded.roundToInt()}x"
            }
            return String.format(Locale.US, "%.1fx", rounded)
        }

        /**
         * The zoom rail's labels. Stops at 1x and above are the nearest whole number, so a Pixel's
         * 4.1x and 16.5x read as 4x and 17x. Below 1x the tenth stays, because 0.5x and 0.6x are
         * different lenses.
         */
        fun sliderLabel(displayedZoom: Double): String {
            if (displayedZoom < 1.0) return label(displayedZoom)
            return "${roundHalfUp(displayedZoom)}x"
        }

        /** Nearest integer, halfway cases away from zero, so 16.5 reads as 17. */
        private fun roundHalfUp(value: Double): Int = floor(value + 0.5).toInt()

        /** Tick marks drawn between each pair of lens presets. */
        const val scaleTicksPerSegment = 5
    }
}
