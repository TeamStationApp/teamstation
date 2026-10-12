package app.teamstation.streamcore.phonestream

import android.app.Activity
import android.graphics.SurfaceTexture
import android.os.Bundle
import android.view.Surface
import android.view.TextureView
import android.view.WindowManager

/**
 * A full-screen preview of the engine's camera, which keeps the test's process in the foreground: a
 * phone gives the camera and the microphone only to the app on screen.
 */
class PhoneStreamTestActivity : Activity(), TextureView.SurfaceTextureListener {
    private var surface: Surface? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(TextureView(this).also { it.surfaceTextureListener = this })
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
    }

    companion object {
        @Volatile
        var engine: PhoneStreamEngine? = null
    }
}
