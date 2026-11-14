package app.teamstation.streamcore.capture

import android.graphics.Rect
import android.hardware.camera2.params.MeteringRectangle
import app.teamstation.streamcore.core.FocusPoint
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** AF regions are relative to the active array's origin, not the full pixel array's origin. */
internal fun focusMeteringRegion(point: FocusPoint, bufferWidth: Int, bufferHeight: Int, activeArray: Rect): MeteringRectangle? {
    val width = activeArray.width()
    val height = activeArray.height()
    if (min(width, height) < 3) return null
    val mapped = meteringPoint(point, bufferWidth, bufferHeight, width, height) ?: return null
    val radius = max(1, min(width, height) / 40)
    val x = (width * mapped.x).roundToInt().coerceIn(radius, width - 1 - radius)
    val y = (height * mapped.y).roundToInt().coerceIn(radius, height - 1 - radius)
    return MeteringRectangle(Rect(x - radius, y - radius, x + radius, y + radius), MeteringRectangle.METERING_WEIGHT_MAX)
}
