package app.teamstation.streamcore.phonestream

import android.app.Activity
import android.graphics.SurfaceTexture
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * A full-screen preview of the engine's camera, which keeps the test's process in the foreground: a
 * phone gives the camera and the microphone only to the app on screen.
 *
 * Like the TeamStation app's streaming screen, it is landscape either way up (`sensorLandscape`) and
 * tells the engine the display's rotation whenever it changes, so the picture sent is upright however
 * the phone stands in its holder. Pinned to one landscape, a phone standing the other way up sent the
 * picture upside down. Turning between the two landscapes keeps the window's size, so no
 * configuration change reports it: the display listener does.
 */
class PhoneStreamTestActivity : Activity(), TextureView.SurfaceTextureListener {
    private var surface: Surface? = null
    private val scope = MainScope()
    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) = Unit

        override fun onDisplayRemoved(displayId: Int) = Unit

        override fun onDisplayChanged(displayId: Int) {
            if (displayId == display?.displayId) followRotation()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(TextureView(this).also { it.surfaceTextureListener = this })
        getSystemService(DisplayManager::class.java)?.registerDisplayListener(displayListener, Handler(mainLooper))
    }

    override fun onDestroy() {
        getSystemService(DisplayManager::class.java)?.unregisterDisplayListener(displayListener)
        scope.cancel()
        super.onDestroy()
    }

    /** Tells the engine the display's rotation now. */
    private fun followRotation() {
        val running = engine ?: return
        val degrees = displayRotationDegrees
        scope.launch { running.setDisplayRotation(degrees) }
    }

    /** The screen's rotation in degrees, for the engine to turn the picture upright. */
    val displayRotationDegrees: Int
        get() = when (display?.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }

    override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
        surface = Surface(texture)
        engine?.attachPreview(surface, width, height)
    }

    override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
        engine?.attachPreview(surface, width, height)
    }

    override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
        engine?.attachPreview(null, 0, 0)
        surface?.release()
        surface = null
        return true
    }

    override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit

    /** Draws the open engine's preview, once it has a surface. */
    fun show(engine: PhoneStreamEngine) {
        Companion.engine = engine
        surface?.let { engine.attachPreview(it, window.decorView.width, window.decorView.height) }
        followRotation()
    }

    companion object {
        @Volatile
        var engine: PhoneStreamEngine? = null
    }
}
