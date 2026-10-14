package app.teamstation.streamcore.capture

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.OutputConfiguration
import android.hardware.camera2.params.SessionConfiguration
import android.hardware.camera2.params.StreamConfigurationMap
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.view.Surface
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.CaptureFormatDescriptor
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.StreamSettings
import app.teamstation.streamcore.core.ZoomMapping
import app.teamstation.streamcore.gl.CaptureRenderer
import app.teamstation.streamcore.gl.ProgrammeTicker
import java.util.concurrent.Executor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Owns the `CameraDevice` and everything that has to be configured on it.
 *
 * All camera access is confined to one handler thread. Configuring on the main thread works but
 * stalls it for hundreds of milliseconds while the session is created, which on this app would land
 * exactly as the operator taps the flip button.
 *
 * The camera has exactly one output — the renderer's `SurfaceTexture`. Preview is a second GL
 * destination rather than a second camera stream, which is what keeps the operator's picture and
 * the encoder's picture the same picture, including the rotation.
 */
class CameraSession(private val context: Context) {

    data class State(
        val position: CameraPosition = CameraPosition.BACK,
        val deviceType: String = "",
        val mapping: ZoomMapping = ZoomMapping(maximumDeviceZoom = 1.0),
        val deviceZoom: Double = 1.0,
        val activeFormat: CaptureFormatDescriptor? = null,
        /**
         * Every format the current device offers, for the settings picker. Read from the device
         * rather than assumed, because the front and back cameras offer different sets and neither
         * matches what a hardcoded list would say.
         */
        val availableFormats: List<CaptureFormatDescriptor> = emptyList(),
        val isRunning: Boolean = false,
        val failure: String? = null,
        val isInterrupted: Boolean = false,
        val interruptionReason: String? = null,
        /**
         * 0° or 180° last applied to the rendered buffers. The preview uses the same value so the
         * operator frames what the encoder sends, including after a front-camera flip.
         */
        val captureRotationAngle: Double = 0.0,
        /** `SENSOR_ORIENTATION` for the open camera, so the dump can be read without a device. */
        val sensorOrientation: Int = 0,
        /** The display rotation last handed in, for the same reason. */
        val displayRotation: Int = 0
    ) {
        val displayedZoom: Double get() = mapping.displayedZoom(deviceZoom)
        val lensIndex: Int get() = mapping.lensIndex(deviceZoom)
    }

    private val thread = HandlerThread("cameraman-capture").apply { start() }

    /** The capture thread, for a test that checks [release] ends it. */
    internal val captureThread: Thread get() = thread
    private val handler = Handler(thread.looper)
    private val executor = Executor { runnable -> handler.post(runnable) }
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

    private var device: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var requestBuilder: CaptureRequest.Builder? = null
    private var renderer: CaptureRenderer? = null
    private var settings = StreamSettings.default
    private var state = State()
    private var cameraId: String? = null
    /**
     * The last display rotation handed in, kept because it arrives before the camera is open as
     * often as after. Dropping it when `cameraId` was still null is what left the rotation at its
     * default forever on a cold start.
     */
    private var pendingDisplayRotation = 0
    /**
     * The capture angle last chosen while the display was landscape. A portrait
     * display leaves it, so opening settings does not turn the encoded picture.
     */
    private var lastLandscapeCaptureAngle = 0
    /**
     * A measurement override, set from the control channel. The rule below is derived from what
     * this handset actually does; this is how that was found out, and it stays so the next handset
     * that disagrees can be measured rather than argued about.
     */
    private var rotationOverride: Int? = null
    private var lensCatalog: List<CameraLens> = emptyList()
    private var lensSelection = LensSelection()

    /** Configured and not closed: a camera lost meanwhile is opened again when it is free. */
    private var keepOpen = false
    private var watchingAvailability = false

    /**
     * Another app releasing the camera, or the camera service coming back, is when a lost camera can
     * be opened again. Registered with the first configure; called on the capture thread.
     */
    private val availability = object : CameraManager.AvailabilityCallback() {
        override fun onCameraAvailable(id: String) {
            if (id == cameraId) reopenIfLost(fromAvailability = true)
        }
    }

    /** When the camera was last asked to open again, on the boot clock in milliseconds. */
    private var lastReopenAt = Long.MIN_VALUE / 2
    /**
     * The hardware's own zoom range, before any lens selection narrowed it.
     *
     * Kept separately because the published mapping *is* the narrowed one, and deriving the next
     * clamp from it would make every change narrower than the last — turning a lens back on could
     * then never widen the range again.
     */
    private var hardwareMapping: ZoomMapping? = null

    /** Delivered on the main thread, because every consumer is UI. */
    var onStateChange: ((State) -> Unit)? = null

    /**
     * Fired when the rendered buffers are rotated. A client that has already decoded a GOP at the
     * previous angle otherwise shows the next frames inverted until a keyframe.
     */
    var onCaptureRotationChange: (() -> Unit)? = null

    /** One rendered frame reached the encoder's surface. */
    var onVideoFrame: (() -> Unit)? = null

    /**
     * Whether the frame captured at this many nanoseconds goes to the encoder. Every frame does
     * unless the test throttle says otherwise; the preview gets every frame either way.
     */
    @Volatile
    var deliversFrame: (Long) -> Boolean = { true }

    /** Blanking turned on or off, so the encoder can force the keyframe the transition needs. */
    var onBlankChanged: (() -> Unit)? = null

    /** The programme clock the encoders are drawn on; null draws them on each camera frame. */
    private var programme: ProgrammeTicker? = null

    /**
     * Whether the open camera stamps its frames on `elapsedRealtimeNanos`
     * (`SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME`), the clock the steady wall clock runs on. False means
     * the monotonic clock `System.nanoTime` reads.
     */
    @Volatile
    var sensorTimestampsAreRealtime: Boolean = true
        private set

    /**
     * Draws the encoders on [ticker]'s clock instead of on each camera frame: the phone's programme
     * tick, which sends the stream and the recording the latest picture thirty times a second.
     */
    fun setProgramme(ticker: ProgrammeTicker?) {
        handler.post {
            programme = ticker
            renderer?.setProgramme(ticker)
        }
    }

    /**
     * Blanks the encoded picture without stopping capture. The preview stays live: the operator can
     * still see that the camera is aimed correctly while it is deliberately off air.
     */
    fun setVideoEnabled(enabled: Boolean) {
        handler.post { renderer?.blankEncoder = !enabled }
    }

    fun currentState(): State = state

    /** The renderer's preview destination, attached by the preview view when it has a surface. */
    fun attachPreview(surface: Surface?, width: Int, height: Int) {
        handler.post { renderer?.attachPreview(surface, width, height) }
    }

    /**
     * Points the renderer at an encoder's input surface, under [key]. Every attached encoder gets
     * every frame: Cameraman attaches one, a phone streaming and recording attaches two.
     *
     * Called again after every encoder reconfigure, because `createInputSurface` returns a new
     * object each time and the old one is dead the moment the codec is released.
     */
    fun attachEncoder(key: String, surface: Surface?) {
        handler.post { renderer?.attachEncoder(key, surface) }
    }

    /** Stops feeding the encoder attached under [key]; the others carry on. */
    fun detachEncoder(key: String) {
        handler.post { renderer?.detachEncoder(key) }
    }

    fun configure(position: CameraPosition, settings: StreamSettings) {
        handler.post {
            keepOpen = true
            if (!watchingAvailability) {
                watchingAvailability = true
                runCatching { manager.registerAvailabilityCallback(availability, handler) }
            }
            this.settings = settings
            lensSelection = LensSelection(settings.disabledLensIDs)
            applyDevice(position)
        }
    }

    /**
     * The lenses this handset has, for the settings list. Empty until a camera has been configured.
     */
    fun lensCatalog(): List<CameraLens> = lensCatalog

    /** Applies a new lens selection without otherwise reconfiguring capture. */
    fun setLensSelection(selection: LensSelection) {
        handler.post {
            lensSelection = selection
            applyLensBounds()
        }
    }

    fun start() {
        handler.post { startRepeating() }
    }

    fun stop() {
        handler.post {
            runCatching { session?.stopRepeating() }
            publish(state.copy(isRunning = false))
        }
    }

    /**
     * Opens the camera again if it was lost (disconnected, or failed) while it is meant to be open. A camera that is
     * running, or was closed, is left as it is.
     */
    fun reopen() {
        handler.post { reopenIfLost(fromAvailability = false) }
    }

    /**
     * Opens a lost camera again. One the system says is free is opened at most every
     * [reopenSpacingMillis], so a camera that fails as it opens, and is then free again, is not
     * opened in a tight loop; the owner's own tries ([reopen]) are spaced by the owner.
     */
    private fun reopenIfLost(fromAvailability: Boolean) {
        if (!keepOpen || state.isRunning || !(state.isInterrupted || state.failure != null)) return
        val now = android.os.SystemClock.elapsedRealtime()
        if (fromAvailability && now - lastReopenAt < reopenSpacingMillis) return
        lastReopenAt = now
        applyDevice(state.position)
    }

    fun close() {
        handler.post { closeNow() }
    }

    /**
     * Closes the camera and ends the capture thread, for an owner that makes a new session each time
     * (the phone's streaming screen): one that only closed left a thread behind on every visit.
     */
    fun release() {
        handler.post {
            closeNow()
            runCatching { manager.unregisterAvailabilityCallback(availability) }
            thread.quitSafely()
        }
    }

    private fun closeNow() {
        keepOpen = false
        runCatching { session?.close() }
        session = null
        runCatching { device?.close() }
        device = null
        renderer?.release()
        renderer = null
        publish(state.copy(isRunning = false))
    }

    fun flip() {
        handler.post {
            applyDevice(
                if (state.position == CameraPosition.BACK) CameraPosition.FRONT
                else CameraPosition.BACK
            )
        }
    }

    /**
     * Sets zoom in device units. Clamped to the mapping, which caps the digital range rather than
     * exposing the whole of `CONTROL_ZOOM_RATIO_RANGE`.
     */
    fun setDeviceZoom(value: Double) {
        handler.post { applyZoom(value) }
    }

    fun setDisplayedZoom(value: Double) {
        handler.post { applyZoom(state.mapping.deviceZoom(value)) }
    }

    /**
     * The 0°/180° the sensor did not do.
     *
     * The iOS build reads this off `RotationCoordinator`; Camera2 publishes no equivalent, so it is
     * computed the standard way from the sensor orientation and the display rotation. Portrait
     * angles would turn 1920x1080 into portrait, which this app does not send, so they are ignored
     * and the last landscape angle stands — the same rule the iOS build applies to the coordinator's
     * portrait readings.
     */
    fun setDisplayRotation(surfaceRotationDegrees: Int) {
        handler.post {
            pendingDisplayRotation = surfaceRotationDegrees
            applyCaptureRotation()
        }
    }

    /** Forces a capture rotation, for measuring what this handset actually needs. */
    fun overrideCaptureRotation(degrees: Int?) {
        handler.post {
            rotationOverride = degrees?.let { ((it % 360) + 360) % 360 }
            applyCaptureRotation()
        }
    }

    private fun applyCaptureRotation() {
        val id = cameraId ?: return
        val characteristics = runCatching { manager.getCameraCharacteristics(id) }.getOrNull()
            ?: return
        val sensor = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
        val facing = characteristics.get(CameraCharacteristics.LENS_FACING)
        val computed = captureRotation(
            sensorOrientation = sensor,
            displayRotation = pendingDisplayRotation,
            isFront = facing == CameraMetadata.LENS_FACING_FRONT
        )
        if (rotationOverride == null && displayIsLandscape(pendingDisplayRotation)) {
            lastLandscapeCaptureAngle = computed
        }
        val proposed = rotationOverride ?: appliedCaptureAngle(
            computed = computed,
            displayRotation = pendingDisplayRotation,
            lastLandscape = lastLandscapeCaptureAngle
        )

        val isFront = facing == CameraMetadata.LENS_FACING_FRONT
        val renderer = this.renderer
        if (renderer != null &&
            (renderer.rotationDegrees != proposed || renderer.mirrorHorizontally != isFront)
        ) {
            renderer.rotationDegrees = proposed
            renderer.mirrorHorizontally = isFront
            onCaptureRotationChange?.invoke()
        }
        if (state.captureRotationAngle != proposed.toDouble() ||
            state.sensorOrientation != sensor ||
            state.displayRotation != pendingDisplayRotation
        ) {
            publish(
                state.copy(
                    captureRotationAngle = proposed.toDouble(),
                    sensorOrientation = sensor,
                    displayRotation = pendingDisplayRotation
                )
            )
        }
    }

    // MARK: - Configuration

    @SuppressLint("MissingPermission")
    private fun applyDevice(position: CameraPosition) {
        val id = preferredCameraId(position)
        if (id == null) {
            publish(state.copy(failure = "no camera available for ${position.rawValue}"))
            return
        }

        runCatching { session?.close() }
        session = null
        runCatching { device?.close() }
        device = null

        val characteristics = runCatching { manager.getCameraCharacteristics(id) }.getOrNull()
        if (characteristics == null) {
            publish(state.copy(failure = "could not read characteristics for camera $id"))
            return
        }

        sensorTimestampsAreRealtime = characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) ==
            CameraMetadata.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        val descriptors = descriptors(characteristics)
        val catalogue = FormatCatalogue(descriptors)
        val wanted = catalogue.selection(settings.width, settings.height, settings.frameRate)
        val mapping = mapping(manager, characteristics)
        hardwareMapping = mapping

        cameraId = id
        if (lensCatalog.isEmpty()) {
            lensCatalog = runCatching { LensDiscovery.discover(manager) }.getOrDefault(emptyList())
        }
        publish(
            state.copy(
                position = position,
                deviceType = deviceTypeName(characteristics, id),
                availableFormats = descriptors,
                activeFormat = wanted,
                mapping = mapping.extendedBySoftwareZoom(),
                // A failure stands until the repeating request runs ([startRepeating]): cleared here,
                // a camera lost and opening again read as back before it was, and one whose open
                // never called back could not be asked to open again.
                // Start at the wide lens rather than the ultra-wide: 1x is what an operator
                // pointing a phone at a field expects to see, and 0.5x on a multi-lens camera is a
                // noticeably distorted framing.
                deviceZoom = mapping.clampDeviceZoom(mapping.deviceZoom(settings.displayedZoom))
            )
        )
        applyLensBounds()

        if (renderer == null) {
            renderer = try {
                CaptureRenderer(settings.width, settings.height) { onVideoFrame?.invoke() }
                    .also { created ->
                        created.deliverToEncoder = { deliversFrame(it) }
                        created.blankEncoder = !settings.videoEnabled
                        created.onBlankChanged = { onBlankChanged?.invoke() }
                        programme?.let(created::setProgramme)
                    }
            } catch (error: Exception) {
                publish(state.copy(failure = "could not start the renderer: ${error.message}"))
                return
            }
        }

        // After the renderer exists, not before: a rotation applied to a null renderer is published
        // to the state dump and dropped on the floor, so the dump reads correct while the buffers
        // keep the default. The activity's bind used to hide this by re-applying moments later —
        // but the service is meant to run without an activity at all.
        applyCaptureRotation()

        try {
            manager.openCamera(id, executor, deviceCallback)
        } catch (error: Exception) {
            publish(state.copy(failure = "could not open camera $id: ${error.message}"))
        }
    }

    private val deviceCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            device = camera
            createSession(camera)
        }

        override fun onDisconnected(camera: CameraDevice) {
            // Another app took the camera, or the device was unplugged. This is the counterpart of
            // AVCaptureSession's `wasInterrupted`, and the soak has to see it as a first-class fault
            // rather than as a silent `isRunning`.
            runCatching { camera.close() }
            if (device === camera) device = null
            publish(
                state.copy(
                    isRunning = false,
                    isInterrupted = true,
                    interruptionReason = "videoInUse"
                )
            )
        }

        override fun onError(camera: CameraDevice, error: Int) {
            runCatching { camera.close() }
            if (device === camera) device = null
            publish(
                state.copy(
                    isRunning = false,
                    failure = "cameraError ${errorName(error)}"
                )
            )
        }
    }

    private fun createSession(camera: CameraDevice) {
        val renderer = this.renderer ?: return
        val output = OutputConfiguration(renderer.cameraSurface)
        val configuration = SessionConfiguration(
            SessionConfiguration.SESSION_REGULAR,
            listOf(output),
            executor,
            object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(configured: CameraCaptureSession) {
                    session = configured
                    startRepeating()
                }

                override fun onConfigureFailed(configured: CameraCaptureSession) {
                    publish(state.copy(failure = "could not configure the capture session"))
                }
            }
        )
        try {
            camera.createCaptureSession(configuration)
        } catch (error: Exception) {
            publish(state.copy(failure = "could not create a capture session: ${error.message}"))
        }
    }

    private fun startRepeating() {
        val camera = device ?: return
        val configured = session ?: return
        val renderer = this.renderer ?: return

        val builder = try {
            camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                addTarget(renderer.cameraSurface)
                // Pinning both ends holds the frame rate steady. Leaving the minimum open lets the
                // device drop to 15 fps in low light, which reads on the wire as a stalled camera.
                val rate = settings.frameRate.roundToInt()
                set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, Range(rate, rate))
                set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
                set(
                    CaptureRequest.CONTROL_AF_MODE,
                    CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO
                )
                // Stabilisation off: it crops and it adds a frame of latency, and a camera on a
                // tripod has nothing to stabilise.
                set(
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                    CameraMetadata.CONTROL_VIDEO_STABILIZATION_MODE_OFF
                )
                val (ratio, software) = state.mapping.cameraAndSoftwareZoom(state.deviceZoom)
                set(CaptureRequest.CONTROL_ZOOM_RATIO, ratio.toFloat())
                renderer.digitalZoom = software.toFloat()
            }
        } catch (error: Exception) {
            publish(state.copy(failure = "could not build a capture request: ${error.message}"))
            return
        }

        requestBuilder = builder
        try {
            configured.setRepeatingRequest(builder.build(), null, handler)
            publish(state.copy(isRunning = true, isInterrupted = false, interruptionReason = null, failure = null))
        } catch (error: Exception) {
            publish(state.copy(failure = "could not start capture: ${error.message}"))
        }
    }

    /**
     * Narrows the zoom range to the lenses the operator left on.
     *
     * A logical camera picks its lens from the zoom ratio, so clamping the range is how a disabled
     * lens is actually kept out of shot — see `LensSelection` for why this is the only mechanism
     * Camera2 offers. The current zoom is pulled inside the new bounds, because leaving it outside
     * would keep using the lens that was just turned off.
     *
     * The clamp is where the camera stops, not where zoom stops: Cameraman's software zoom carries
     * on past it on the lens that is still on, so choosing one lens never pins a single framing.
     */
    private fun applyLensBounds() {
        val bounds = lensSelection.zoomBounds(state.position, lensCatalog) ?: return
        val base = hardwareMapping ?: state.mapping
        val minimum = bounds.minimumDisplayedZoom?.let { base.deviceZoom(it) }
            ?: base.minimumDeviceZoom
        val maximum = bounds.maximumDisplayedZoom?.let { base.deviceZoom(it) }
            ?: base.maximumDeviceZoom

        val narrowed = ZoomMapping(
            minimumDeviceZoom = minimum,
            maximumDeviceZoom = maxOf(maximum, minimum),
            displayMultiplier = base.displayMultiplier,
            switchOverDeviceZooms = base.switchOverDeviceZooms
        ).extendedBySoftwareZoom()
        publish(state.copy(mapping = narrowed))
        applyZoom(narrowed.clampDeviceZoom(state.deviceZoom))
    }

    private fun applyZoom(value: Double) {
        val clamped = state.mapping.clampDeviceZoom(value)
        // Past the camera's ceiling the camera holds there and the renderer crops the rest.
        val (ratio, software) = state.mapping.cameraAndSoftwareZoom(clamped)
        renderer?.digitalZoom = software.toFloat()
        val builder = requestBuilder
        val configured = session
        if (builder != null && configured != null) {
            builder.set(CaptureRequest.CONTROL_ZOOM_RATIO, ratio.toFloat())
            runCatching { configured.setRepeatingRequest(builder.build(), null, handler) }
        }
        publish(state.copy(deviceZoom = clamped))
    }

    private fun publish(next: State) {
        state = next
        val callback = onStateChange ?: return
        android.os.Handler(android.os.Looper.getMainLooper()).post { callback(next) }
    }

    companion object {
        /** The least time between two reopens the camera's availability starts. */
        const val reopenSpacingMillis = 2_000L

        /**
         * Every format the device offers, reduced to what the picker and the catalogue need.
         *
         * The maximum frame rate is read per size from `getOutputMinFrameDuration`, not from the
         * device's AE ranges: those are device-wide and would claim 60 fps for a 4K size that can
         * only do 30, which the settings picker would then offer and the session would then refuse.
         */
        fun descriptors(characteristics: CameraCharacteristics): List<CaptureFormatDescriptor> {
            val map = characteristics.get(
                CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP
            ) ?: return emptyList()
            val isLogical = physicalIds(characteristics).size > 1

            val minimumRate = (
                characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
                    ?.minOfOrNull { it.lower } ?: 1
                ).toDouble()

            val regular = map.getOutputSizes(SurfaceTexture::class.java).orEmpty().map { size ->
                val minDuration = map.getOutputMinFrameDuration(
                    SurfaceTexture::class.java, size
                )
                val maximumRate = if (minDuration > 0) 1_000_000_000.0 / minDuration else 30.0
                CaptureFormatDescriptor(
                    width = size.width,
                    height = size.height,
                    minimumFrameRate = min(minimumRate, maximumRate),
                    maximumFrameRate = maximumRate,
                    supportsMultiLensSwitching = isLogical,
                    isBinned = false
                )
            }

            // High-speed (slow-motion) configurations are Android's equivalent of the iOS formats
            // that lose multi-lens switching: they bind a single physical sensor and the logical
            // camera stops handing over. Offering them without saying so would remove the app's
            // headline feature on a menu selection.
            val highSpeed = highSpeedDescriptors(map)

            return (regular + highSpeed).distinct()
        }

        private fun highSpeedDescriptors(map: StreamConfigurationMap): List<CaptureFormatDescriptor> =
            runCatching {
                map.highSpeedVideoSizes.orEmpty().flatMap { size ->
                    map.getHighSpeedVideoFpsRangesFor(size).orEmpty().map { range ->
                        CaptureFormatDescriptor(
                            width = size.width,
                            height = size.height,
                            minimumFrameRate = range.lower.toDouble(),
                            maximumFrameRate = range.upper.toDouble(),
                            supportsMultiLensSwitching = false,
                            isBinned = false
                        )
                    }
                }
            }.getOrDefault(emptyList())

        fun physicalIds(characteristics: CameraCharacteristics): Set<String> =
            runCatching { characteristics.physicalCameraIds }.getOrDefault(emptySet())

        /**
         * The zoom mapping, derived from the hardware.
         *
         * `CONTROL_ZOOM_RATIO_RANGE` gives the ends directly and in the units an operator reads, so
         * unlike iOS there is no display multiplier to apply. What Android does *not* publish is
         * `virtualDeviceSwitchOverVideoZoomFactors` — there is no API that says at which zoom the
         * logical camera hands over to the next lens. So it is computed from the constituent
         * physical cameras:
         *
         * 1. Each physical camera's 35mm-equivalent focal length is `focal * 36 / sensorWidth`.
         * 2. The widest of them is active at the bottom of the zoom range, by definition.
         * 3. So the zoom at which any other lens takes over is `zoomMin * equivalent / widest`.
         *
         * That is a reading of the optics rather than a guess, and it lands on 1x for the main lens
         * and on the marketing number for a telephoto. Where a device exposes no physical cameras —
         * every front camera — the list is empty and the scale is two pills, which is exactly what
         * the iOS build produces for the same hardware.
         */
        fun mapping(manager: CameraManager, characteristics: CameraCharacteristics): ZoomMapping {
            val range = characteristics.get(
                CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE
            )
            val minimum = range?.lower?.toDouble() ?: 1.0
            val available = range?.upper?.toDouble() ?: 1.0
            val switchOvers = switchOverZooms(manager, characteristics, minimum)

            // A multi-lens camera earns headroom past its longest real lens; a single-lens one gets
            // the same fallback the iOS build gives it.
            val ceiling = if (switchOvers.isEmpty()) {
                ZoomMapping.resolveMaximumDeviceZoom(recommended = null, available = available)
            } else {
                min(available, switchOvers.max() * ZoomMapping.multiLensDigitalHeadroom)
            }

            return ZoomMapping(
                minimumDeviceZoom = minimum,
                maximumDeviceZoom = max(ceiling, minimum),
                // Android's zoom ratio is already what the operator reads; see ZoomMapping.
                displayMultiplier = 1.0,
                switchOverDeviceZooms = switchOvers
            )
        }

        private fun switchOverZooms(
            manager: CameraManager,
            characteristics: CameraCharacteristics,
            minimumZoom: Double
        ): List<Double> {
            val ids = physicalIds(characteristics)
            if (ids.size < 2) return emptyList()

            val equivalents = ids.mapNotNull { equivalentFocalLength(manager, it) }
            if (equivalents.size < 2) return emptyList()

            val widest = equivalents.min()
            if (widest <= 0) return emptyList()
            return equivalents
                .map { minimumZoom * it / widest }
                .filter { it > minimumZoom + 0.01 }
                .sorted()
        }

        private fun equivalentFocalLength(
            manager: CameraManager,
            physicalId: String
        ): Double? = runCatching {
            // A physical camera id is not in `cameraIdList` — it cannot be opened on its own — but
            // its characteristics are still readable through the manager, which is the only way to
            // learn its focal length.
            val physical = manager.getCameraCharacteristics(physicalId)
            val focal = physical.get(
                CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS
            )?.maxOrNull()?.toDouble() ?: return null
            val sensorWidth = physical.get(
                CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE
            )?.width?.toDouble() ?: return null
            if (sensorWidth <= 0) return null
            // 36 mm is the width of a full frame, which is what "35mm equivalent" is measured
            // against. Only the ratios between lenses matter here, so the constant cancels.
            focal * 36.0 / sensorWidth
        }.getOrNull()

        /**
         * Widest logical device first, so the app gets every lens the handset has and degrades to
         * fewer — the same preference order the iOS build applies to triple, dual-wide, dual and
         * wide-angle devices.
         */
        fun preferredCameraId(manager: CameraManager, position: CameraPosition): String? {
            val facing = if (position == CameraPosition.BACK) {
                CameraMetadata.LENS_FACING_BACK
            } else {
                CameraMetadata.LENS_FACING_FRONT
            }
            val ids = runCatching { manager.cameraIdList.toList() }.getOrDefault(emptyList())
            val matching = ids.mapNotNull { id ->
                val characteristics = runCatching {
                    manager.getCameraCharacteristics(id)
                }.getOrNull() ?: return@mapNotNull null
                if (characteristics.get(CameraCharacteristics.LENS_FACING) != facing) return@mapNotNull null
                id to characteristics
            }
            // Most constituent lenses wins; among equals, the one whose zoom range reaches widest.
            return matching.maxWithOrNull(
                compareBy(
                    { physicalIds(it.second).size },
                    {
                        val range = it.second.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)
                        val span = if (range != null) {
                            range.upper.toDouble() / max(range.lower.toDouble(), 0.01)
                        } else {
                            1.0
                        }
                        span
                    }
                )
            )?.first
        }

        /**
         * The rotation the rendered buffers need, in degrees counter-clockwise.
         *
         * Derived, not copied. The textbook formula for a *preview* is
         * `(sensor - displayRotation)` for a back camera, but that answers a different question:
         * it corrects an image for a view whose coordinate system the window manager has already
         * rotated. The encoder's surface is a plain landscape buffer in no one's coordinate system.
         * The camera view is held landscape, so the rotations that change the picture are 90 and
         * 270, and a portrait reading is not applied. The textbook answer comes out 90 degrees
         * short of what those landscape holds need.
         *
         * Measured on a Pixel 10 (sensor 90, window ROTATION_90, phone held landscape) on
         * 2026-09-05: the encoded frame needed a further quarter turn, and 0 left the stopwatch on
         * its side. See docs/capabilities.md for the frames that settled it.
         *
         * Front and back come out at the same angle in the same hold, which looks wrong and is not:
         * the 180 degrees between a front sensor's 270 and a back sensor's 90 is exactly cancelled
         * by the sign flip. What actually separates them is the mirror, and that is handled by
         * `CaptureRenderer.mirrorHorizontally` rather than by pretending it is a rotation.
         */
        fun captureRotation(sensorOrientation: Int, displayRotation: Int, isFront: Boolean): Int {
            val base = if (isFront) {
                (sensorOrientation + displayRotation) % 360
            } else {
                (sensorOrientation - displayRotation + 360) % 360
            }
            // The quarter turn between a window-relative correction and a buffer-relative one.
            return (base + 90) % 360
        }

        /** 90° and 270° are the two landscape holds. 0° and 180° are portrait. */
        fun displayIsLandscape(displayRotation: Int): Boolean {
            val normalized = ((displayRotation % 360) + 360) % 360
            return normalized == 90 || normalized == 270
        }

        /**
         * The angle the buffers keep. A landscape display takes the angle just
         * computed for it. A portrait display leaves the last landscape angle,
         * so the 1920×1080 picture does not turn while settings is up.
         */
        fun appliedCaptureAngle(computed: Int, displayRotation: Int, lastLandscape: Int): Int =
            if (displayIsLandscape(displayRotation)) computed else lastLandscape

        /** Named for the state dump rather than for Camera2, so a soak log stays readable. */
        fun deviceTypeName(characteristics: CameraCharacteristics, id: String): String {
            val count = physicalIds(characteristics).size
            return when {
                count >= 3 -> "builtInTripleCamera"
                count == 2 -> "builtInDualWideCamera"
                else -> "builtInWideAngleCamera"
            } + " ($id)"
        }

        fun errorName(error: Int): String = when (error) {
            CameraDevice.StateCallback.ERROR_CAMERA_IN_USE -> "inUse"
            CameraDevice.StateCallback.ERROR_MAX_CAMERAS_IN_USE -> "maxCamerasInUse"
            CameraDevice.StateCallback.ERROR_CAMERA_DISABLED -> "disabledByPolicy"
            CameraDevice.StateCallback.ERROR_CAMERA_DEVICE -> "deviceFatal"
            CameraDevice.StateCallback.ERROR_CAMERA_SERVICE -> "serviceFatal"
            else -> "unknown($error)"
        }
    }

    private fun preferredCameraId(position: CameraPosition): String? =
        preferredCameraId(manager, position)
}
