package app.teamstation.cameraman.capture

import app.teamstation.cameraman.core.CaptureFormatDescriptor
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
        /**
         * `1080p 60 fps` for a 16:9 size, which is every size the menu offers. Anything else can only
         * arrive by launch argument or the control channel, and is spelled out so that 1440x1080
         * does not pass for 1080p.
         */
        val label: String
            get() = if (width * 9 == height * 16) {
                "${height}p ${frameRate.toInt()} fps"
            } else {
                "${width}x$height @ ${frameRate.toInt()}"
            }

        /**
         * Shown in the settings list so losing lens switching is a visible trade-off rather than a
         * silent one.
         */
        val annotation: String? get() = if (supportsMultiLensSwitching) null else "single lens only"
    }

    /**
     * The offered formats this device can serve, in menu order, each reported as keeping lens
     * switching when any format that serves it does.
     */
    val options: List<Option>
        get() = offeredFormats.mapNotNull { (width, height, frameRate) ->
            val serving = formats.filter {
                it.width == width && it.height == height && it.supports(frameRate)
            }
            if (serving.isEmpty()) return@mapNotNull null
            Option(width, height, frameRate, serving.any { it.supportsMultiLensSwitching })
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
         * The menu, in the order it reads: 16:9 at the two rates a game is shot at, 1080p first.
         *
         * A device advertises dozens of sizes from 176x144 up to 4K and continuous frame-rate
         * ranges to 240, and every combination is a choice the operator has to get right on a
         * sideline. Director composes a 1080p programme, so anything above 1080p is battery and
         * bandwidth spent on detail that is scaled away, anything below 720p is unwatchable in a
         * broadcast, a 4:3 size would be cropped, and a cadence other than 30 or 60 judders in the
         * mix. Only these four are offered; a device that lacks one simply has a shorter menu.
         */
        val offeredFormats: List<Triple<Int, Int, Double>> = listOf(
            Triple(1920, 1080, 60.0),
            Triple(1920, 1080, 30.0),
            Triple(1280, 720, 60.0),
            Triple(1280, 720, 30.0)
        )
    }
}
