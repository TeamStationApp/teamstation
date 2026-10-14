package app.teamstation.app.stream

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.Surface
import app.teamstation.app.walkup.NativePhoneStreamSpec
import app.teamstation.streamcore.phonestream.PhoneStreamCapabilities
import app.teamstation.streamcore.phonestream.PhoneStreamEngine
import app.teamstation.streamcore.phonestream.PhoneStreamEvent
import app.teamstation.streamcore.phonestream.PhoneStreamException
import app.teamstation.streamcore.phonestream.PhoneStreamRequest
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The `TSPhoneStream` TurboModule: the phone's streaming and recording engine
 * ([PhoneStreamEngine]), one per process, behind the calls `NativePhoneStream.ts` describes. It only
 * converts arguments, results and events ([PhoneStreamMaps]); a refusal rejects with the engine's
 * error code, such as `uploadInProgress`. The engine's foreground work runs [PhoneStreamService].
 *
 * While the engine is open it follows the display's rotation, which the capture turns the picture
 * by so the field is upright in either landscape.
 */
class PhoneStreamModule(reactContext: ReactApplicationContext) : NativePhoneStreamSpec(reactContext) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val main = Handler(Looper.getMainLooper())
    private var stopObserving: (() -> Unit)? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    private val engine: PhoneStreamEngine
        get() = engine(reactApplicationContext)

    override fun initialize() {
        super.initialize()
        stopObserving = engine.observe(::deliver)
    }

    override fun invalidate() {
        stopObserving?.invoke()
        stopObserving = null
        unfollowRotation()
        scope.cancel()
        super.invalidate()
    }

    private fun deliver(event: PhoneStreamEvent) {
        val map = when (event) {
            is PhoneStreamEvent.Status -> PhoneStreamMaps.status(event.status)
            is PhoneStreamEvent.Radar -> PhoneStreamMaps.radar(event.radar)
            is PhoneStreamEvent.Upload -> PhoneStreamMaps.upload(event.upload)
        }
        main.post {
            try {
                val value = Arguments.makeNativeMap(map)
                when (event) {
                    is PhoneStreamEvent.Status -> emitOnStatus(value)
                    is PhoneStreamEvent.Radar -> emitOnRadar(value)
                    is PhoneStreamEvent.Upload -> emitOnUpload(value)
                }
            } catch (error: Exception) {
                Log.w(TAG, "No listener for ${event.javaClass.simpleName}", error)
            }
        }
    }

    /** Runs [work] off the JavaScript thread, resolving with what it answers or rejecting with its refusal. */
    private fun settle(promise: Promise, work: suspend () -> Any?) {
        scope.launch {
            try {
                promise.resolve(native(work()))
            } catch (error: PhoneStreamException) {
                promise.reject(error.code.rawValue, error.message, error)
            } catch (error: CancellationException) {
                promise.reject("cancelled", "cancelled", error)
            } catch (error: Exception) {
                promise.reject("failed", error.message ?: error.javaClass.simpleName, error)
            }
        }
    }

    private fun native(value: Any?): Any? =
        when (value) {
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                Arguments.makeNativeMap(value as Map<String, Any?>)
            }
            is List<*> -> Arguments.makeNativeArray(value)
            is Unit -> null
            else -> value
        }

    private fun request(map: ReadableMap): PhoneStreamRequest =
        PhoneStreamMaps.request(map.toHashMap(), PhoneStreamCapabilities.current().deviceModel)
            ?: throw IllegalArgumentException("The stream request needs an apiBase")

    private fun strings(array: ReadableArray): Set<String> =
        (0 until array.size()).mapNotNull { array.getString(it) }.toSet()

    override fun capabilities(promise: Promise) =
        settle(promise) { PhoneStreamMaps.capabilities(PhoneStreamCapabilities.current()) }

    override fun open(angleName: String, audioEnabled: Boolean, disabledLenses: ReadableArray, promise: Promise) {
        val lenses = strings(disabledLenses)
        settle(promise) {
            engine.open(angleName, audioEnabled, lenses)
            preview?.let { (surface, width, height) -> engine.attachPreview(surface, width, height) }
            main.post { followRotation() }
            null
        }
    }

    override fun close(promise: Promise) =
        settle(promise) {
            main.post { unfollowRotation() }
            engine.close()
            null
        }

    override fun setAngleName(name: String, promise: Promise) = settle(promise) { engine.setAngleName(name) }

    override fun startRecording(
        rtmpUrl: String,
        liveStreamId: String,
        gameId: String,
        angleName: String,
        request: ReadableMap,
        promise: Promise
    ) {
        val held = try {
            request(request)
        } catch (error: IllegalArgumentException) {
            promise.reject("badRequest", error.message, error)
            return
        }
        settle(promise) { engine.startRecording(rtmpUrl, liveStreamId, gameId, angleName, held) }
    }

    override fun stopRecording(promise: Promise) = settle(promise) { engine.stopRecording() }

    override fun interruptedSession(promise: Promise) =
        settle(promise) { engine.interruptedSession()?.let(PhoneStreamMaps::interrupted) }

    override fun resumeInterrupted(request: ReadableMap, promise: Promise) {
        val held = try {
            request(request)
        } catch (error: IllegalArgumentException) {
            promise.reject("badRequest", error.message, error)
            return
        }
        settle(promise) { engine.resumeInterrupted(held) }
    }

    override fun setZoom(displayed: Double) {
        scope.launch { engine.setZoom(displayed) }
    }

    override fun pinch(scale: Double, ended: Boolean) {
        scope.launch { engine.pinch(scale, ended) }
    }

    override fun zoomScale(promise: Promise) = settle(promise) { PhoneStreamMaps.zoomScale(engine.zoomScale()) }

    override fun lenses(promise: Promise) = settle(promise) { engine.lenses().map(PhoneStreamMaps::lens) }

    override fun setDisabledLenses(ids: ReadableArray, promise: Promise) {
        val lenses = strings(ids)
        settle(promise) { engine.setDisabledLenses(lenses) }
    }

    override fun flip(promise: Promise) = settle(promise) { engine.flip() }

    override fun setAudioEnabled(enabled: Boolean, promise: Promise) = settle(promise) { engine.setAudioEnabled(enabled) }

    override fun radarSetEnabled(enabled: Boolean, promise: Promise) = settle(promise) { engine.radarSetEnabled(enabled) }

    override fun radarScan(promise: Promise) = settle(promise) { engine.radarScan() }

    override fun radarStopScan(promise: Promise) = settle(promise) { engine.radarStopScan() }

    override fun radarPair(serial: String, promise: Promise) = settle(promise) { engine.radarPair(serial) }

    override fun radarUnpair(serial: String, promise: Promise) = settle(promise) { engine.radarUnpair(serial) }

    override fun radarState(promise: Promise) = settle(promise) { PhoneStreamMaps.radar(engine.radarState()) }

    override fun recordings(promise: Promise) =
        settle(promise) {
            val running = engine.runningUploads()
            val progress = engine.runningUploadProgress()
            engine.recordings().map { PhoneStreamMaps.recording(it, it.recordingID in running, progress[it.recordingID]) }
        }

    override fun uploadRecording(liveStreamId: String, apiBase: String, token: String, title: String, promise: Promise) =
        settle(promise) { engine.uploadRecording(liveStreamId, apiBase, token, title) }

    override fun resumePendingUploads(apiBase: String, token: String, promise: Promise) =
        settle(promise) { engine.resumePendingUploads(apiBase, token) }

    override fun cancelUpload(liveStreamId: String, promise: Promise) = settle(promise) { engine.cancelUpload(liveStreamId) }

    override fun deleteRecording(liveStreamId: String, promise: Promise) = settle(promise) { engine.deleteRecording(liveStreamId) }

    // MARK: - Display rotation

    private fun followRotation() {
        if (displayListener != null) return
        val displays = reactApplicationContext.getSystemService(DisplayManager::class.java) ?: return
        val listener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) {
                if (displayId == Display.DEFAULT_DISPLAY) applyRotation(displays)
            }
        }
        displays.registerDisplayListener(listener, main)
        displayListener = listener
        applyRotation(displays)
    }

    private fun unfollowRotation() {
        val listener = displayListener ?: return
        displayListener = null
        reactApplicationContext.getSystemService(DisplayManager::class.java)?.unregisterDisplayListener(listener)
    }

    private fun applyRotation(displays: DisplayManager) {
        val rotation = displays.getDisplay(Display.DEFAULT_DISPLAY)?.rotation ?: return
        val degrees = PhoneStreamMaps.rotationDegrees(rotation)
        scope.launch { engine.setDisplayRotation(degrees) }
    }

    companion object {
        private const val TAG = "PhoneStream"

        /** The preview's surface and size, held so an engine opened after it mounts draws into it. */
        @Volatile
        private var preview: Triple<Surface, Int, Int>? = null

        /** The process's engine, whose foreground work runs [PhoneStreamService]. */
        fun engine(context: Context): PhoneStreamEngine =
            PhoneStreamEngine.shared(context.applicationContext, PhoneStreamService.Work(context))

        fun setPreview(context: Context, surface: Surface, width: Int, height: Int) {
            preview = Triple(surface, width, height)
            engine(context).attachPreview(surface, width, height)
        }

        fun clearPreview(context: Context, surface: Surface) {
            if (preview?.first !== surface) return
            preview = null
            engine(context).attachPreview(null, 0, 0)
        }
    }
}
