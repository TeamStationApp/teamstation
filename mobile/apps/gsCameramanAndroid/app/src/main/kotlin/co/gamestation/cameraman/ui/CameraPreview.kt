package co.gamestation.cameraman.ui

import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import co.gamestation.cameraman.capture.CameraSession

/**
 * Hosts the preview surface.
 *
 * A `SurfaceView` rather than a `TextureView`: the renderer already has the frame on the GPU, and a
 * `SurfaceView` is a real overlay the compositor scans out directly, where a `TextureView` would add
 * another copy through the view hierarchy for every frame.
 *
 * Nothing here rotates or mirrors anything. The picture arrives already rotated by
 * `CaptureRenderer`, at the same 0°/180° the encoder is being fed, which is what makes the promise
 * the iOS build makes hold here too: the operator frames what the client receives. Driving preview
 * from the view's own orientation is what left the iOS front camera inverted, and it would do the
 * same here.
 */
@Composable
fun CameraPreview(camera: CameraSession, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            SurfaceView(context).apply {
                holder.addCallback(object : SurfaceHolder.Callback {
                    override fun surfaceCreated(holder: SurfaceHolder) = Unit

                    override fun surfaceChanged(
                        holder: SurfaceHolder,
                        format: Int,
                        width: Int,
                        height: Int
                    ) {
                        // Attached on every size change as well as on creation: the EGL window
                        // surface is bound to the buffer geometry, and one made against the old size
                        // renders a stretched picture until something else recreates it.
                        camera.attachPreview(holder.surface, width, height)
                    }

                    override fun surfaceDestroyed(holder: SurfaceHolder) {
                        camera.attachPreview(null, 0, 0)
                    }
                })
            }
        }
    )
}
