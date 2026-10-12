package app.teamstation.app.stream

import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.TSPhoneStreamPreviewManagerDelegate
import com.facebook.react.viewmanagers.TSPhoneStreamPreviewManagerInterface

/**
 * `TSPhoneStreamPreview`: a [TextureView] the engine's capture renderer draws the camera into,
 * straight from the capture and without the programme's picture delay. Its surface is handed to the
 * engine while it exists; `mirrored` flips the view, as a front camera's preview is.
 */
class PhoneStreamPreviewManager :
    SimpleViewManager<TextureView>(),
    TSPhoneStreamPreviewManagerInterface<TextureView> {
    private val delegate = TSPhoneStreamPreviewManagerDelegate(this)

    override fun getDelegate(): ViewManagerDelegate<TextureView> = delegate

    override fun getName(): String = NAME

    override fun createViewInstance(context: ThemedReactContext): TextureView {
        val view = TextureView(context)
        view.surfaceTextureListener = PreviewSurface(context)
        // The streaming screen is up while the preview is: the window holding it keeps the phone awake.
        view.keepScreenOn = true
        return view
    }

    override fun setMirrored(view: TextureView, value: Boolean) {
        view.scaleX = if (value) -1f else 1f
    }

    override fun onDropViewInstance(view: TextureView) {
        (view.surfaceTextureListener as? PreviewSurface)?.detach()
        super.onDropViewInstance(view)
    }

    /** Hands the view's surface to the engine, and takes it back before it goes. */
    private class PreviewSurface(private val context: ThemedReactContext) : TextureView.SurfaceTextureListener {
        private var surface: Surface? = null

        override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
            val created = Surface(texture)
            surface = created
            PhoneStreamModule.setPreview(context.reactApplicationContext, created, width, height)
        }

        override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
            surface?.let { PhoneStreamModule.setPreview(context.reactApplicationContext, it, width, height) }
        }

        override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
            detach()
            return true
        }

        override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit

        fun detach() {
            val held = surface ?: return
            surface = null
            PhoneStreamModule.clearPreview(context.reactApplicationContext, held)
            held.release()
        }
    }

    companion object {
        const val NAME = "TSPhoneStreamPreview"
    }
}
