package co.gamestation.cameraman.gl

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface

/**
 * A minimal EGL context, sized to exactly what this app needs and nothing more.
 *
 * The camera cannot draw into two surfaces at once, and the encoder's input surface and the
 * on-screen preview are two surfaces. So the camera draws into one `SurfaceTexture` and this
 * context blits that texture into each destination in turn, which is also the only place the
 * 0°/180° capture rotation can be applied — there is no Android counterpart to setting
 * `videoRotationAngle` on an `AVCaptureConnection`.
 */
internal class EglCore {
    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var config: EGLConfig? = null

    init {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        check(display != EGL14.EGL_NO_DISPLAY) { "no EGL display" }

        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize failed" }

        val attributes = intArrayOf(
            EGL14.EGL_RED_SIZE, 8,
            EGL14.EGL_GREEN_SIZE, 8,
            EGL14.EGL_BLUE_SIZE, 8,
            EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            // Without this the encoder's input surface is not a legal EGL target and
            // `eglCreateWindowSurface` fails with EGL_BAD_MATCH rather than anything descriptive.
            EGLExt.EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_NONE
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val configCount = IntArray(1)
        check(
            EGL14.eglChooseConfig(display, attributes, 0, configs, 0, 1, configCount, 0) &&
                configCount[0] > 0
        ) { "no EGL config with a recordable RGBA8888 surface" }
        config = configs[0]

        val contextAttributes = intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE)
        context = EGL14.eglCreateContext(
            display, config, EGL14.EGL_NO_CONTEXT, contextAttributes, 0
        )
        check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext failed" }
    }

    fun createWindowSurface(surface: Any): EGLSurface {
        val attributes = intArrayOf(EGL14.EGL_NONE)
        val result = EGL14.eglCreateWindowSurface(display, config, surface, attributes, 0)
        check(result != null && result != EGL14.EGL_NO_SURFACE) { "eglCreateWindowSurface failed" }
        return result
    }

    /**
     * Returns false rather than throwing.
     *
     * A destination surface can be pulled out from under a frame that is already in flight — the
     * encoder is reconfigured for a codec change, or the preview `SurfaceView` is destroyed when the
     * settings screen replaces it — and `eglMakeCurrent` then fails on an EGL surface whose window
     * is gone. Throwing here killed the render thread, and with it the foreground service and the
     * stream, over something that is both expected and recoverable.
     */
    fun makeCurrent(surface: EGLSurface): Boolean =
        EGL14.eglMakeCurrent(display, surface, surface, context)

    /**
     * Needed before creating GL objects that outlive any one destination surface — the texture the
     * camera writes into is shared by the encoder and the preview.
     */
    fun makeCurrentWithoutSurface() {
        EGL14.eglMakeCurrent(
            display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, context
        )
    }

    fun swapBuffers(surface: EGLSurface): Boolean = EGL14.eglSwapBuffers(display, surface)

    /**
     * Stamps the frame's capture time onto the buffer the encoder is about to take.
     *
     * Without this MediaCodec timestamps every picture at the moment it happened to be swapped,
     * which is jittery under load, and the RTP timestamps derived from it drift against the audio.
     */
    fun setPresentationTime(surface: EGLSurface, nanoseconds: Long) {
        EGLExt.eglPresentationTimeANDROID(display, surface, nanoseconds)
    }

    fun releaseSurface(surface: EGLSurface) {
        EGL14.eglDestroySurface(display, surface)
    }

    fun release() {
        if (display != EGL14.EGL_NO_DISPLAY) {
            EGL14.eglMakeCurrent(
                display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT
            )
            EGL14.eglDestroyContext(display, context)
            EGL14.eglReleaseThread()
            EGL14.eglTerminate(display)
        }
        display = EGL14.EGL_NO_DISPLAY
        context = EGL14.EGL_NO_CONTEXT
        config = null
    }
}
