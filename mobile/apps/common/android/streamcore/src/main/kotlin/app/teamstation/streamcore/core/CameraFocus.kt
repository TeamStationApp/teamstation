package app.teamstation.streamcore.core

import java.util.UUID
import kotlin.math.max
import kotlin.math.min

/** Top-left coordinates in the encoded image, before receiver-only zoom. */
data class FocusPoint private constructor(val x: Double, val y: Double) {
    companion object {
        fun create(x: Double, y: Double): FocusPoint? =
            if (x.isFinite() && y.isFinite() && x in 0.0..1.0 && y in 0.0..1.0) FocusPoint(x, y) else null
    }
}

enum class FocusPhase(val wire: String, val label: String) {
    AUTO("auto", "Auto Focus"), FOCUSING("focusing", "Focusing"), LOCKED("locked", "Focus locked"),
    FAILED("failed", "Focus failed"), UNSUPPORTED("unsupported", "Focus unavailable"), RESET("reset", "Focus reset")
}

data class CameraFocus(
    val supported: Boolean = false,
    val phase: FocusPhase = FocusPhase.UNSUPPORTED,
    val point: FocusPoint? = null,
    val request: String = "",
    val generation: String = "",
    val rotation: Int = 0,
    val mirrored: Boolean = false
) {
    fun reset(supported: Boolean, generation: String = UUID.randomUUID().toString()) = copy(
        supported = supported, generation = generation,
        phase = if (supported) FocusPhase.RESET else FocusPhase.UNSUPPORTED, point = null, request = ""
    )

    fun begin(command: FocusCommand): CameraFocus {
        if (command.generation != generation || command.token == request) return this
        return copy(request = command.token, point = command.point, phase = when {
            !supported -> FocusPhase.UNSUPPORTED
            command.point == null -> FocusPhase.AUTO
            else -> FocusPhase.FOCUSING
        })
    }

    fun complete(command: FocusCommand, success: Boolean): CameraFocus {
        if (generation != command.generation || request != command.token || phase != FocusPhase.FOCUSING) return this
        return copy(phase = if (success) FocusPhase.LOCKED else FocusPhase.FAILED)
    }
}

data class FocusCommand private constructor(val generation: String, val token: String, val point: FocusPoint?) {
    val text: String get() = point?.let { "point:$generation:$token:${it.x}:${it.y}" } ?: "auto:$generation:$token"

    companion object {
        private val id = Regex("[A-Za-z0-9_-]{1,64}")
        fun create(generation: String, token: String, point: FocusPoint?): FocusCommand? =
            if (id.matches(generation) && id.matches(token)) FocusCommand(generation, token, point) else null

        fun parse(text: String): FocusCommand? {
            val parts = text.split(':')
            if (parts.size != 3 && parts.size != 5) return null
            val point = when {
                parts[0] == "auto" && parts.size == 3 -> null
                parts[0] == "point" && parts.size == 5 -> FocusPoint.create(
                    parts[3].toDoubleOrNull() ?: return null, parts[4].toDoubleOrNull() ?: return null
                ) ?: return null
                else -> return null
            }
            return create(parts[1], parts[2], point)
        }
    }
}

object FocusGeometry {
    fun imagePoint(
        x: Double, y: Double, width: Double, height: Double, imageWidth: Double, imageHeight: Double,
        fill: Boolean = false, mirrored: Boolean = false, receiverZoom: Double = 1.0
    ): FocusPoint? {
        if (!listOf(x, y, width, height, imageWidth, imageHeight, receiverZoom).all { it.isFinite() } ||
            width <= 0 || height <= 0 || imageWidth <= 0 || imageHeight <= 0 || receiverZoom < 1 ||
            x < 0 || y < 0 || x > width || y > height) return null
        val scale = if (fill) max(width / imageWidth, height / imageHeight) else min(width / imageWidth, height / imageHeight)
        val drawnWidth = imageWidth * scale
        val drawnHeight = imageHeight * scale
        val visible = FocusPoint.create((x - (width - drawnWidth) / 2) / drawnWidth, (y - (height - drawnHeight) / 2) / drawnHeight)
            ?: return null
        return FocusPoint.create(0.5 + ((if (mirrored) 1 - visible.x else visible.x) - 0.5) / receiverZoom,
            0.5 + (visible.y - 0.5) / receiverZoom)
    }

    fun unrotated(point: FocusPoint, rotation: Int, mirrored: Boolean): FocusPoint? {
        val x = if (mirrored) 1 - point.x else point.x
        return when (((rotation % 360) + 360) % 360) {
            0 -> FocusPoint.create(x, point.y)
            90 -> FocusPoint.create(point.y, 1 - x)
            180 -> FocusPoint.create(1 - x, 1 - point.y)
            270 -> FocusPoint.create(1 - point.y, x)
            else -> null
        }
    }
}
