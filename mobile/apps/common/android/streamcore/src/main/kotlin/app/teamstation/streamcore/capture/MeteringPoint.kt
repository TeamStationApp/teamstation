package app.teamstation.streamcore.capture

import app.teamstation.streamcore.core.FocusPoint
import kotlin.math.max
import kotlin.math.min

/** Camera-buffer coordinates mapped through the buffer's crop of the sensor active array. */
internal fun meteringPoint(
    point: FocusPoint, bufferWidth: Int, bufferHeight: Int, sensorWidth: Int, sensorHeight: Int
): FocusPoint? {
    if (minOf(bufferWidth, bufferHeight, sensorWidth, sensorHeight) <= 0) return null
    val imageAspect = max(bufferWidth, bufferHeight).toDouble() / min(bufferWidth, bufferHeight)
    val sensorAspect = sensorWidth.toDouble() / sensorHeight
    return FocusPoint.create(
        0.5 + (point.x - 0.5) * min(1.0, imageAspect / sensorAspect),
        0.5 + (point.y - 0.5) * min(1.0, sensorAspect / imageAspect)
    )
}
