package app.teamstation.cameraman.harness

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.Rect
import android.view.Surface
import app.teamstation.cameraman.core.StreamSettings
import kotlin.math.roundToLong

/**
 * Frames from a pattern generator instead of a lens, so the encode-and-serve path is exercisable
 * with no camera and no camera permission.
 *
 * It earns less of its keep here than on iOS, where the simulator has no capture device at all and
 * this is the only way to test anything past `AVCaptureSession`. An Android emulator ships a fake
 * camera, so this is for the narrower case: a handset where the camera permission was refused, or a
 * bring-up where the question is whether the encoder and the RTSP server work at all before the
 * camera is brought into it.
 *
 * Drawn with filled rectangles rather than per-pixel: a loop over 1080p is two million bounds-checked
 * writes a frame, which delivers about two frames a second and looks exactly like the encoder failing.
 *
 * There is no synthetic microphone: audio has nothing device-specific in its path that the AAC unit
 * tests do not already cover.
 */
class SyntheticCamera(
    private val surface: Surface,
    private val configuration: Configuration
) {
    data class Configuration(
        val width: Int,
        val height: Int,
        val frameRate: Double
    ) {
        constructor(settings: StreamSettings) : this(
            settings.width,
            settings.height,
            settings.frameRate
        )
    }

    private var thread: Thread? = null

    @Volatile
    private var running = false

    var onFrame: (() -> Unit)? = null

    fun start() {
        stop()
        running = true
        val frameNanos = (1_000_000_000.0 / configuration.frameRate).roundToLong()
        thread = Thread({
            var index = 0L
            val paint = Paint()
            while (running) {
                val started = System.nanoTime()
                val canvas = runCatching { surface.lockCanvas(null) }.getOrNull()
                if (canvas != null) {
                    draw(canvas, paint, index)
                    runCatching { surface.unlockCanvasAndPost(canvas) }
                    onFrame?.invoke()
                }
                index += 1
                val elapsed = System.nanoTime() - started
                val remaining = frameNanos - elapsed
                if (remaining > 0) {
                    val millis = remaining / 1_000_000
                    runCatching { Thread.sleep(millis, (remaining % 1_000_000).toInt()) }
                }
            }
        }, "cameraman-synthetic").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        running = false
        thread?.join(500)
        thread = null
    }

    private fun draw(canvas: Canvas, paint: Paint, index: Long) {
        val width = canvas.width
        val height = canvas.height
        canvas.drawColor(Color.BLACK, PorterDuff.Mode.SRC)

        // Colour bars, so a decoded frame is obviously this and not a real camera.
        val bars = intArrayOf(
            Color.WHITE, Color.YELLOW, Color.CYAN, Color.GREEN,
            Color.MAGENTA, Color.RED, Color.BLUE
        )
        val barWidth = width / bars.size
        for ((column, colour) in bars.withIndex()) {
            paint.color = colour
            canvas.drawRect(
                Rect(column * barWidth, 0, (column + 1) * barWidth, height * 3 / 4),
                paint
            )
        }

        // A block that moves one step per frame, so a receiver can tell a live stream from a frozen
        // one without decoding timestamps.
        val blockSize = height / 8
        val travel = width - blockSize
        val position = if (travel > 0) ((index * 8) % travel).toInt() else 0
        paint.color = Color.WHITE
        canvas.drawRect(
            Rect(position, height - blockSize, position + blockSize, height),
            paint
        )
    }
}
