package app.teamstation.streamcore.gl

import android.graphics.SurfaceTexture
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import java.util.concurrent.CountDownLatch
import kotlin.math.roundToLong

/**
 * Camera frames in, every attached encoder and the preview out, with the capture rotation applied on
 * the way.
 *
 * The iOS build rotates by setting `videoRotationAngle` on the capture connection and lets
 * AVFoundation do it. Camera2 has no such control: its output is always in sensor orientation, so a
 * phone held in the other landscape sends an upside-down picture and a flip to the front camera
 * sends one upside down relative to the back. Doing the rotation here rather than at the display
 * keeps the promise the iOS build makes — *the operator frames what the client receives* — and it
 * costs nothing, because the frame is already going through the GPU to reach the encoder's surface.
 *
 * Everything runs on one thread, because an EGL context belongs to the thread that made it current.
 */
internal class CaptureRenderer(
    private val width: Int,
    private val height: Int,
    private val onFrameRendered: () -> Unit
) {
    private val thread = HandlerThread("cameraman-render").apply { start() }
    private val handler = Handler(thread.looper)

    private lateinit var egl: EglCore
    private lateinit var program: TextureProgram
    private var textureId = 0
    private var surfaceTexture: SurfaceTexture? = null

    /** The encoders every frame is drawn to, by the key each was attached under. */
    private val encoders = EncoderTargets<Surface, EGLSurface>(
        create = { window ->
            window.takeIf { it.isValid }?.let { runCatching { egl.createWindowSurface(it) }.getOrNull() }
        },
        release = { egl.releaseSurface(it) }
    )
    private var previewSurface: EGLSurface? = null
    /**
     * The window the preview EGL surface is built on, kept so it can be rebuilt.
     *
     * A destination can be lost for a moment — the settings screen replaces the preview, the encoder
     * is reconfigured — and dropping the EGL surface is the right response. Dropping the *window*
     * with it is not: `surfaceChanged` will not fire again for a `SurfaceView` that never went away,
     * so the picture would freeze at the last frame drawn and never come back.
     */
    private var previewWindow: Surface? = null
    private var previewWidth = 0
    private var previewHeight = 0

    private val textureMatrix = FloatArray(16)
    private val mvpMatrix = FloatArray(16)
    private var didLogTransform = false

    /**
     * The rotation to apply, in degrees. See `CameraSession.captureRotation` for how it is chosen.
     *
     * 0 or 180 on a device whose `SurfaceTexture` transform is a plain flip; 90 or 270 on one whose
     * camera folds a quarter turn into that transform, which is a property of the handset and is
     * measured rather than assumed — see [transformTransposes].
     */
    @Volatile
    var rotationDegrees: Int = 0

    /**
     * Whether to flip the picture left-to-right on the way out. True for the front camera.
     *
     * This is the counterpart of the iOS build's `connection.isVideoMirrored = false`. AVFoundation
     * mirrors the front camera by default and the iOS build turns it off; this pipeline mirrors it
     * as a consequence of composing the reflection in the `SurfaceTexture` transform with the
     * capture rotation, and this turns it off. Same reasoning either way: this is a camera pointed
     * at a scene, and the operator should see the same picture Producer gets — a mirrored one would
     * make every number and every jersey on the field read backwards.
     */
    @Volatile
    var mirrorHorizontally: Boolean = false

    /**
     * Blanks what the *encoder* is given, leaving the preview live.
     *
     * The encoder keeps running and keeps producing pictures, so Director sees a continuous video
     * clock and continuous audio rather than a hole it has to read as a missing camera. The operator
     * still sees the scene, which is what makes it obvious the camera is aimed correctly while it is
     * deliberately off air.
     */
    @Volatile
    var blankEncoder: Boolean = false

    /**
     * Cameraman's software zoom past the camera's own ceiling, 1 for none. The quad is drawn this
     * much larger and the overflow falls off the edges of the encoded frame. The preview is clipped
     * to the same fitted rectangle, so the crop stays inside the 16:9 picture and the bars either
     * side stay empty.
     */
    @Volatile
    var digitalZoom: Float = 1f

    /**
     * Fired on the render thread the moment blanking turns on or off.
     *
     * Black P-frames still reference the last live keyframe, so a decoder goes on showing the last
     * picture until an IDR arrives. The transition itself has to ask for one; waiting for the next
     * scheduled keyframe would leave up to a second of stale video on screen.
     */
    var onBlankChanged: (() -> Unit)? = null

    /**
     * Asked, with each frame's capture time in nanoseconds, whether that frame goes to the encoder.
     * A frame it refuses is still consumed and still drawn to the preview; the encoder never sees
     * it, so the stream carries fewer frames at their own capture times. See `FrameDeliveryThrottle`.
     */
    @Volatile
    var deliverToEncoder: (Long) -> Boolean = { true }

    private var wasBlank = false

    /** The programme clock the encoders are drawn on, null to draw them on each camera frame. */
    private var programme: ProgrammeTicker? = null

    /** The sensor timestamp of the picture the texture holds, null before the first. */
    private var latestCapture: Long? = null

    /** One earlier camera picture kept for the programme: its texture, the framebuffer that fills it, and when it was captured. */
    private class HeldPicture(val texture: Int, val framebuffer: Int, var capture: Long? = null, var filledAt: Long = 0)

    /** The pictures the programme's tick chooses among ([ProgrammeTicker.heldPictures]); empty draws the newest. */
    private val held = mutableListOf<HeldPicture>()
    private var heldProgram: TextureProgram? = null
    private var heldWanted: Set<Long> = emptySet()
    private var heldFills = 0L
    private val identity = FloatArray(16).also { Matrix.setIdentityM(it, 0) }
    private var tickStartMillis = 0L
    private var tickCount = 0L
    private val programmeTick = Runnable {
        runCatching { drawProgramme() }.onFailure { error ->
            android.util.Log.w("TSCameraman", "PROGRAMME_TICK_DROPPED $error")
        }
        scheduleNextTick()
    }

    /**
     * The surface the camera writes into. Created on the render thread, so this blocks until it
     * exists — a caller that got null here would open the camera with no output at all.
     */
    val cameraSurface: Surface

    init {
        val ready = CountDownLatch(1)
        var created: Surface? = null
        handler.post {
            egl = EglCore()
            egl.makeCurrentWithoutSurface()
            program = TextureProgram()
            textureId = program.createExternalTexture()
            val texture = SurfaceTexture(textureId)
            // The buffer size is the encoded size, not the preview's. The camera then delivers
            // exactly 1920x1080 and no scaling happens on the path to the encoder.
            texture.setDefaultBufferSize(width, height)
            texture.setOnFrameAvailableListener({ onFrameAvailable() }, handler)
            surfaceTexture = texture
            created = Surface(texture)
            ready.countDown()
        }
        ready.await()
        cameraSurface = created!!
    }

    /**
     * Draws every frame to [surface] as well, under [key]; a null surface detaches the key.
     *
     * The key's previous EGL surface is released before the new one is made: `createInputSurface`
     * returns a fresh object after every codec reconfigure, and the EGL surface built on the old one
     * is dead the moment the codec is released.
     */
    fun attachEncoder(key: String, surface: Surface?) {
        handler.post { encoders.attach(key, surface) }
    }

    /** Stops drawing to the encoder attached under [key]. The others keep receiving frames. */
    fun detachEncoder(key: String) {
        handler.post { encoders.detach(key) }
    }

    /**
     * Draws the encoders on [ticker]'s clock from now on, the held camera picture each tick names,
     * or on each camera frame again when null. The preview is drawn on each camera frame either way.
     */
    fun setProgramme(ticker: ProgrammeTicker?) {
        handler.post {
            handler.removeCallbacks(programmeTick)
            programme = ticker
            holdPictures(ticker?.heldPictures ?: 1)
            if (ticker != null) {
                tickStartMillis = SystemClock.uptimeMillis()
                tickCount = 0
                handler.postAtTime(programmeTick, tickStartMillis)
            }
        }
    }

    /**
     * Keeps [count] earlier camera pictures on the GPU, or none for 1. At 1080p each is 8 MB, so a
     * programme that delays its pictures by a fraction of a second holds a handful, never a second's worth.
     */
    private fun holdPictures(count: Int) {
        val wanted = if (count > 1) count else 0
        if (held.size == wanted) return
        releaseHeldPictures()
        if (wanted == 0) return
        val created = runCatching {
            val heldDraw = heldProgram ?: TextureProgram(external = false).also { heldProgram = it }
            repeat(wanted) {
                val (texture, framebuffer) = heldDraw.createHeldPicture(width, height)
                held += HeldPicture(texture, framebuffer)
            }
        }
        created.onFailure { error ->
            android.util.Log.w("TSCameraman", "PROGRAMME_HOLD_FAILED $error")
            releaseHeldPictures()
        }
    }

    private fun releaseHeldPictures() {
        val heldDraw = heldProgram
        for (picture in held) heldDraw?.releaseHeldPicture(picture.texture, picture.framebuffer)
        held.clear()
        heldWanted = emptySet()
    }

    /**
     * Copies the camera picture just latched into a held texture, drawn as the encoders are given
     * it (rotation, mirror, zoom and aspect fill), and tells the programme it is held. The texture
     * reused is the oldest one the programme no longer wants.
     */
    private fun holdLatestPicture(ticker: ProgrammeTicker, timestamp: Long) {
        if (held.isEmpty()) return
        val slot = held.filter { it.capture == null || it.capture !in heldWanted }.minByOrNull { it.filledAt }
            ?: held.minByOrNull { it.filledAt }
            ?: return
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, slot.framebuffer)
        GLES20.glViewport(0, 0, width, height)
        val (scaleX, scaleY) = fillScale(width, height)
        buildMvp(scaleX, scaleY)
        program.draw(textureId, textureMatrix, mvpMatrix)
        GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        heldFills += 1
        slot.capture = timestamp
        slot.filledAt = heldFills
        heldWanted = ticker.pictureArrived(timestamp)
    }

    /** The next tick on the programme's grid; after a stall longer than a second the grid starts again. */
    private fun scheduleNextTick() {
        val ticker = programme ?: return
        tickCount += 1
        val now = SystemClock.uptimeMillis()
        var at = tickStartMillis + (tickCount * 1000.0 / maxOf(1, ticker.frameRate)).roundToLong()
        if (at < now - 1000) {
            tickStartMillis = now
            tickCount = 0
            at = now
        }
        handler.postAtTime(programmeTick, maxOf(at, now))
    }

    /** One programme tick: the picture held, into each encoder the programme names, at its time. */
    private fun drawProgramme() {
        val ticker = programme ?: return
        val draws = ticker.tick(latestCapture, encoders.keys.toSet())
        if (draws.isEmpty() || latestCapture == null) return
        val blank = blankEncoder
        val (scaleX, scaleY) = fillScale(width, height)
        var drawn = 0
        for (draw in draws) {
            val surface = encoders[draw.key] ?: continue
            if (!egl.makeCurrent(surface)) {
                encoders.detach(draw.key)
                continue
            }
            GLES20.glViewport(0, 0, width, height)
            val heldPicture = draw.captureNanos?.let { capture -> held.firstOrNull { it.capture == capture } }
            val heldDraw = heldProgram
            if (blank) {
                GLES20.glClearColor(0f, 0f, 0f, 1f)
                GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            } else if (heldPicture != null && heldDraw != null) {
                // Already rotated, mirrored, zoomed and filled when it was held.
                heldDraw.draw(heldPicture.texture, identity, identity)
            } else {
                buildMvp(scaleX, scaleY)
                program.draw(textureId, textureMatrix, mvpMatrix)
            }
            egl.setPresentationTime(surface, draw.presentationNanos)
            egl.swapBuffers(surface)
            drawn += 1
        }
        if (drawn > 0) onFrameRendered()
    }

    fun attachPreview(surface: Surface?, viewWidth: Int, viewHeight: Int) {
        handler.post {
            previewSurface?.let { egl.releaseSurface(it) }
            previewSurface = null
            previewWindow = surface?.takeIf { it.isValid }
            previewWidth = viewWidth
            previewHeight = viewHeight
        }
    }

    /** Builds the preview EGL surface if there is a window for it and it is not already built. */
    private fun ensurePreviewSurface(): EGLSurface? {
        previewSurface?.let { return it }
        val window = previewWindow ?: return null
        if (!window.isValid) return null
        val created = runCatching { egl.createWindowSurface(window) }.getOrNull()
        previewSurface = created
        return created
    }

    /**
     * Drops whichever destinations can no longer be made current, so the next frame does not try
     * them again.
     */
    private fun releaseLostSurfaces() {
        encoders.drawEach { egl.makeCurrent(it) }
        previewSurface?.let {
            if (!egl.makeCurrent(it)) {
                egl.releaseSurface(it)
                previewSurface = null
            }
        }
    }

    /** The first destination that can be made current, so a frame is never dropped for lack of one. */
    private fun currentTarget(): EGLSurface? = encoders.first() ?: ensurePreviewSurface()

    fun release() {
        handler.post {
            handler.removeCallbacks(programmeTick)
            programme = null
            releaseHeldPictures()
            heldProgram?.release()
            heldProgram = null
            encoders.releaseAll()
            previewSurface?.let { egl.releaseSurface(it) }
            previewSurface = null
            previewWindow = null
            surfaceTexture?.release()
            surfaceTexture = null
            program.release()
            egl.release()
        }
        thread.quitSafely()
    }

    private fun onFrameAvailable() {
        // Nothing in a frame is worth the process. A GL or EGL failure here means one dropped
        // picture; an exception out of this callback means the render thread dies, and with it the
        // foreground service that is the whole point of this build.
        runCatching { drawFrame() }.onFailure { error ->
            android.util.Log.w("TSCameraman", "CAPTURE_FRAME_DROPPED $error")
        }
    }

    private fun drawFrame() {
        val texture = surfaceTexture ?: return
        // The context has to be current on *some* surface before `updateTexImage`, and the encoder
        // is the one that always exists while capture is running.
        val target = currentTarget()
        if (target == null) {
            // Nowhere to draw, but the buffer still has to be consumed or the camera stalls on a
            // full queue and the whole session goes quiet.
            runCatching {
                egl.makeCurrentWithoutSurface()
                texture.updateTexImage()
            }
            return
        }

        if (!egl.makeCurrent(target)) {
            // The one target we had is gone. Consume the buffer anyway or the camera stalls on a
            // full queue, and drop whichever destination went with it.
            releaseLostSurfaces()
            runCatching {
                egl.makeCurrentWithoutSurface()
                texture.updateTexImage()
            }
            return
        }
        texture.updateTexImage()
        texture.getTransformMatrix(textureMatrix)
        val timestamp = texture.timestamp
        transformIsTransposed = transformTransposes()
        didMeasureTransform = true
        logTransformOnce()

        val blank = blankEncoder
        if (blank != wasBlank) {
            wasBlank = blank
            onBlankChanged?.invoke()
        }

        latestCapture = timestamp
        programme?.let { ticker ->
            runCatching { holdLatestPicture(ticker, timestamp) }.onFailure { error ->
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
                android.util.Log.w("TSCameraman", "PROGRAMME_HOLD_DROPPED $error")
            }
        }
        if (programme == null && deliverToEncoder(timestamp)) {
            // Every encoder surface is exactly the encoded size, so at 0 or 180 nothing needs
            // scaling. At 90 or 270 the source turns portrait against a landscape destination, and a
            // bare rotation of the quad would squash it, so an aspect-fill scale applies.
            val (encoderScaleX, encoderScaleY) = fillScale(width, height)
            val drawn = encoders.drawEach { surface ->
                if (!egl.makeCurrent(surface)) return@drawEach false
                GLES20.glViewport(0, 0, width, height)
                if (blank) {
                    // Cleared rather than drawn: a black frame from the same encoder at the same
                    // rate, so the only thing that changes is the picture.
                    GLES20.glClearColor(0f, 0f, 0f, 1f)
                    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
                } else {
                    buildMvp(encoderScaleX, encoderScaleY)
                    program.draw(textureId, textureMatrix, mvpMatrix)
                }
                egl.setPresentationTime(surface, timestamp)
                egl.swapBuffers(surface)
                true
            }
            // Once per camera frame, however many encoders took it.
            if (drawn > 0) onFrameRendered()
        }

        ensurePreviewSurface()?.let { surface ->
            if (!egl.makeCurrent(surface)) {
                // Expected while the settings screen is over the preview. The EGL surface goes; the
                // window it was built on is kept, so the next frame rebuilds it and the picture
                // comes back rather than freezing on whatever was drawn last.
                egl.releaseSurface(surface)
                previewSurface = null
                return@let
            }
            GLES20.glViewport(0, 0, previewWidth, previewHeight)
            // Aspect-fit, matching the iOS preview's `resizeAspect`: the whole encoded frame is on
            // screen, so what the operator sees is exactly what is sent, and a 16:9 picture on a
            // wider phone gets black bars either side, where the chrome sits. Cleared first, because
            // nothing else paints the bars.
            GLES20.glClearColor(0f, 0f, 0f, 1f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
            val (scaleX, scaleY) = fitScale(previewWidth, previewHeight)
            // Clip to the unzoomed fit. Software zoom scales the quad past this rectangle; without
            // the scissor that growth paints over the bars and the operator no longer sees the
            // frame that is being broadcast.
            val frame = fittedFrame(previewWidth, previewHeight, scaleX, scaleY)
            GLES20.glEnable(GLES20.GL_SCISSOR_TEST)
            GLES20.glScissor(frame.x, frame.y, frame.width, frame.height)
            buildMvp(scaleX, scaleY)
            program.draw(textureId, textureMatrix, mvpMatrix)
            egl.swapBuffers(surface)
            GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
        }
    }

    /**
     * The transform `SurfaceTexture` hands back is not ours to reason about, but it is very much
     * ours to *know*.
     *
     * Measured on a Pixel 10, 2026-09-05: the matrix is
     * `[0,-1,0,0, -1,0,0,0, 0,0,1,0, 1,1,0,1]`, which maps `(s,t)` to `(1-t, 1-s)` — a reflection
     * about the anti-diagonal, not the plain vertical flip the documentation leads you to expect.
     * That quarter turn is why a textbook `(sensor - displayRotation)` correction left the stream
     * on its side: the transform had already turned it, and the correction assumed it had not.
     *
     * It also decides the aspect: the drawn content is the buffer transposed, so a 1920x1080 buffer
     * paints a 9:16 picture, and it is the *net* of this and [rotationDegrees] that says whether the
     * fill has to compensate. Getting that wrong costs field of view rather than orientation, which
     * is far harder to spot.
     */
    private fun transformTransposes(): Boolean {
        // Column-major; the block acting on (s,t) is m0, m1, m4, m5.
        val onDiagonal = kotlin.math.abs(textureMatrix[0]) + kotlin.math.abs(textureMatrix[5])
        val offDiagonal = kotlin.math.abs(textureMatrix[1]) + kotlin.math.abs(textureMatrix[4])
        return offDiagonal > onDiagonal
    }

    private fun logTransformOnce() {
        if (didLogTransform) return
        didLogTransform = true
        android.util.Log.i(
            "TSCameraman",
            "CAPTURE_TEX_MATRIX transposes=" + transformTransposes() + " " +
                textureMatrix.joinToString(",") { it.toString() }
        )
    }

    /** True once a frame has arrived and the transform has been read. */
    @Volatile
    var didMeasureTransform = false
        private set

    /** What [transformTransposes] measured, for the state dump. Null until the first frame. */
    @Volatile
    var transformIsTransposed: Boolean? = null
        private set

    private fun buildMvp(scaleX: Float, scaleY: Float) {
        Matrix.setIdentityM(mvpMatrix, 0)
        // The mirror rides on the destination-space scale, so it is applied after the rotation and
        // flips the picture the operator sees rather than the axis it is rotated about.
        val zoom = digitalZoom.takeIf { it.isFinite() && it > 1f } ?: 1f
        val mirroredX = if (mirrorHorizontally) -scaleX else scaleX
        Matrix.scaleM(mvpMatrix, 0, mirroredX * zoom, scaleY * zoom, 1f)
        if (rotationDegrees != 0) {
            Matrix.rotateM(mvpMatrix, 0, rotationDegrees.toFloat(), 0f, 0f, 1f)
        }
    }

    /**
     * Scales the quad so the destination is covered and the overflow runs off an edge.
     *
     * `buildMvp` composes as `scale * rotate`, so the vertex is rotated first and these factors are
     * already in destination axes. They must not be swapped.
     */
    private fun fillScale(destinationWidth: Int, destinationHeight: Int): Pair<Float, Float> {
        val ratio = aspectRatio(destinationWidth, destinationHeight) ?: return 1f to 1f
        return if (ratio > 1f) {
            // Destination is wider: fill the width and let the top and bottom run off.
            1f to ratio
        } else {
            (1f / ratio) to 1f
        }
    }

    /**
     * Scales the quad so the whole picture fits inside the destination and the remainder is left to
     * whatever the destination was cleared to.
     *
     * The same destination-axis rule as [fillScale] applies.
     */
    private fun fitScale(destinationWidth: Int, destinationHeight: Int): Pair<Float, Float> {
        val ratio = aspectRatio(destinationWidth, destinationHeight) ?: return 1f to 1f
        return if (ratio > 1f) {
            // Destination is wider: fill the height and leave bars either side.
            (1f / ratio) to 1f
        } else {
            1f to ratio
        }
    }

    /**
     * The destination's aspect over the drawn picture's, or null while there is no destination.
     *
     * Two quarter turns are in play and only their *net* matters: the one the `SurfaceTexture`
     * transform already applied, and the one [rotationDegrees] is about to. When they cancel — as
     * they do on this handset at 90 degrees — the picture lands back at 16:9 against a 16:9 buffer
     * and nothing needs scaling. Compensating anyway would silently crop to the middle third of the
     * frame, which reads as "the camera is zoomed in" rather than as a bug.
     */
    private fun aspectRatio(destinationWidth: Int, destinationHeight: Int): Float? {
        if (destinationWidth <= 0 || destinationHeight <= 0) return null
        val quarterTurn = rotationDegrees == 90 || rotationDegrees == 270
        val netTransposed = (transformIsTransposed ?: false) != quarterTurn
        val drawnAspect = if (netTransposed) {
            height.toFloat() / width.toFloat()
        } else {
            width.toFloat() / height.toFloat()
        }
        return (destinationWidth.toFloat() / destinationHeight.toFloat()) / drawnAspect
    }
}
