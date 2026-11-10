package app.teamstation.streamcore.gl

import android.opengl.Matrix
import app.teamstation.streamcore.core.FocusPoint

/** Preallocated frame snapshots; matrix inversion and temporary allocations happen only on a tap. */
internal class FocusTransform {
    private val lock = Any()
    private val texture = FloatArray(16)
    private var scaleX = 1f
    private var scaleY = 1f
    private var rotation = 0
    private var zoom = 1f
    private var mirrored = false
    private var ready = false

    fun update(texture: FloatArray, scaleX: Float, scaleY: Float, rotation: Int, zoom: Float, mirrored: Boolean) = synchronized(lock) {
        texture.copyInto(this.texture)
        this.scaleX = scaleX
        this.scaleY = scaleY
        this.rotation = rotation
        this.zoom = zoom
        this.mirrored = mirrored
        ready = true
    }

    fun point(point: FocusPoint): FocusPoint? {
        val texture = FloatArray(16)
        val mvp = FloatArray(16)
        synchronized(lock) {
            if (!ready) return null
            this.texture.copyInto(texture)
            buildCaptureMvp(mvp, scaleX, scaleY, rotation, zoom, mirrored)
        }
        val inverse = FloatArray(16)
        if (!Matrix.invertM(inverse, 0, mvp, 0)) return null
        val vertex = FloatArray(4)
        Matrix.multiplyMV(vertex, 0, inverse, 0,
            floatArrayOf((point.x * 2 - 1).toFloat(), (1 - point.y * 2).toFloat(), 0f, 1f), 0)
        if (vertex[0] !in -1f..1f || vertex[1] !in -1f..1f) return null
        val sensor = FloatArray(4)
        Matrix.multiplyMV(sensor, 0, texture, 0,
            floatArrayOf((vertex[0] + 1) / 2, (vertex[1] + 1) / 2, 0f, 1f), 0)
        return FocusPoint.create(sensor[0].toDouble(), sensor[1].toDouble())
    }
}

/** Identical geometry for drawing and tap inversion; destination mirroring follows rotation. */
internal fun buildCaptureMvp(matrix: FloatArray, scaleX: Float, scaleY: Float,
    rotation: Int, digitalZoom: Float, mirrored: Boolean) {
    Matrix.setIdentityM(matrix, 0)
    val zoom = digitalZoom.takeIf { it.isFinite() && it > 1f } ?: 1f
    Matrix.scaleM(matrix, 0, (if (mirrored) -scaleX else scaleX) * zoom, scaleY * zoom, 1f)
    if (rotation != 0) Matrix.rotateM(matrix, 0, rotation.toFloat(), 0f, 0f, 1f)
}
