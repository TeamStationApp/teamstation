package app.teamstation.app.qrscanner

import android.annotation.SuppressLint
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraManager
import android.widget.FrameLayout
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * `TSQrScanner` on Android: the back camera through CameraX, each frame read by ML Kit's bundled
 * barcode scanner for QR codes only. On mount it reports `available` or `unavailable` (no camera,
 * as on an emulator made without one, whatever features its system image declares); while `active` it reports `ready` once the camera is bound,
 * and `onCode` with each code's text. The JavaScript wrapper asks for the camera permission before
 * it sets `active`, so this view never asks.
 */
class QrScannerView(private val context: ThemedReactContext) : FrameLayout(context) {
    private val preview = PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
    private val scanner =
        BarcodeScanning.getClient(
            BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        )
    private var analysisExecutor: ExecutorService? = null
    private var provider: ProcessCameraProvider? = null
    private var active = false
    private var reported = false
    private var released = false

    // Bumped by every start and stop: a provider that arrives for an older
    // one, after the view stopped, left the window or was released, binds
    // nothing.
    private var generation = 0

    // A React Native view is laid out by Yoga; PreviewView's own children need a measure pass.
    // Set in init: the superclass constructor can ask for a layout before it exists.
    private var relayout: Runnable? = null

    init {
        addView(preview, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        relayout = Runnable {
            measure(
                MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
            )
            layout(left, top, right, bottom)
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!reported) {
            reported = true
            emitStatus(if (hasCamera()) "available" else "unavailable")
        }
        if (active) start()
    }

    override fun onDetachedFromWindow() {
        stop()
        super.onDetachedFromWindow()
    }

    override fun requestLayout() {
        super.requestLayout()
        relayout?.let { post(it) }
    }

    fun setActive(value: Boolean) {
        if (value == active) return
        active = value
        if (value) start() else stop()
    }

    // The cameras the phone has now, not the features its system image declares: an emulator's
    // image declares a camera whether or not the device was given one.
    private fun hasCamera(): Boolean =
        try {
            context.getSystemService(CameraManager::class.java)?.cameraIdList?.isNotEmpty() == true
        } catch (_: CameraAccessException) {
            false
        }

    private fun start() {
        if (released || !isAttachedToWindow || !hasCamera()) return
        val owner = context.currentActivity as? LifecycleOwner ?: return
        val started = ++generation
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener(
            {
                if (started != generation || !active || released || !isAttachedToWindow) return@addListener
                // A camera CameraX cannot open (disabled by policy, its service gone, a
                // lifecycle already destroyed) says so, as iOS does, rather than crash.
                try {
                    bind(future.get(), owner)
                } catch (_: Exception) {
                    provider?.unbindAll()
                    emitStatus("unavailable")
                }
            },
            ContextCompat.getMainExecutor(context)
        )
    }

    private fun bind(cameras: ProcessCameraProvider, owner: LifecycleOwner) {
        provider = cameras
        if (!cameras.hasCamera(CameraSelector.DEFAULT_BACK_CAMERA)) {
            emitStatus("unavailable")
            return
        }
        // One analysis thread at a time: a restart shuts the last one down first.
        analysisExecutor?.shutdown()
        val executor = Executors.newSingleThreadExecutor()
        analysisExecutor = executor
        val shown = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
        val analysis =
            ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
        analysis.setAnalyzer(executor) { frame -> read(frame) }
        cameras.unbindAll()
        cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, shown, analysis)
        emitStatus("ready")
    }

    @SuppressLint("UnsafeOptInUsageError")
    private fun read(frame: ImageProxy) {
        val image = frame.image
        if (image == null) {
            frame.close()
            return
        }
        scanner
            .process(InputImage.fromMediaImage(image, frame.imageInfo.rotationDegrees))
            .addOnSuccessListener { codes ->
                codes.firstNotNullOfOrNull { it.rawValue }?.let { text -> post { emit("topCode", "text", text) } }
            }
            .addOnCompleteListener { frame.close() }
    }

    fun stop() {
        generation++
        provider?.unbindAll()
        provider = null
        analysisExecutor?.shutdown()
        analysisExecutor = null
    }

    fun release() {
        released = true
        stop()
        scanner.close()
    }

    private fun emitStatus(status: String) {
        emit("topStatus", "status", status)
    }

    private fun emit(name: String, key: String, value: String) {
        val surfaceId = UIManagerHelper.getSurfaceId(this)
        UIManagerHelper.getEventDispatcherForReactTag(context, id)
            ?.dispatchEvent(ScannerEvent(surfaceId, id, name, key, value))
    }

    private class ScannerEvent(
        surfaceId: Int,
        viewId: Int,
        private val name: String,
        private val key: String,
        private val value: String
    ) : Event<ScannerEvent>(surfaceId, viewId) {
        override fun getEventName(): String = name

        override fun getEventData(): WritableMap = Arguments.createMap().apply { putString(key, value) }
    }
}
