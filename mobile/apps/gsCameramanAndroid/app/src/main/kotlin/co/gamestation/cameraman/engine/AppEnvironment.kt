package co.gamestation.cameraman.engine

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import android.view.Surface
import co.gamestation.cameraman.capture.CameraSession
import co.gamestation.cameraman.capture.FormatCatalogue
import co.gamestation.cameraman.capture.MicrophoneSource
import co.gamestation.cameraman.capture.SilenceSource
import co.gamestation.cameraman.core.BatteryStatus
import co.gamestation.cameraman.core.CameraLens
import co.gamestation.cameraman.core.CameraParameters
import co.gamestation.cameraman.core.CameraPosition
import co.gamestation.cameraman.core.CameraSnapshot
import co.gamestation.cameraman.core.CaptureFormatDescriptor
import co.gamestation.cameraman.core.DeviceIdentity
import co.gamestation.cameraman.core.DeviceIdentityProvider
import co.gamestation.cameraman.core.IdentityStore
import co.gamestation.cameraman.core.InMemoryIdentityStore
import co.gamestation.cameraman.core.LensSelection
import co.gamestation.cameraman.core.ParameterOutcome
import co.gamestation.cameraman.core.PreferencesIdentityStore
import co.gamestation.cameraman.core.PreferencesSettingsStore
import co.gamestation.cameraman.core.SettingsStore
import co.gamestation.cameraman.core.StreamSettingsStore
import co.gamestation.cameraman.core.ProcessLoad
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.core.StreamSettings
import co.gamestation.cameraman.core.ThermalBadgeLevel
import co.gamestation.cameraman.encode.AudioEncoder
import co.gamestation.cameraman.encode.VideoEncoder
import co.gamestation.cameraman.harness.AudioStreamRecorder
import co.gamestation.cameraman.harness.ControlChannel
import co.gamestation.cameraman.harness.ControlCommand
import co.gamestation.cameraman.harness.ControlServer
import co.gamestation.cameraman.harness.ElementaryStreamRecorder
import co.gamestation.cameraman.harness.LaunchConfiguration
import co.gamestation.cameraman.harness.SyntheticCamera
import co.gamestation.cameraman.rtsp.RTSPResponder
import co.gamestation.cameraman.rtsp.RTSPServer
import co.gamestation.cameraman.rtsp.SDPBuilder
import co.gamestation.cameraman.rtsp.SendDelayLine
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.math.roundToInt

/**
 * Wiring for the whole app.
 *
 * The one structural difference from the iOS build, and it is the reason this port exists: on iOS
 * this is owned by the SwiftUI `App` and dies with it, because iOS suspends a backgrounded app and
 * there is nothing to be done about it. Here it is owned by [co.gamestation.cameraman.service.CameramanService],
 * a foreground service, and the activity is only a window onto it. Close the activity, lock the
 * screen, switch apps — the camera keeps capturing and the listener keeps serving, because nothing
 * that matters lives in the activity.
 */
class AppEnvironment(
    private val context: Context,
    val launch: LaunchConfiguration = LaunchConfiguration(),
    store: IdentityStore? = null,
    settingsStore: SettingsStore? = null
) {
    val camera = CameraSession(context)
    val videoEncoder = VideoEncoder()
    val audioEncoder = AudioEncoder()
    private val microphone = MicrophoneSource(audioEncoder)
    private val silence = SilenceSource(audioEncoder)
    private val settingsPersistence: StreamSettingsStore

    private val identityProvider: DeviceIdentityProvider
    private var server: RTSPServer? = null

    /**
     * Lowers the encoder's rate while the link to a client backs up. Null until the server exists,
     * since the server is where the link is measured.
     */
    private var adaptiveBitrate: co.gamestation.cameraman.rtsp.AdaptiveBitrateLoop? = null
    private var controlServer: ControlServer? = null
    private var synthetic: SyntheticCamera? = null
    private var recorder: ElementaryStreamRecorder? = null
    private var audioRecorder: AudioStreamRecorder? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    /**
     * Test-only congestion injection. Idle unless a flow configures it, in which case it holds
     * outgoing frames back without touching the capture times they carry.
     */
    val sendDelay = SendDelayLine()

    /** The same, for the audio only. See `ControlCommand.SetAudioDelay`. */
    val audioSendDelay = SendDelayLine()

    private val scope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate
    )
    private var thermalPreviewJob: kotlinx.coroutines.Job? = null

    private val stateLock = ReentrantLock()

    /**
     * One remote write at a time. Each RTSP connection answers on its own thread, and two
     * `SET_PARAMETER`s racing through `applySettings` would reconfigure the encoder twice from
     * two half-merged settings. Reads take no lock: a poll must never wait out a reconfigure.
     */
    private val parameterWriteLock = ReentrantLock()

    /**
     * The parameter sets arrive with the first keyframe, and a client may DESCRIBE before then, so
     * the latest ones are kept for the SDP rather than read out of the encoder on demand.
     */
    private var latestParameterSets: List<ByteArray> = emptyList()

    /**
     * DESCRIBE and RTCP read these rather than the values captured at `startServer`, so a rename or
     * a codec change is visible to the next client without tearing the listener down.
     */
    private var publishedIdentity: DeviceIdentity
    private var publishedSettings: StreamSettings

    /**
     * The settings last pushed into the encoder and capture session. Compared on apply so Done after
     * a no-op visit to Settings does not restart anything.
     */
    private var appliedSettings: StreamSettings

    // Frames in and frames out. Held off the state flows so a 30 fps bump does not recompose;
    // dump-state reads these, the UI does not.
    private val capturedFrameCount = AtomicInteger(0)
    private val encodedFrameCount = AtomicInteger(0)

    private val identityState: MutableStateFlow<DeviceIdentity>
    private val settingsState: MutableStateFlow<StreamSettings>
    private val cameraStateFlow = MutableStateFlow(CameraSession.State())
    private val statusState = MutableStateFlow("starting")
    private val encodeFailureState = MutableStateFlow<String?>(null)
    private val serverStatusState = MutableStateFlow(RTSPServer.Status())
    private val permissionState = MutableStateFlow(Permissions())
    private val thermalLevelState = MutableStateFlow(ThermalBadgeLevel.COOL)
    private val lensCatalogState = MutableStateFlow<List<CameraLens>>(emptyList())
    private val batteryState = MutableStateFlow<BatteryStatus?>(null)
    private var batteryReceiver: BroadcastReceiver? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    data class Permissions(
        val camera: Boolean = false,
        val microphone: Boolean = false,
        val notifications: Boolean = false
    )

    val identity: StateFlow<DeviceIdentity>
    val settings: StateFlow<StreamSettings>
    val cameraState: StateFlow<CameraSession.State> = cameraStateFlow.asStateFlow()
    val status: StateFlow<String> = statusState.asStateFlow()
    val encodeFailure: StateFlow<String?> = encodeFailureState.asStateFlow()
    val serverStatus: StateFlow<RTSPServer.Status> = serverStatusState.asStateFlow()
    val permissions: StateFlow<Permissions> = permissionState.asStateFlow()

    /** What the overlay pills show. Both are chrome, and both are also in the state dump. */
    val thermalLevel: StateFlow<ThermalBadgeLevel> = thermalLevelState.asStateFlow()

    /** Null where there is no battery to read — an emulator — in which case no pill is drawn. */
    val battery: StateFlow<BatteryStatus?> = batteryState.asStateFlow()

    /** The lenses this handset has, one settings row each. Empty until capture has opened a camera. */
    val lensCatalog: StateFlow<List<CameraLens>> = lensCatalogState.asStateFlow()

    /**
     * Whether the chrome should animate. Off under `uiTest`, because an animation that never settles
     * makes Maestro wait out its idling timeout on every assertion.
     */
    val animatesChrome: Boolean get() = !launch.isUITest

    val capturedFrames: Int get() = capturedFrameCount.get()
    val encodedFrames: Int get() = encodedFrameCount.get()

    init {
        // A pinned UUID lets a flow assert an exact CNAME. Otherwise the stored copy is
        // authoritative so the identity survives an app update and a reboot.
        val resolvedStore: IdentityStore = store
            ?: launch.identityUUID?.let {
                InMemoryIdentityStore(mapOf(DeviceIdentityProvider.uuidKey to it))
            }
            ?: PreferencesIdentityStore(context)

        // Only a real install has an install to derive the first UUID from.
        val seed = if (resolvedStore is PreferencesIdentityStore) {
            PreferencesIdentityStore.installSeed(context)
        } else {
            null
        }
        val provider = DeviceIdentityProvider(resolvedStore, seed)
        identityProvider = provider
        var loaded = provider.load()
        launch.cameraName?.let { loaded = provider.save(it) }

        settingsPersistence = StreamSettingsStore(
            settingsStore ?: PreferencesSettingsStore(context)
        )
        // What the operator last chose, laid under whatever this launch named outright. A camera on
        // a tripod is aimed once: coming back at the wrong lens or the wrong zoom after a restart
        // silently changes the shot, and nobody is standing there to notice.
        val initial = if (launch.persistSettings) {
            settingsPersistence.load()
                ?.let { launch.settings.merging(saved = it, explicit = launch.providedSettingFields) }
                ?: launch.settings.copy()
        } else {
            launch.settings.copy()
        }

        identityState = MutableStateFlow(loaded)
        settingsState = MutableStateFlow(initial)
        identity = identityState.asStateFlow()
        settings = settingsState.asStateFlow()

        publishedIdentity = loaded
        publishedSettings = initial.copy()
        appliedSettings = initial.copy()
    }

    /**
     * Forces the thermal pill to [level] for a few seconds, then lets the live reading take over.
     *
     * A pill that only appears when a phone is genuinely hot cannot be checked before a match, and
     * "wait for it to overheat" is not a test step.
     */
    fun previewThermal(level: ThermalBadgeLevel, seconds: Long = 6) {
        thermalPreviewJob?.cancel()
        thermalLevelState.value = level
        thermalPreviewJob = scope.launch {
            kotlinx.coroutines.delay(seconds * 1000)
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            thermalLevelState.value = power
                ?.let { ThermalBadgeLevel.fromThermalStatus(it.currentThermalStatus) }
                ?: ThermalBadgeLevel.COOL
        }
    }

    fun setPermissions(camera: Boolean, microphone: Boolean, notifications: Boolean) {
        permissionState.value = Permissions(camera, microphone, notifications)
    }

    fun rename(name: String) {
        val next = identityProvider.save(name)
        identityState.value = next
        stateLock.withLock { publishedIdentity = next }
        server?.refreshAdvertisement()
    }

    fun updateSettings(next: StreamSettings) {
        settingsState.value = next.copy()
        persist()
    }

    /**
     * Writes the current settings, when this launch takes part in persistence.
     *
     * Called on every change rather than on the way out: a camera killed by the system — which is
     * the normal end of a long run — never gets a chance to save on exit.
     */
    private fun persist() {
        if (!launch.persistSettings) return
        settingsPersistence.save(settingsState.value)
    }

    /**
     * The formats this camera actually offers, for the settings picker. Empty until capture has
     * configured a device.
     */
    val formatOptions: List<FormatCatalogue.Option>
        get() = FormatCatalogue(cameraStateFlow.value.availableFormats).options

    /**
     * Where a client should point. The bound port rather than the requested one, because the
     * fallback is exactly the case where the operator needs to be told — and on Android the
     * fallback is not an edge case, it is what always happens.
     */
    val streamURL: String
        get() {
            val host = RTSPServer.lanIPv4() ?: "0.0.0.0"
            val port = serverStatusState.value.port ?: settingsState.value.port
            return "rtsp://$host:$port${settingsState.value.path}"
        }

    /**
     * Pushes edited settings into the pieces that care. Called once when the settings sheet closes
     * rather than on each change, so a drag along the bitrate slider does not reconfigure the
     * encoder fifty times. A visit that changed nothing is a no-op, so the stream is not cut by
     * opening Settings to copy the URL.
     */
    fun applySettings() {
        val next = settingsState.value.copy()
        stateLock.withLock { publishedSettings = next }
        val previous = appliedSettings

        // Lenses and blanking are applied whatever else changed: neither is a pipeline setting, and
        // both are invisible until the camera is told. A lens toggled in Settings that never reached
        // capture is the whole feature quietly doing nothing.
        if (next.disabledLensIDs != previous.disabledLensIDs) {
            camera.setLensSelection(LensSelection(next.disabledLensIDs))
        }
        if (next.videoEnabled != previous.videoEnabled) {
            camera.setVideoEnabled(next.videoEnabled)
        }

        val pipelineChanged = next.codec != previous.codec ||
            next.width != previous.width ||
            next.height != previous.height ||
            next.frameRate != previous.frameRate ||
            next.bitrate != previous.bitrate ||
            next.bitrateFloor != previous.bitrateFloor ||
            next.adaptiveBitrate != previous.adaptiveBitrate ||
            next.audioEnabled != previous.audioEnabled ||
            next.audioSampleRate != previous.audioSampleRate
        if (!pipelineChanged) {
            appliedSettings = next
            return
        }
        appliedSettings = next

        // A rate-only change — the bitrate, or adaptation on or off — is a live parameter, not a
        // reconfigure. Restarting the encoder for it would drop a GOP and make every watching client
        // re-buffer.
        val onlyBitrateChanged = next.codec == previous.codec &&
            next.width == previous.width &&
            next.height == previous.height &&
            next.frameRate == previous.frameRate &&
            next.audioEnabled == previous.audioEnabled &&
            next.audioSampleRate == previous.audioSampleRate
        if (onlyBitrateChanged) {
            applyRate(next)
            return
        }

        configureVideoEncoder(next)
        applyAudio(next)
        if (!launch.useSyntheticCamera) {
            camera.configure(cameraStateFlow.value.position, next)
        }
    }

    // MARK: - Lifecycle

    fun start() {
        acquireWakeLock()
        acquireWifiLock()
        observeThermalState()
        observeBattery()
        statusState.value = "starting"

        val settings = settingsState.value.copy()
        videoEncoder.onFailure = { encodeFailureState.value = it.description }
        audioEncoder.onFailure = { encodeFailureState.value = it.description }
        microphone.onFailure = { encodeFailureState.value = it }

        camera.onStateChange = { next ->
            cameraStateFlow.value = next
            if (lensCatalogState.value.isEmpty()) {
                lensCatalogState.value = camera.lensCatalog()
            }
            // The operator's framing is a setting like any other: it has to come back after a
            // restart, or a camera on a tripod silently changes shot.
            val settings = settingsState.value
            if (settings.cameraPosition != next.position ||
                settings.displayedZoom != next.displayedZoom
            ) {
                settingsState.value = settings.copy(
                    cameraPosition = next.position,
                    displayedZoom = next.displayedZoom
                )
                persist()
            }
        }
        camera.onBlankChanged = { videoEncoder.requestKeyframe() }
        camera.onCaptureRotationChange = { videoEncoder.requestKeyframe() }
        camera.onVideoFrame = { capturedFrameCount.incrementAndGet() }

        startServer()
        configureVideoEncoder(settings)

        val useSynthetic = launch.useSyntheticCamera || !permissionState.value.camera
        if (!useSynthetic) {
            camera.configure(settings.cameraPosition, settings)
            camera.setVideoEnabled(settings.videoEnabled)
            camera.start()
        }
        applyAudio(settings)

        if (launch.isUITest) startControlServer()

        statusState.value = if (useSynthetic) "running (synthetic)" else "running"
    }

    fun stop() {
        thermalPreviewJob?.cancel()
        silence.stop()
        batteryReceiver?.let { runCatching { context.unregisterReceiver(it) } }
        batteryReceiver = null
        thermalListener?.let { listener ->
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            runCatching { power?.removeThermalStatusListener(listener) }
        }
        thermalListener = null
        synthetic?.stop()
        synthetic = null
        microphone.stop()
        camera.close()
        videoEncoder.invalidate()
        audioEncoder.invalidate()
        adaptiveBitrate?.stop()
        adaptiveBitrate = null
        server?.stop()
        server = null
        controlServer?.stop()
        controlServer = null
        releaseWakeLock()
        releaseWifiLock()
        statusState.value = "stopped"
    }

    /**
     * A wake lock, because the whole point of this build is that it keeps working with the screen
     * off. The iOS build sets `isIdleTimerDisabled`, which only stops the screen from locking;
     * Android will suspend the CPU outright, and an encoder that is not scheduled is a stream that
     * stops without anything reporting an error.
     */
    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        wakeLock = power.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "cameraman:streaming"
        ).apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.release() }
        wakeLock = null
    }

    /**
     * A Wi-Fi lock, for the same reason as the wake lock and with the same asymmetry against iOS.
     *
     * `PARTIAL_WAKE_LOCK` keeps the CPU scheduled but says nothing about the radio: Android is free
     * to park Wi-Fi in power-save between beacons, and a camera whose packets are held for a second
     * or more is a camera the Director reports as offline. iOS has no equivalent knob because the
     * system keeps the radio hot for a foreground capture app; here it has to be asked for.
     *
     * Measured on a Pixel 10 on 2026-09-05: the handset's round-trip times were the steadiest of
     * the three cameras on the rig — 1.4% of pings above 50 ms against 41% for the worst iPhone —
     * and yet it produced a single 3.8 s stall. Rare but very long is the shape power-save makes,
     * and it is the shape the operator sees as "it dropped out and came back".
     *
     * `WIFI_MODE_FULL_HIGH_PERF` is deprecated from API 29 in favour of `WIFI_MODE_FULL_LOW_LATENCY`,
     * which additionally asks the firmware to cut latency and is only honoured while the screen is
     * on. This build has to survive the screen being off, so it takes the low-latency mode when it
     * can and falls back to high-performance, which is still honoured with the screen off.
     */
    private fun acquireWifiLock() {
        if (wifiLock != null) return
        val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            ?: return
        val mode = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        } else {
            @Suppress("DEPRECATION")
            WifiManager.WIFI_MODE_FULL_HIGH_PERF
        }
        wifiLock = runCatching {
            wifi.createWifiLock(mode, "cameraman:streaming").apply {
                setReferenceCounted(false)
                acquire()
            }
        }.getOrNull()
    }

    private fun releaseWifiLock() {
        runCatching { wifiLock?.release() }
        wifiLock = null
    }

    /**
     * The thermal pill, driven by a listener rather than a poll.
     *
     * `addThermalStatusListener` fires on every change and delivers the current value immediately,
     * so the pill is right from the first frame instead of up to a poll interval behind — which
     * matters most at the moment it goes from warm to hot.
     */
    private fun observeThermalState() {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return
        thermalLevelState.value = ThermalBadgeLevel.fromThermalStatus(power.currentThermalStatus)
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
            thermalLevelState.value = ThermalBadgeLevel.fromThermalStatus(status)
        }
        runCatching { power.addThermalStatusListener(listener) }
            .onSuccess { thermalListener = listener }
    }

    /**
     * The battery pill.
     *
     * `ACTION_BATTERY_CHANGED` is sticky, so registering returns the current state at once and there
     * is no window where the pill is missing. It is not receivable from a manifest entry — the
     * system only broadcasts it to registered receivers — which is why this is here and not in the
     * manifest.
     */
    private fun observeBattery() {
        if (batteryReceiver != null) return
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (intent == null) return
                val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
                batteryState.value = BatteryStatus.fromLevelAndScale(
                    level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
                    scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1),
                    isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                        status == BatteryManager.BATTERY_STATUS_FULL
                )
            }
        }
        val sticky = context.registerReceiver(
            receiver,
            IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        )
        batteryReceiver = receiver
        receiver.onReceive(context, sticky)
    }

    private fun configureVideoEncoder(settings: StreamSettings) {
        videoEncoder.onFrame = { frame ->
            if (frame.parameterSets.isNotEmpty()) {
                stateLock.withLock { latestParameterSets = frame.parameterSets }
            }
            val codec = stateLock.withLock { publishedSettings.codec }
            val current = server
            sendDelay.submit { current?.send(frame, codec) }
            recorder?.append(frame)
            encodedFrameCount.incrementAndGet()
        }
        videoEncoder.configure(settings) { surface ->
            // The encoder's input surface is new after every reconfigure, so the renderer has to be
            // repointed or the camera would keep drawing into a released one.
            camera.attachEncoder(surface)
            if (launch.useSyntheticCamera || !permissionState.value.camera) {
                startSynthetic(surface, settings)
            }
        }
        // The new codec starts at the ceiling, so the controller does too.
        adaptiveBitrate?.configure(settings.bitrate, settings.bitrateFloor, settings.adaptiveBitrate)
    }

    /**
     * A new rate, or adaptation switched on or off, handed to the running encoder without
     * restarting it.
     */
    private fun applyRate(settings: StreamSettings) {
        val loop = adaptiveBitrate
        if (loop != null) {
            loop.configure(settings.bitrate, settings.bitrateFloor, settings.adaptiveBitrate)
        } else {
            videoEncoder.setBitrate(settings.bitrate)
        }
    }

    /**
     * The TCP send buffer a new client gets while adapting: about a quarter second at the
     * operator's rate, never under 64 KiB. With adaptation off the platform's own buffer is kept.
     * [co.gamestation.cameraman.rtsp.RTSPClientConnection.start] says why it matters.
     */
    private fun adaptiveSendBufferBytes(): Int? {
        val settings = stateLock.withLock { publishedSettings }
        if (!settings.adaptiveBitrate) return null
        return maxOf(64 * 1024, settings.bitrate / 8 / 4)
    }

    /**
     * Points the AAC encoder at the microphone, or shuts it down.
     *
     * A muted camera has no audio track at all — the SDP omits the section rather than announcing
     * one and sending nothing, which is what leaves a client waiting for packets that never come.
     * That is the contract in `docs/rtsp-interop.md` and it is the same on both platforms.
     *
     * The silence generator is not part of this path. It exists for the recorder, where a mute has
     * to stay one access unit per 1024 samples or the archive comes back shorter than the take.
     */
    private fun applyAudio(settings: StreamSettings) {
        microphone.stop()
        silence.stop()

        if (!settings.audioEnabled || !permissionState.value.microphone) {
            audioEncoder.invalidate()
            return
        }

        audioEncoder.onFrame = { frame ->
            val current = server
            audioSendDelay.submit { current?.send(frame) }
            audioRecorder?.append(frame)
        }
        audioEncoder.configure(settings.audioSampleRate, 1)
        microphone.start(settings.audioSampleRate, 1)
    }

    private fun startServer() {
        val server = RTSPServer(
            context = context,
            describe = { videoSSRC, audioSSRC ->
                val identity = stateLock.withLock { publishedIdentity }
                val settings = stateLock.withLock { publishedSettings }
                val sets = stateLock.withLock { latestParameterSets }
                SDPBuilder(
                    identity = identity,
                    video = SDPBuilder.VideoTrack(
                        codec = settings.codec,
                        parameterSets = sets,
                        width = settings.width,
                        height = settings.height
                    ),
                    audio = audioEncoder.audioSpecificConfig?.let {
                        SDPBuilder.AudioTrack(
                            audioSpecificConfig = it,
                            sampleRate = settings.audioSampleRate,
                            channelCount = 1
                        )
                    },
                    videoSSRC = videoSSRC,
                    audioSSRC = audioSSRC
                ).build()
            },
            hasAudio = {
                stateLock.withLock { publishedSettings.audioEnabled } &&
                    audioEncoder.audioSpecificConfig != null
            },
            identity = { stateLock.withLock { publishedIdentity } },
            requestKeyframe = { videoEncoder.requestKeyframe() },
            parameters = { request -> handleParameters(request) },
            sendBufferBytes = { adaptiveSendBufferBytes() }
        )
        server.onStatusChange = { status ->
            serverStatusState.value = status
            // Logged as well as shown, because a bind failure on a handset is otherwise invisible
            // from the Mac driving the test.
            Log.i(tag, serverStatusJSON(status).toString())
        }

        server.start(
            port = stateLock.withLock { publishedSettings.port },
            path = stateLock.withLock { publishedSettings.path },
            advertise = launch.advertise
        )
        this.server = server

        val settings = stateLock.withLock { publishedSettings }
        adaptiveBitrate = co.gamestation.cameraman.rtsp.AdaptiveBitrateLoop(
            ceiling = settings.bitrate,
            floor = settings.bitrateFloor,
            sample = { server.sampleCongestion() },
            apply = { videoEncoder.setBitrate(it) }
        ).also { it.configure(settings.bitrate, settings.bitrateFloor, settings.adaptiveBitrate) }
    }

    private fun startSynthetic(surface: Surface?, settings: StreamSettings) {
        synthetic?.stop()
        synthetic = null
        if (surface == null) return
        val generator = SyntheticCamera(surface, SyntheticCamera.Configuration(settings))
        generator.onFrame = { capturedFrameCount.incrementAndGet() }
        generator.start()
        synthetic = generator

        cameraStateFlow.value = cameraStateFlow.value.copy(
            isRunning = true,
            deviceType = "synthetic",
            // The same badge the real camera fills in, so a flow asserting on the format reads one
            // thing whichever source it ran against.
            activeFormat = CaptureFormatDescriptor(
                width = settings.width,
                height = settings.height,
                minimumFrameRate = settings.frameRate,
                maximumFrameRate = settings.frameRate,
                supportsMultiLensSwitching = false
            )
        )
    }

    // MARK: - Remote control

    /** The phone's state as `GET_PARAMETER *` reports it. */
    val cameraSnapshot: CameraSnapshot
        get() {
            val cameraState = cameraStateFlow.value
            val identity = identityState.value
            return CameraSnapshot(
                name = identity.name,
                cname = identity.cname,
                model = Build.MODEL ?: "",
                thermalName = thermalStateName(),
                status = statusState.value,
                battery = batteryState.value,
                position = cameraState.position,
                deviceType = cameraState.deviceType,
                mapping = cameraState.mapping,
                deviceZoom = cameraState.deviceZoom,
                settings = settingsState.value.copy(),
                formats = formatOptions,
                lenses = lensCatalogState.value,
                streamURL = streamURL,
                clientCount = serverStatusState.value.clientCount,
                currentBitrate = adaptiveBitrate?.status?.controller?.bitrate
            )
        }

    /**
     * Answers a `GET_PARAMETER` / `SET_PARAMETER` body. A write goes through the same methods the
     * phone's own screen uses — `rename`, `CameraSession.flip`, `setDisplayedZoom`, and one
     * `applySettings` for every encoder field in the request, exactly like Done — so the rail and
     * Settings on the phone show it at once, and the reply echoes the values as they will land:
     * settings merged, zoom clamped to the mapping, position and name replaced.
     *
     * Called on the RTSP connection's own thread, which is the same footing the control channel
     * already drives these methods from.
     */
    fun handleParameters(request: RTSPResponder.ParameterRequest): RTSPResponder.ParameterResponse =
        when (request.method) {
            RTSPResponder.ParameterRequest.Method.GET ->
                when (val outcome = CameraParameters.respondToGet(request.body, cameraSnapshot)) {
                    is ParameterOutcome.Success ->
                        RTSPResponder.ParameterResponse(body = outcome.value.encoded)
                    is ParameterOutcome.Failure -> refusal(outcome)
                }

            RTSPResponder.ParameterRequest.Method.SET -> parameterWriteLock.withLock {
                val current = cameraSnapshot
                when (val outcome = CameraParameters.parseSet(request.body, current)) {
                    is ParameterOutcome.Success -> {
                        val write = outcome.value
                        write.name?.let { rename(it) }
                        write.position?.let { if (it != current.position) camera.flip() }
                        write.displayedZoom?.let { camera.setDisplayedZoom(it) }
                        if (write.touchesSettings) {
                            updateSettings(CameraParameters.settings(write, settingsState.value))
                            applySettings()
                        }
                        val applied = CameraParameters.snapshot(write, current)
                        RTSPResponder.ParameterResponse(
                            body = CameraParameters.echo(write, applied).encoded
                        )
                    }
                    is ParameterOutcome.Failure -> refusal(outcome)
                }
            }
        }

    private fun refusal(outcome: ParameterOutcome.Failure): RTSPResponder.ParameterResponse =
        RTSPResponder.ParameterResponse(
            statusCode = outcome.error.statusCode,
            reasonPhrase = outcome.error.reasonPhrase,
            body = outcome.error.body
        )

    // MARK: - The control channel

    private fun startControlServer() {
        val server = ControlServer { url ->
            val command = ControlChannel.command(url) ?: return@ControlServer null
            handle(command)
        }
        try {
            server.start()
            controlServer = server
        } catch (error: Exception) {
            // Not fatal: the app is still usable and the flow will fail on its first command with
            // something more specific than a launch that died.
            Log.w(tag, "CAMERAMAN_CONTROL_SERVER_FAILED $error")
        }
    }

    fun handle(command: ControlCommand): ByteArray? = when (command) {
        ControlCommand.DumpState -> stateDump().toString().toByteArray(Charsets.UTF_8)

        ControlCommand.Clients ->
            serverStatusJSON(serverStatusState.value).toString().toByteArray(Charsets.UTF_8)

        ControlCommand.FlipCamera -> {
            camera.flip()
            ok()
        }

        is ControlCommand.SetZoom -> {
            camera.setDisplayedZoom(command.displayed)
            ok()
        }

        is ControlCommand.SetName -> {
            rename(command.name)
            ok()
        }

        ControlCommand.ForceKeyframe -> {
            videoEncoder.requestKeyframe()
            ok()
        }

        is ControlCommand.SetBitrate -> if (command.mbps <= 0) {
            null
        } else {
            val next = settingsState.value.copy().apply { selectBitrate((command.mbps * 1_000_000).toInt()) }
            settingsState.value = next
            noteSettingsApplied(next)
            applyRate(next)
            ok()
        }

        is ControlCommand.SetAdaptiveBitrate -> {
            val next = settingsState.value.copy(adaptiveBitrate = command.on)
            settingsState.value = next
            noteSettingsApplied(next)
            applyRate(next)
            ok()
        }

        is ControlCommand.SetCodec -> {
            val codec = StreamCodec.fromRawValue(command.codec)
            if (codec == null) {
                null
            } else {
                val next = settingsState.value.copy().apply { this.codec = codec }
                settingsState.value = next
                noteSettingsApplied(next)
                configureVideoEncoder(next)
                ok()
            }
        }

        is ControlCommand.SetFormat -> if (
            command.width <= 0 || command.height <= 0 || command.fps <= 0
        ) {
            null
        } else {
            val next = settingsState.value.copy(
                width = command.width,
                height = command.height,
                frameRate = command.fps.toDouble()
            )
            settingsState.value = next
            noteSettingsApplied(next)
            camera.configure(cameraStateFlow.value.position, next)
            configureVideoEncoder(next)
            ok()
        }

        is ControlCommand.SetRotation -> {
            camera.overrideCaptureRotation(command.degrees)
            ok()
        }

        is ControlCommand.SetLenses -> {
            val next = settingsState.value.copy(disabledLensIDs = command.disabled.toSet())
            settingsState.value = next
            noteSettingsApplied(next)
            camera.setLensSelection(LensSelection(next.disabledLensIDs))
            persist()
            ok()
        }

        is ControlCommand.SetVideo -> {
            val next = settingsState.value.copy(videoEnabled = command.on)
            settingsState.value = next
            noteSettingsApplied(next)
            camera.setVideoEnabled(command.on)
            // Deliberately not persisted: blanking is a fault-injection control, not a preference,
            // and a camera left blank must come back showing a picture.
            ok()
        }

        is ControlCommand.SetSendDelay -> {
            sendDelay.configure(command.milliseconds, command.jitter, command.burst)
            ok()
        }

        is ControlCommand.SetAudioDelay -> {
            audioSendDelay.configure(command.milliseconds, command.jitter, command.burst)
            ok()
        }

        is ControlCommand.SetAudio -> {
            val next = settingsState.value.copy(audioEnabled = command.on)
            settingsState.value = next
            noteSettingsApplied(next)
            applyAudio(next)
            persist()
            ok()
        }

        ControlCommand.Reset -> {
            val next = launch.settings.copy()
            settingsState.value = next
            noteSettingsApplied(next)
            configureVideoEncoder(next)
            camera.configure(CameraPosition.BACK, next)
            applyAudio(next)
            ok()
        }
    }

    private fun noteSettingsApplied(next: StreamSettings) {
        appliedSettings = next.copy()
        stateLock.withLock { publishedSettings = next.copy() }
    }

    private fun ok(): ByteArray = """{"ok":true}""".toByteArray(Charsets.UTF_8)

    /**
     * What a flow can assert on without reading pixels. Everything here is a decision the app made,
     * not a rendering of it, so a failing assertion names the decision that was wrong.
     *
     * The keys are the iOS build's keys, so one script reads both and a soak of the two side by side
     * lines up column for column.
     */
    fun stateDump(): JSONObject {
        val settings = settingsState.value
        val cameraState = cameraStateFlow.value
        val identity = identityState.value
        val summaries = server?.sendQueueSummaries().orEmpty()

        return JSONObject().apply {
            put("status", statusState.value)
            put("cname", identity.cname)
            put("name", identity.name)
            put("codec", settings.codec.rawValue)
            put("width", settings.width)
            put("height", settings.height)
            put("frameRate", settings.frameRate)
            put("bitrateMbps", settings.bitrate / 1_000_000.0)
            put("adaptiveBitrate", adaptiveBitrate?.status?.let(::adaptiveBitrateJSON) ?: JSONObject.NULL)
            put("audioEnabled", settings.audioEnabled)
            put("position", cameraState.position.rawValue)
            put("deviceType", cameraState.deviceType)
            put("displayedZoom", cameraState.displayedZoom)
            put("deviceZoom", cameraState.deviceZoom)
            put("lensIndex", cameraState.lensIndex)
            put("zoomPresets", JSONArray(cameraState.mapping.presetDisplayedZooms))
            put("isRunning", cameraState.isRunning)
            put("capturedFrames", capturedFrames)
            put("encodedFrames", encodedFrames)
            put("encodeFailure", encodeFailureState.value ?: JSONObject.NULL)
            put("droppedFrames", summaries.sumOf { it.droppedFrames })
            put("physFootprintMB", ProcessLoad.physFootprintMB())
            put("availableMemoryMB", ProcessLoad.availableMemoryMB(context))
            put("cpuPercent", (ProcessLoad.cpuPercent() * 10).roundToInt() / 10.0)
            put("thermalState", thermalStateName())
            put("thermalLevel", thermalLevelState.value.rawValue)
            put("batteryPercent", batteryState.value?.percent ?: JSONObject.NULL)
            put("batteryCharging", batteryState.value?.isCharging ?: JSONObject.NULL)
            put("videoEnabled", settings.videoEnabled)
            put("disabledLensIDs", JSONArray(settings.disabledLensIDs.toList()))
            put("lensCount", lensCatalogState.value.size)
            put("residentMemoryMB", ProcessLoad.residentSizeMB())
            put(
                "sendDelay",
                sendDelay.summary().let { summary ->
                    JSONObject().apply {
                        put("delayMilliseconds", summary.delayMilliseconds)
                        put("jitterMilliseconds", summary.jitterMilliseconds)
                        put("burstMilliseconds", summary.burstMilliseconds)
                        put("held", summary.held)
                        put("totalHeld", summary.totalHeld)
                    }
                }
            )
            put(
                "audioSendDelay",
                audioSendDelay.summary().let { summary ->
                    JSONObject().apply {
                        put("delayMilliseconds", summary.delayMilliseconds)
                        put("held", summary.held)
                        put("totalHeld", summary.totalHeld)
                    }
                }
            )
            put("cpuCores", ProcessLoad.coreCount)
            put("cameraFailure", cameraState.failure ?: JSONObject.NULL)
            put("interrupted", cameraState.isInterrupted)
            put("interruptionReason", cameraState.interruptionReason ?: JSONObject.NULL)
            put("audioPendingBytes", audioEncoder.pendingBytes)
            put("captureRotation", cameraState.captureRotationAngle)
            put("sensorOrientation", cameraState.sensorOrientation)
            put("displayRotation", cameraState.displayRotation)
            put("cameraPermission", permissionState.value.camera)
            put("microphonePermission", permissionState.value.microphone)
            put("notificationPermission", permissionState.value.notifications)
            put("server", serverStatusJSON(server?.currentStatus() ?: serverStatusState.value))
            put("addresses", JSONArray(ControlServer.localAddresses()))
            put("streamURL", streamURL)
            // Whether the three things that keep a backgrounded camera alive are actually in force.
            // Reported rather than assumed: a lock that silently failed to acquire looks exactly
            // like one that is held, right up until the stream drops an hour into a game.
            put("wakeLockHeld", wakeLock?.isHeld == true)
            put("wifiLockHeld", wifiLock?.isHeld == true)
            put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations())
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return runCatching { power.isIgnoringBatteryOptimizations(context.packageName) }
            .getOrDefault(false)
    }

    private fun thermalStateName(): String {
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            ?: return "unknown"
        return ProcessLoad.thermalStateName(power.currentThermalStatus)
    }

    /** The iOS build's `AdaptiveBitrateLoop.Status` keys, so one script reads both. */
    private fun adaptiveBitrateJSON(status: co.gamestation.cameraman.rtsp.AdaptiveBitrateLoop.Status): JSONObject {
        val controller = status.controller
        return JSONObject().apply {
            put("enabled", status.enabled)
            put(
                "controller",
                JSONObject().apply {
                    put("ceiling", controller.ceiling)
                    put("floor", controller.floor)
                    put("bitrate", controller.bitrate)
                    put("lastDecision", controller.lastDecision.rawValue)
                    put("decreases", controller.decreases)
                    put("increases", controller.increases)
                    put("queueDelayMilliseconds", controller.queueDelayMilliseconds)
                    put("deliveryBitsPerSecond", controller.deliveryBitsPerSecond ?: JSONObject.NULL)
                    put("transportBaseMilliseconds", controller.transportBaseMilliseconds)
                }
            )
        }
    }

    private fun serverStatusJSON(status: RTSPServer.Status): JSONObject {
        val summaries = server?.sendQueueSummaries().orEmpty()
        return JSONObject().apply {
            put("isListening", status.isListening)
            put("port", status.port ?: JSONObject.NULL)
            put("clientCount", status.clientCount)
            put("lastError", status.lastError ?: JSONObject.NULL)
            put("droppedFrames", summaries.sumOf { it.droppedFrames })
            put("acceptedClients", status.acceptedClients)
            put("closedClients", status.closedClients)
            put("lastDisconnectReason", status.lastDisconnectReason ?: JSONObject.NULL)
            put("sendQueuePendingBytes", summaries.sumOf { it.pendingBytes })
            put("sendQueueFlushes", summaries.sumOf { it.flushes })
            put("listenerState", status.listenerState ?: JSONObject.NULL)
            put("isAdvertising", status.isAdvertising)
        }
    }

    /**
     * Records the encoder's real output so it can be put through ffprobe. A codec that accepts every
     * key and emits an undecodable stream reports no error anywhere, so the only way to know is to
     * decode the bytes.
     */
    fun startRecording(directory: File) {
        val settings = settingsState.value
        // A mute during a recording must not shorten the archive: without a continuous track the
        // recovered file is one access unit per *unmuted* frame, and the take comes back squeezed.
        if (!settings.audioEnabled || !permissionState.value.microphone) {
            audioEncoder.onFrame = { frame -> audioRecorder?.append(frame) }
            audioEncoder.configure(settings.audioSampleRate, 1)
            silence.start(settings.audioSampleRate, 1)
        }
        val extension = if (settings.codec == StreamCodec.HEVC) "h265" else "h264"
        recorder = ElementaryStreamRecorder(directory, "encode-${settings.codec.rawValue}.$extension")
        audioRecorder = AudioStreamRecorder(directory, "encode-audio.aac")
        statusState.value = "recording"
    }

    fun finishRecording(): JSONObject {
        silence.stop()
        val video = recorder?.finish()
        val audio = audioRecorder?.finish()
        recorder = null
        audioRecorder = null
        statusState.value = "recorded"
        return JSONObject().apply {
            put(
                "video",
                video?.let {
                    JSONObject().apply {
                        put("path", it.path)
                        put("frames", it.frames)
                        put("keyframes", it.keyframes)
                        put("bytes", it.bytes)
                        put("parameterSetBytes", it.parameterSetBytes)
                        put("duration", it.duration)
                        put("measuredBitrate", it.measuredBitrate)
                    }
                } ?: JSONObject.NULL
            )
            put(
                "audio",
                audio?.let {
                    JSONObject().apply {
                        put("path", it.path)
                        put("frames", it.frames)
                        put("bytes", it.bytes)
                        put("sampleRate", it.sampleRate)
                        put("channelCount", it.channelCount)
                        put("duration", it.duration)
                        put("unwrappable", it.unwrappable)
                    }
                } ?: JSONObject.NULL
            )
        }
    }

    companion object {
        const val tag = "GSCameraman"
    }
}
