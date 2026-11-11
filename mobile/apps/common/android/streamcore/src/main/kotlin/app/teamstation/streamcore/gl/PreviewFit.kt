package app.teamstation.streamcore.gl

import kotlin.math.roundToInt

/** Fits the encoded frame, independent of the sensor texture's rotation or crop. */
internal fun encodedFrameFit(width: Int, height: Int, imageWidth: Int, imageHeight: Int): Pair<Float, Float> {
    if (width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0) return 1f to 1f
    val ratio = (width.toFloat() / height) / (imageWidth.toFloat() / imageHeight)
    return if (ratio > 1f) (1f / ratio) to 1f else 1f to ratio
}

/**
 * The picture's rectangle inside the preview, in GL window coordinates (origin at the bottom left).
 *
 * [scaleX] and [scaleY] are the unzoomed aspect-fit factors: each is the fraction of that axis the
 * picture occupies. Software zoom draws the quad larger than this and the scissor throws the
 * overflow away, so the crop stays inside the frame that is broadcast and the bars stay empty.
 */
internal data class FittedFrame(
    val x: Int,
    val y: Int,
    val width: Int,
    val height: Int
)

internal fun fittedFrame(
    destinationWidth: Int,
    destinationHeight: Int,
    scaleX: Float,
    scaleY: Float
): FittedFrame {
    val width = (destinationWidth * scaleX).roundToInt().coerceIn(1, destinationWidth)
    val height = (destinationHeight * scaleY).roundToInt().coerceIn(1, destinationHeight)
    return FittedFrame(
        x = (destinationWidth - width) / 2,
        y = (destinationHeight - height) / 2,
        width = width,
        height = height
    )
}
