package co.gamestation.cameraman.gl

import android.graphics.SurfaceTexture
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import java.util.concurrent.CountDownLatch

/**
 * Camera frames in, encoder and preview out, with the capture rotation applied on the way.
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

    private var encoderSurface: EGLSurface? = null
    private var previewSurface: EGLSurface? = null
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

    fun attachEncoder(surface: Surface?) {
        handler.post {
            // Released before the new one is made: `createInputSurface` returns a fresh object after
            // every codec reconfigure, and the EGL surface built on the old one is dead the moment
            // the codec is released.
            encoderSurface?.let { egl.releaseSurface(it) }
            encoderSurface = surface?.takeIf { it.isValid }?.let {
                runCatching { egl.createWindowSurface(it) }.getOrNull()
            }
        }
    }

    fun attachPreview(surface: Surface?, viewWidth: Int, viewHeight: Int) {
        handler.post {
            previewSurface?.let { egl.releaseSurface(it) }
            previewSurface = if (surface != null && surface.isValid) {
                runCatching { egl.createWindowSurface(surface) }.getOrNull()
            } else {
                null
            }
            previewWidth = viewWidth
            previewHeight = viewHeight
        }
    }

    /**
     * Drops whichever destinations can no longer be made current, so the next frame does not try
     * them again.
     */
    private fun releaseLostSurfaces() {
        encoderSurface?.let {
            if (!egl.makeCurrent(it)) {
                egl.releaseSurface(it)
                encoderSurface = null
            }
        }
        previewSurface?.let {
            if (!egl.makeCurrent(it)) {
                egl.releaseSurface(it)
                previewSurface = null
            }
        }
    }

    fun release() {
        handler.post {
            encoderSurface?.let { egl.releaseSurface(it) }
            previewSurface?.let { egl.releaseSurface(it) }
            encoderSurface = null
            previewSurface = null
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
            android.util.Log.w("GSCameraman", "CAPTURE_FRAME_DROPPED $error")
        }
    }

    private fun drawFrame() {
        val texture = surfaceTexture ?: return
        // The context has to be current on *some* surface before `updateTexImage`, and the encoder
        // is the one that always exists while capture is running.
        val target = encoderSurface ?: previewSurface
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

        encoderSurface?.let { surface ->
            if (!egl.makeCurrent(surface)) {
                egl.releaseSurface(surface)
                encoderSurface = null
                return@let
            }
            GLES20.glViewport(0, 0, width, height)
            // The encoder surface is exactly the encoded size, so at 0 or 180 nothing needs scaling.
            // At 90 or 270 the source turns portrait against a landscape destination, and a bare
            // rotation of the quad would squash it, so the same aspect-fill the preview uses applies.
            val (encoderScaleX, encoderScaleY) = fillScale(width, height)
            buildMvp(encoderScaleX, encoderScaleY)
            program.draw(textureId, textureMatrix, mvpMatrix)
            egl.setPresentationTime(surface, timestamp)
            egl.swapBuffers(surface)
            onFrameRendered()
        }

        previewSurface?.let { surface ->
            if (!egl.makeCurrent(surface)) {
                // Expected every time the settings screen replaces the preview. Dropping it here
                // costs nothing: `attachPreview` makes a fresh one when the view comes back.
                egl.releaseSurface(surface)
                previewSurface = null
                return@let
            }
            GLES20.glViewport(0, 0, previewWidth, previewHeight)
            // Aspect-fill, matching the iOS preview's `resizeAspectFill`: the stream is cropped to
            // the same aspect the operator is looking at, so what is framed is what is sent.
            val (scaleX, scaleY) = fillScale(previewWidth, previewHeight)
            buildMvp(scaleX, scaleY)
            program.draw(textureId, textureMatrix, mvpMatrix)
            egl.swapBuffers(surface)
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
            "GSCameraman",
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
        val mirroredX = if (mirrorHorizontally) -scaleX else scaleX
        Matrix.scaleM(mvpMatrix, 0, mirroredX, scaleY, 1f)
        if (rotationDegrees != 0) {
            Matrix.rotateM(mvpMatrix, 0, rotationDegrees.toFloat(), 0f, 0f, 1f)
        }
    }

    /**
     * Scales the quad so the destination is covered and the overflow runs off an edge.
     *
     * Two quarter turns are in play and only their *net* matters: the one the `SurfaceTexture`
     * transform already applied, and the one [rotationDegrees] is about to. When they cancel — as
     * they do on this handset at 90 degrees — the picture lands back at 16:9 against a 16:9 buffer
     * and nothing needs scaling. Compensating anyway would silently crop to the middle third of the
     * frame, which reads as "the camera is zoomed in" rather than as a bug.
     *
     * `buildMvp` composes as `scale * rotate`, so the vertex is rotated first and these factors are
     * already in destination axes. They must not be swapped.
     */
    private fun fillScale(destinationWidth: Int, destinationHeight: Int): Pair<Float, Float> {
        if (destinationWidth <= 0 || destinationHeight <= 0) return 1f to 1f
        val quarterTurn = rotationDegrees == 90 || rotationDegrees == 270
        val netTransposed = (transformIsTransposed ?: false) != quarterTurn
        val drawnAspect = if (netTransposed) {
            height.toFloat() / width.toFloat()
        } else {
            width.toFloat() / height.toFloat()
        }
        val destinationAspect = destinationWidth.toFloat() / destinationHeight.toFloat()
        return if (destinationAspect > drawnAspect) {
            // Destination is wider: fill the width and let the top and bottom run off.
            1f to (destinationAspect / drawnAspect)
        } else {
            (drawnAspect / destinationAspect) to 1f
        }
    }
}
