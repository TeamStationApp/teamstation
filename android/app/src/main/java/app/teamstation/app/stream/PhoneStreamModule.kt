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
import app.teamstation.streamcore.phonestream.PhoneStreamRequest
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
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
 * An engine that could not be made answers unsupported, and every call rejects with `unsupported`
 * and why ([EngineOnce]), as on iOS, so the app carries on without streaming.
 *
 * While the engine is open it follows the display's rotation, which the capture turns the picture
 * by so the field is upright in either landscape.
 */
class PhoneStreamModule(reactContext: ReactApplicationContext) : NativePhoneStreamSpec(reactContext) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Every call that sets the engine's state (open and close, record and stop, zoom, lenses, sound,
     * radar, a take's upload state), which must reach the engine in the order JavaScript made them:
     * launched each on its own, `setAudioEnabled(false)` then `(true)` could land the other way round.
     * Questions run beside them, and so does `uploadRecording`, which answers only once the upload
     * has landed.
     */
    private val ordered = OrderedCalls(scope) { Log.w(TAG, "zoom or rotation", it) }
    private val main = Handler(Looper.getMainLooper())
    private var stopObserving: (() -> Unit)? = null
    private var displayListener: DisplayManager.DisplayListener? = null

    private val engine: PhoneStreamEngine
        get() = engine(reactApplicationContext)

    override fun initialize() {
        super.initialize()
        stopObserving = try {
            engine.observe(::deliver)
        } catch (error: PhoneStreamUnavailable) {
            Log.w(TAG, error.reason, error.cause)
            null
        }
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
            val answer = try {
                Result.success(work())
            } catch (error: Exception) {
                Result.failure(error)
            }
            reply(promise, answer)
        }
    }

    /** As [settle], queued behind every state-setting call made before it ([ordered]). */
    private fun settleInOrder(promise: Promise, work: suspend () -> Any?) {
        ordered.call(work) { answer -> reply(promise, answer) }
    }

    private fun reply(promise: Promise, answer: Result<Any?>) {
        answer
            .mapCatching { native(it) }
            .onSuccess { promise.resolve(it) }
            .onFailure { error ->
                val (code, message) = PhoneStreamRefusal.of(error)
                promise.reject(code, message, error)
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

    /** Unsupported when the engine could not be made, so the app offers no Record video. */
    override fun capabilities(promise: Promise) =
        settle(promise) {
            val current = PhoneStreamCapabilities.current()
            val made = engineOrNull(reactApplicationContext)
            PhoneStreamMaps.capabilities(
                current.copy(supported = current.supported && made != null, canRecordLocally = made?.canRecordLocally() == true)
            )
        }

    override fun open(angleName: String, audioEnabled: Boolean, disabledLenses: ReadableArray, promise: Promise) {
        val lenses = strings(disabledLenses)
        settleInOrder(promise) {
            engine.open(angleName, audioEnabled, lenses)
            preview?.let { (surface, width, height) -> engine.attachPreview(surface, width, height) }
            main.post { followRotation() }
            null
        }
    }

    override fun close(promise: Promise) =
        settleInOrder(promise) {
            main.post { unfollowRotation() }
            engine.close()
            null
        }

    override fun setAngleName(name: String, promise: Promise) = settleInOrder(promise) { engine.setAngleName(name) }

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
        settleInOrder(promise) { engine.startRecording(rtmpUrl, liveStreamId, gameId, angleName, held) }
    }

    override fun stopRecording(promise: Promise) = settleInOrder(promise) { engine.stopRecording() }

    override fun interruptedSession(promise: Promise) =
        settle(promise) { engine.interruptedSession()?.let(PhoneStreamMaps::interrupted) }

    override fun resumeInterrupted(request: ReadableMap, promise: Promise) {
        val held = try {
            request(request)
        } catch (error: IllegalArgumentException) {
            promise.reject("badRequest", error.message, error)
            return
        }
        settleInOrder(promise) { engine.resumeInterrupted(held) }
    }

    override fun setZoom(displayed: Double) {
        ordered.run { engine.setZoom(displayed) }
    }

    override fun pinch(scale: Double, ended: Boolean) {
        ordered.run { engine.pinch(scale, ended) }
    }

    override fun zoomScale(promise: Promise) = settle(promise) { PhoneStreamMaps.zoomScale(engine.zoomScale()) }

    override fun lenses(promise: Promise) = settle(promise) { engine.lenses().map(PhoneStreamMaps::lens) }

    override fun setDisabledLenses(ids: ReadableArray, promise: Promise) {
        val lenses = strings(ids)
        settleInOrder(promise) { engine.setDisabledLenses(lenses) }
    }

    override fun flip(promise: Promise) = settleInOrder(promise) { engine.flip() }

    override fun setAudioEnabled(enabled: Boolean, promise: Promise) = settleInOrder(promise) { engine.setAudioEnabled(enabled) }

    override fun radarSetEnabled(enabled: Boolean, promise: Promise) = settleInOrder(promise) { engine.radarSetEnabled(enabled) }

    override fun radarScan(promise: Promise) = settleInOrder(promise) { engine.radarScan() }

    override fun radarStopScan(promise: Promise) = settleInOrder(promise) { engine.radarStopScan() }

    override fun radarPair(serial: String, promise: Promise) = settleInOrder(promise) { engine.radarPair(serial) }

    override fun radarUnpair(serial: String, promise: Promise) = settleInOrder(promise) { engine.radarUnpair(serial) }

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
        settleInOrder(promise) { engine.resumePendingUploads(apiBase, token) }

    override fun cancelUpload(liveStreamId: String, promise: Promise) = settleInOrder(promise) { engine.cancelUpload(liveStreamId) }

    override fun deleteRecording(liveStreamId: String, promise: Promise) = settleInOrder(promise) { engine.deleteRecording(liveStreamId) }

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
        ordered.run { engine.setDisplayRotation(degrees) }
    }

    companion object {
        private const val TAG = "PhoneStream"

        /** The preview's surface and size, held so an engine opened after it mounts draws into it. */
        @Volatile
        private var preview: Triple<Surface, Int, Int>? = null

        private val engines = EngineOnce<PhoneStreamEngine>()

        /**
         * The process's engine, whose foreground work runs [PhoneStreamService]. Throws
         * [PhoneStreamUnavailable] when it could not be made.
         */
        fun engine(context: Context): PhoneStreamEngine =
            engines.get { PhoneStreamEngine.shared(context.applicationContext, PhoneStreamService.Work(context)) }

        /** The process's engine, or null when it could not be made. */
        fun engineOrNull(context: Context): PhoneStreamEngine? =
            engines.getOrNull { PhoneStreamEngine.shared(context.applicationContext, PhoneStreamService.Work(context)) }

        fun setPreview(context: Context, surface: Surface, width: Int, height: Int) {
            preview = Triple(surface, width, height)
            engineOrNull(context)?.attachPreview(surface, width, height)
        }

        fun clearPreview(context: Context, surface: Surface) {
            if (preview?.first !== surface) return
            preview = null
            engineOrNull(context)?.attachPreview(null, 0, 0)
        }
    }
}
