package co.gamestation.cameraman.capture

import co.gamestation.cameraman.core.CaptureFormatDescriptor
import kotlin.math.abs

/**
 * Turns the device's raw format list into the short menu an operator should see, and picks the
 * nearest usable format for a requested resolution and frame rate.
 *
 * Operates on [CaptureFormatDescriptor] rather than on `CameraCharacteristics` so all of this is
 * testable with no camera present, which is the only way it can be tested on the JVM.
 */
data class FormatCatalogue(val formats: List<CaptureFormatDescriptor>) {

    data class Option(
        val width: Int,
        val height: Int,
        val frameRate: Double,
        val supportsMultiLensSwitching: Boolean
    ) {
        val label: String get() = "${width}x$height @ ${frameRate.toInt()}"

        /**
         * Shown in the settings list so losing lens switching is a visible trade-off rather than a
         * silent one.
         */
        val annotation: String? get() = if (supportsMultiLensSwitching) null else "single lens only"
    }

    /**
     * One entry per resolution and frame rate, keeping the variant that preserves lens switching
     * when the device offers both.
     */
    val options: List<Option>
        get() {
            val best = LinkedHashMap<Option, Boolean>()
            for (format in formats) {
                for (rate in candidateFrameRates) {
                    if (!format.supports(rate)) continue
                    val key = Option(format.width, format.height, rate, false)
                    best[key] = (best[key] ?: false) || format.supportsMultiLensSwitching
                }
            }
            return best
                .map { (key, switching) ->
                    Option(key.width, key.height, key.frameRate, switching)
                }
                .sortedWith(
                    compareBy({ it.width * it.height }, { it.frameRate })
                )
        }

    /**
     * The nearest usable format for a request.
     *
     * Preference order is deliberate: exact dimensions first, then a format that keeps lens
     * switching, then the tightest frame-rate range that still contains the request. Preferring the
     * tightest range matters because a 240 fps format run at 30 wastes power and often drops
     * switching, while the 30 fps format does neither.
     */
    fun selection(width: Int, height: Int, frameRate: Double): CaptureFormatDescriptor? {
        if (formats.isEmpty()) return null

        val comparator = Comparator<CaptureFormatDescriptor> { left, right ->
            val leftExact = left.width == width && left.height == height
            val rightExact = right.width == width && right.height == height
            if (leftExact != rightExact) return@Comparator if (leftExact) -1 else 1

            val leftRate = left.supports(frameRate)
            val rightRate = right.supports(frameRate)
            if (leftRate != rightRate) return@Comparator if (leftRate) -1 else 1

            if (left.supportsMultiLensSwitching != right.supportsMultiLensSwitching) {
                return@Comparator if (left.supportsMultiLensSwitching) -1 else 1
            }

            val leftDistance = abs(left.pixelCount - width * height)
            val rightDistance = abs(right.pixelCount - width * height)
            if (leftDistance != rightDistance) return@Comparator leftDistance.compareTo(rightDistance)

            left.maximumFrameRate.compareTo(right.maximumFrameRate)
        }
        return formats.sortedWith(comparator).firstOrNull()
    }

    /** 1080p30 keeping lens switching, which is the documented default. */
    val defaultSelection: CaptureFormatDescriptor? get() = selection(1920, 1080, 30.0)

    /** The highest resolution and frame rate the device offers, whether or not it keeps switching. */
    val maximumSelection: CaptureFormatDescriptor?
        get() = formats.maxWithOrNull(
            compareBy({ it.pixelCount }, { it.maximumFrameRate })
        )

    companion object {
        /**
         * The frame rates worth offering. A device advertises continuous ranges, so without a
         * curated list the menu would contain every integer from 1 to 240.
         */
        val candidateFrameRates = listOf(24.0, 25.0, 30.0, 50.0, 60.0, 120.0, 240.0)
    }
}
