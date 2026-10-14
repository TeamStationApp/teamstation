package app.teamstation.streamcore.phonestream

import android.content.Context
import android.view.Surface
import app.teamstation.streamcore.capture.CameraSession
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.ZoomMapping
import app.teamstation.streamcore.record.LiveSessionResume
import app.teamstation.streamcore.record.ProgramEncoder
import app.teamstation.streamcore.record.ProgrammeExport
import app.teamstation.streamcore.record.RecordingCatalog
import app.teamstation.streamcore.record.RecordingSession
import app.teamstation.streamcore.record.SilentAac
import app.teamstation.streamcore.stream.BasicMediaTelemetry
import app.teamstation.streamcore.stream.StreamEndedError
import app.teamstation.streamcore.stream.StreamSessionController
import app.teamstation.streamcore.stream.StreamVideoEncoding
import app.teamstation.streamcore.upload.UploadService
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The phone's streaming and recording engine: TS Director's pipeline from the phone's camera. A
 * process-wide singleton ([shared]); every method runs on the engine's one thread.
 *
 * - [open] starts the camera, the microphone and the programme; the preview draws straight from the
 *   capture, without the programme. [close] ends them.
 * - [startRecording] starts two things from the same programme tick: a [RecordingSession], whose
 *   take carries the game, the angle and the live stream and is written by [ProgramEncoder] at
 *   6 Mbps through its own MediaCodec session, and a [StreamSessionController], which publishes the
 *   stream to the URL and puts it back when it drops. JS asked for the stream with an explicit start,
 *   so the first dial uses the URL as given; every redial asks again through [LiveStreamClient] with
 *   the stream this device holds, and a 410 stops the stream (`streamEnded`) while the recording
 *   carries on.
 * - One recording per live stream: Record on a stream whose take has not been uploaded continues
 *   that take as its next part, at any distance in time. While a take's upload is running or cut
 *   off, Record on its stream throws `uploadInProgress`, so no part is ever added after the export
 *   being sent was made.
 * - On Android a `camera|microphone` foreground service ([PhoneForegroundWork]) keeps all of it
 *   running with the screen off. After a kill or a crash, reopening the streaming screen for the same
 *   stream within the hour ([resumeInterrupted]) continues the take as its next part, timed from its
 *   first picture, and the stream redials.
 * - A take finishes its part cleanly when free space falls under 500 MB, and the stream goes on.
 * - [uploadRecording] exports the take's programme (copied when unbroken, placed by wall clock across
 *   parts) and sends it with [UploadService], keeping the upload id on the take so a killed upload
 *   resumes; [resumePendingUploads] restarts every such upload not already running here. The export
 *   starts at part 1's first picture, and its `startAt` is when that picture was captured.
 * - Once a session's first publish has sent a picture, TeamStation is told when that picture was
 *   captured ([LiveStreamClient.reportLiveStart]), which is where it places the stream's live video.
 */
class PhoneStreamEngine(val environment: PhoneStreamEnvironment) {
    private val scope = CoroutineScope(SupervisorJob() + environment.dispatcher)
    val index: RecordingCatalog
    val catalog: PhoneCatalog
    val telemetry = BasicMediaTelemetry()
    val radar: PhoneRadar
    val encoder: ProgramEncoder
    val stream: PhoneStreamOutput
    val programme: PhoneProgramme
    val mix = PhoneSoundMix()
    val recordingSession: RecordingSession
    val streamController: StreamSessionController
    private val recordingMix: PhoneSoundMix.Output

    /** The stream on the air, and what its redial needs. */
    private data class StreamTake(
        val liveStreamId: String,
        val gameId: String,
        val angleName: String,
        val request: PhoneStreamRequest,
        val recordingID: Long?,
        /** The URL the first [StreamSessionController.DialReason.START] dial uses as given. */
        var firstURL: String? = null,
        /** The last URL the server gave, for a redial the server cannot answer. */
        var cachedURL: String? = null
    )

    var isOpen = false
        private set
    var angleName = ""
        private set
    var audioEnabled = true
        private set

    @Volatile
    private var source: PhoneCameraSource? = null

    @Volatile
    private var take: StreamTake? = null
    private var cameraState = CameraSession.State()
    private var disabledLenses: Set<String> = emptySet()
    private var pinchStartDeviceZoom: Double? = null

    /** The take a part is being written for, null between parts. */
    private var recordingTakeID: Long? = null

    /**
     * Set as a session starts streaming, until TeamStation has been told when its first published
     * picture was captured; see [reportLiveStartIfReady].
     */
    @Volatile
    private var liveStartWanted = false

    /** The report of the live start, while it is being sent. */
    internal var liveStartReport: Job? = null
        private set
    private var recordingVideo: StreamVideoEncoding? = null
    private var lastError: PhoneStreamError? = null
    private var statusJob: Job? = null
    private var storageJob: Job? = null
    private val observers = CopyOnWriteArrayList<(PhoneStreamEvent) -> Unit>()

    /** Uploads running in this process, by take, and what each was started with. */
    private val uploads = mutableMapOf<Long, Deferred<String>>()
    private val uploadServers = mutableMapOf<Long, Pair<String, String>>()

    /** What the last export did: copied a take unbroken, or rebuilt it, and why. */
    @Volatile
    internal var lastExport: ProgrammeExport.Result? = null
        private set

    /** Where each running upload stands, by take, for a host that starts listening part-way. Told from the network's thread too. */
    private val uploadProgress = mutableMapOf<Long, PhoneUploadProgress>()

    init {
        environment.storage.prepare()
        index = RecordingCatalog(environment.storage.index)
        catalog = PhoneCatalog(index)
        encoder = ProgramEncoder(
            telemetry,
            PhoneStreamProfile.recordingEncoding,
            environment.storage.program,
            environment.clock,
            environment.uptime,
            environment.makeRecordingAudioEncoder
        )
        stream = environment.makeStream(telemetry, environment.clock::now) { programme.streamWall(it) }
        programme = PhoneProgramme(
            recording = ProgramEncoderTarget(encoder),
            stream = stream,
            captureWall = { nanos -> source?.captureWall(nanos) ?: environment.clock.now() },
            uptime = environment.uptime,
            wall = environment.clock::now
        )
        mix.add(PhoneSoundMix.Output(PhoneStreamProfile.liveMixDelaySeconds) { stream.append(it) })
        recordingMix = PhoneSoundMix.Output(PhoneStreamProfile.recordingMixDelaySeconds) { encoder.append(it) }
        mix.add(recordingMix)
        recordingSession = RecordingSession(index, encoder, environment.clock, environment.heartbeatSeconds)
        radar = environment.makeRadar()
        streamController = StreamSessionController(
            publisher = stream,
            host = StreamSessionController.Host(
                requestURL = { reason -> streamURL(reason) },
                settings = { PhoneStreamProfile.streamSettings },
                gaveUp = { fail(PhoneStreamError.STREAM_FAILED) },
                ended = { fail(PhoneStreamError.STREAM_ENDED) }
            ),
            scope = scope,
            scheduler = environment.makeRetryScheduler(),
            pathMonitor = environment.makePathMonitor(),
            stallRedialSeconds = PhoneStreamProfile.stallRedialSeconds,
            now = environment.uptime
        )
        stream.onInputSurface { surface -> attachEncoder(PhoneProgramme.STREAM_KEY, surface) }
    }

    private suspend fun <T> onEngine(work: suspend () -> T): T = withContext(environment.dispatcher) { work() }

    // MARK: - Events

    /** Calls [handler] with every status, radar and upload event until the returned function is called. */
    fun observe(handler: (PhoneStreamEvent) -> Unit): () -> Unit {
        observers += handler
        return { observers -= handler }
    }

    private fun emit(event: PhoneStreamEvent) {
        for (handler in observers) runCatching { handler(event) }
    }

    private fun fail(error: PhoneStreamError) {
        lastError = error
        publishStatus()
    }

    // MARK: - Open and close

    /** Starts the camera, the preview and the programme. On an open engine, applies the arguments. */
    suspend fun open(angleName: String, audioEnabled: Boolean = true, disabledLenses: Set<String> = emptySet()) = onEngine {
        this.angleName = angleName
        setAudioEnabledNow(audioEnabled)
        if (isOpen) {
            setDisabledLensesNow(disabledLenses)
            return@onEngine
        }
        this.disabledLenses = disabledLenses
        val opened = environment.makeSource()
        opened.device.onStateChange = { state -> scope.launch { cameraState = state } }
        opened.device.configure(CameraPosition.BACK, PhoneStreamProfile.captureSettings(disabledLenses))
        val now = environment.clock.now()
        programme.start(now)
        mix.start(now)
        source = opened
        opened.start(programme, mix)
        isOpen = true
        radar.start(scope) { emit(PhoneStreamEvent.Radar(it)) }
        startStatusLoop()
        runCatching { environment.retention.sweep(catalog, environment.storage, now, protecting = uploads.keys.toSet()) }
    }

    /** Ends the capture and the programme, stopping a recording first. */
    suspend fun close() = onEngine {
        if (!isOpen) return@onEngine
        if (take != null) stopRecordingNow()
        statusJob?.cancel()
        statusJob = null
        source?.stop()
        source = null
        mix.stop()
        isOpen = false
        publishStatus()
    }

    /** Where the preview draws, straight from the capture: a `TextureView`'s surface. */
    fun attachPreview(surface: Surface?, width: Int, height: Int) {
        source?.device?.attachPreview(surface, width, height)
    }

    suspend fun setAngleName(name: String) = onEngine { angleName = name }

    // MARK: - Recording and streaming

    /** Starts the recording and the stream from the same programme tick. */
    suspend fun startRecording(
        rtmpUrl: String,
        liveStreamId: String,
        gameId: String,
        angleName: String,
        request: PhoneStreamRequest
    ) = onEngine {
        if (!isOpen || take != null) throw PhoneStreamException(PhoneStreamError.NOT_READY)
        val existing = catalog.current(liveStreamId)
        if (existing != null && (existing.hasPendingUpload || uploads.containsKey(existing.recordingID))) {
            throw PhoneStreamException(PhoneStreamError.UPLOAD_IN_PROGRESS)
        }
        if (!environment.storageRules.canStart(environment.freeDiskBytes())) {
            fail(PhoneStreamError.INSUFFICIENT_STORAGE)
            throw PhoneStreamException(PhoneStreamError.INSUFFICIENT_STORAGE)
        }
        // A take another stream left open when the app stopped is over: it ends where it got to.
        val live = catalog.live()
        if (live != null && live.liveStreamId != liveStreamId) closeInterruptedTake()
        this.angleName = angleName
        lastError = null
        val now = environment.clock.now()
        val settings = PhoneStreamProfile.recordingSettings
        val recordingID = try {
            val id = if (existing != null) {
                catalog.reopen(existing.recordingID)
                val resumed = LiveSessionResume.Take(existing.recordingID, existing.startedAt, null, index.nextProgramPart(existing.recordingID))
                recordingSession.resume(resumed, now, settings)
                existing.recordingID
            } else {
                recordingSession.open(now, settings).also { id ->
                    catalog.add(id, liveStreamId, gameId, angleName)
                    recordingSession.startProgramme(now, settings)
                }
            }
            openRecordingVideo()
            id
        } catch (error: Exception) {
            telemetry.recordRecordingError(error.message ?: error.javaClass.simpleName)
            if (recordingSession.isRecording) {
                runCatching { recordingSession.finishProgramme(now) }
                recordingSession.close(now)
            }
            fail(PhoneStreamError.RECORDING_FAILED)
            throw PhoneStreamException(PhoneStreamError.RECORDING_FAILED, error.message ?: "recordingFailed")
        }
        catalog.setLive(PhoneCatalog.LiveContext(liveStreamId, gameId, angleName))
        take = StreamTake(liveStreamId, gameId, angleName, request, recordingID, firstURL = rtmpUrl, cachedURL = rtmpUrl)
        recordingTakeID = recordingID
        liveStartWanted = true
        beginLiveSession(recordingID)
        streamController.start(StreamSessionController.DialReason.START)
        startStorageLoop()
        environment.foreground.recordingStarted(angleName)
        publishStatus()
    }

    /** Stops the stream and the recording, the recording with its hold fill and sound check. */
    suspend fun stopRecording() = onEngine { stopRecordingNow() }

    private suspend fun stopRecordingNow() {
        if (take == null) return
        val endedAt = environment.clock.now()
        take = null
        liveStartWanted = false
        streamController.stop()
        storageJob?.cancel()
        storageJob = null
        catalog.clearLive()
        if (recordingTakeID != null) finishPart(endedAt, closingTake = true)
        recordingSession.endLiveSession(stillLive = false)
        environment.foreground.recordingStopped()
        publishStatus()
    }

    val isRecording: Boolean get() = recordingTakeID != null
    val isStreaming: Boolean get() = take != null

    private fun beginLiveSession(recording: Long?) {
        recordingSession.beginLiveSession(recording, streaming = true) { take != null }
    }

    private fun attachEncoder(key: String, surface: Surface?) {
        val device = source?.device ?: return
        if (surface == null) device.detachEncoder(key) else device.attachEncoder(key, surface)
    }

    /** The part's own MediaCodec session, drawn by the programme tick, its pictures into [encoder]. */
    private fun openRecordingVideo() {
        val video = environment.makeRecordingVideoEncoder()
        val surface = video.open(
            PhoneStreamProfile.recordingEncoderConfig,
            object : StreamVideoEncoding.Output {
                override fun onFrame(frame: EncodedVideoFrame) = encoder.appendEncoded(frame)
                override fun onError(code: Int, message: String) {
                    telemetry.recordEncodeFailure(code)
                    telemetry.recordRecordingError(message)
                }
            }
        )
        recordingVideo = video
        attachEncoder(PhoneProgramme.RECORDING_KEY, surface)
    }

    /**
     * Finishes the part being written at [endedAt]: the programme stops drawing it, its encoder hands
     * over its last pictures, the recording's mix waits its delay and hands over the sound up to the
     * stop, and the part is filled to [endedAt]. [closingTake] writes the take's end; a low-storage
     * stop that resumes later leaves nothing open either.
     */
    private suspend fun finishPart(endedAt: Double, closingTake: Boolean) {
        recordingTakeID = null
        source?.device?.detachEncoder(PhoneProgramme.RECORDING_KEY)
        val video = recordingVideo
        recordingVideo = null
        val tail = environment.stopTailSeconds
        withContext(environment.ioDispatcher) {
            val waited = environment.clock.now() - endedAt
            if (tail > waited) delay(((tail - waited) * 1000).toLong())
            video?.finishInput(finishInputMillis)
            video?.close()
            recordingSession.detachAnchors()
            mix.flush(recordingMix, endedAt)
            recordingSession.finishProgramme(until = endedAt)
        }
        if (closingTake) recordingSession.close(endedAt)
    }

    /**
     * The address for a dial. The first `START` dial is the URL JS was given; every other asks the
     * server again with the stream held, so an ended stream stays ended.
     */
    private suspend fun streamURL(reason: StreamSessionController.DialReason): String {
        val held = take ?: throw CancellationException("not streaming")
        if (reason == StreamSessionController.DialReason.START) {
            held.firstURL?.let { first ->
                held.firstURL = null
                return first
            }
        }
        val client = LiveStreamClient(held.request.apiBase, held.request.token, environment.http)
        return try {
            val answer = client.requestLiveStream(
                gameId = held.gameId,
                label = held.angleName,
                deviceId = held.request.deviceId,
                deviceModel = held.request.deviceModel,
                heldStreamId = held.liveStreamId
            )
            val url = answer.url ?: throw LiveStreamClient.Error.Server(200, "no stream address")
            held.cachedURL = url
            url
        } catch (ended: LiveStreamClient.Error.StreamEnded) {
            throw StreamEndedError(ended.message ?: LiveStreamClient.endedMessage)
        } catch (error: Exception) {
            // Offline, or the server could not answer: the address held is still the stream's.
            held.cachedURL ?: throw error
        }
    }

    // MARK: - Interruption and resume

    /**
     * The take that was rolling when the app last stopped, if reopening the streaming screen now would
     * continue it: within the hour, and still open.
     */
    suspend fun interruptedSession(): PhoneInterruptedSession? = onEngine {
        if (take != null) return@onEngine null
        val live = catalog.live() ?: return@onEngine null
        val plan = LiveSessionResume.plan(index, environment.clock.now(), PhoneStreamProfile.resumeDowntimeLimitSeconds)
            ?: return@onEngine null
        val outcome = plan.outcome as? LiveSessionResume.Outcome.Resume ?: return@onEngine null
        PhoneInterruptedSession(live.liveStreamId, live.gameId, live.angleName, outcome.recording?.recordingID, outcome.streaming, plan.downtime)
    }

    /**
     * Continues the interrupted take as its next part, timed from its first picture, and redials its
     * stream with the stream held. False when there is nothing to continue; a take away longer than
     * the hour is closed where it got to.
     */
    suspend fun resumeInterrupted(request: PhoneStreamRequest): Boolean = onEngine {
        if (!isOpen || take != null) throw PhoneStreamException(PhoneStreamError.NOT_READY)
        val live = catalog.live() ?: return@onEngine false
        val plan = LiveSessionResume.plan(index, environment.clock.now(), PhoneStreamProfile.resumeDowntimeLimitSeconds)
        val outcome = plan?.outcome as? LiveSessionResume.Outcome.Resume
        if (outcome == null) {
            closeInterruptedTake()
            return@onEngine false
        }
        angleName = live.angleName
        lastError = null
        val resumed = outcome.recording
        take = StreamTake(
            live.liveStreamId,
            live.gameId,
            live.angleName,
            request,
            resumed?.recordingID ?: catalog.current(live.liveStreamId)?.recordingID
        )
        if (resumed != null) {
            if (environment.storageRules.canStart(environment.freeDiskBytes())) {
                try {
                    recordingSession.resume(resumed, environment.clock.now(), PhoneStreamProfile.recordingSettings)
                    openRecordingVideo()
                    recordingTakeID = resumed.recordingID
                } catch (error: Exception) {
                    telemetry.recordRecordingError(error.message ?: error.javaClass.simpleName)
                    lastError = PhoneStreamError.RECORDING_FAILED
                }
            } else {
                catalog.closeAtLastAnchor(resumed.recordingID)
                catalog.markStoppedForLowStorage(resumed.recordingID)
                lastError = PhoneStreamError.RECORDING_STOPPED_LOW_STORAGE
            }
        }
        beginLiveSession(recordingTakeID)
        liveStartWanted = true
        streamController.start(StreamSessionController.DialReason.REDIAL)
        startStorageLoop()
        environment.foreground.recordingStarted(live.angleName)
        publishStatus()
        true
    }

    /** Closes a take a kill left open, at the last moment its programme reached, and forgets the live session. */
    private fun closeInterruptedTake() {
        index.liveRecording()?.let { catalog.closeAtLastAnchor(it.id) }
        index.closeLiveSession()
        catalog.clearLive()
    }

    // MARK: - Storage

    private fun startStorageLoop() {
        storageJob?.cancel()
        val millis = (environment.storageCheckSeconds * 1000).toLong()
        storageJob = scope.launch {
            while (isActive) {
                delay(millis)
                checkStorage()
            }
        }
    }

    /**
     * A part finishes cleanly once free space falls under the floor; the stream goes on, and the take
     * no longer covers the whole stream.
     */
    internal suspend fun checkStorage() {
        val id = recordingTakeID ?: return
        if (!environment.storageRules.mustStop(environment.freeDiskBytes())) return
        catalog.markStoppedForLowStorage(id)
        catalog.markPublishedOutsideParts(id)
        lastError = PhoneStreamError.RECORDING_STOPPED_LOW_STORAGE
        recordingSession.endLiveSession(recording = true, stillLive = true)
        finishPart(environment.clock.now(), closingTake = true)
        publishStatus()
    }

    // MARK: - Status

    private fun startStatusLoop() {
        statusJob?.cancel()
        val millis = (environment.statusIntervalSeconds * 1000).toLong()
        statusJob = scope.launch {
            while (isActive) {
                publishStatus()
                delay(millis)
            }
        }
    }

    /** The status as it is now. */
    val status: PhoneStreamStatus
        get() {
            val congestion = streamController.refreshCongestion()
            val battery = environment.deviceStatus.battery()
            val started = recordingSession.startedAt
            val recordingSeconds = if (recordingTakeID != null && started != null) maxOf(0.0, environment.clock.now() - started) else 0.0
            return PhoneStreamStatus(
                phase = streamController.phase.rawValue,
                retryInSeconds = streamController.retryInSeconds,
                bitrateKbps = congestion.rate.bitrate / 1_000,
                displayedZoom = cameraState.displayedZoom,
                lensLabel = lensLabel(cameraState, source?.device?.lensCatalog().orEmpty()),
                batteryPercent = battery?.percent,
                charging = battery?.isCharging ?: false,
                thermal = environment.deviceStatus.thermal().rawValue,
                recordingSeconds = recordingSeconds,
                isRecording = recordingTakeID != null,
                error = lastError
            )
        }

    internal fun publishStatus() {
        // The stream on the air while no part is recording: the take no longer covers it all.
        val held = take
        if (streamController.phase == StreamSessionController.Phase.LIVE && recordingTakeID == null && held?.recordingID != null) {
            catalog.markPublishedOutsideParts(held.recordingID)
        }
        reportLiveStartIfReady()
        emit(PhoneStreamEvent.Status(status))
    }

    /**
     * Tells TeamStation when the first picture of this session's first publish was captured, once it
     * has gone out: TeamStation places the stream's live video there, so it lines up on the wall clock
     * with the game's other cameras. Placed by when the publish reached the server instead, this
     * phone's angle played as far behind as its picture delay and dial put it. The server keeps the
     * first account a stream gets, so a resumed session's, of a later publish, changes nothing there.
     */
    private fun reportLiveStartIfReady() {
        if (!liveStartWanted) return
        val held = take ?: return
        val started = stream.liveTimelineStart ?: return
        liveStartWanted = false
        val client = LiveStreamClient(held.request.apiBase, held.request.token, environment.http)
        liveStartReport = scope.launch {
            // On the server's clock: this phone's can be a second out ([ServerClock]).
            var offset: Double? = null
            for (attempt in 1..LIVE_START_ATTEMPTS) {
                try {
                    val known = offset ?: client.serverClockOffset(now = environment.clock::now).also { measured ->
                        offset = measured
                        // Kept with the take, whose upload may come hours later.
                        held.recordingID?.let { onEngine { catalog.setServerClockOffset(measured, it) } }
                    }
                    client.reportLiveStart(held.gameId, held.liveStreamId, started + known)
                    return@launch
                } catch (ended: LiveStreamClient.Error.StreamEnded) {
                    return@launch
                } catch (error: LiveStreamClient.Error) {
                    if (attempt < LIVE_START_ATTEMPTS) delay(LIVE_START_RETRY_MILLIS)
                }
            }
        }
    }

    // MARK: - Camera

    suspend fun setZoom(displayed: Double) = onEngine {
        pinchStartDeviceZoom = null
        source?.device?.setDisplayedZoom(displayed)
    }

    /** A pinch, multiplicative against the zoom when it began; [ended] closes the gesture. */
    suspend fun pinch(scale: Double, ended: Boolean = false) = onEngine {
        val start = pinchStartDeviceZoom ?: cameraState.deviceZoom
        pinchStartDeviceZoom = if (ended) null else start
        source?.device?.setDeviceZoom(cameraState.mapping.pinchedDeviceZoom(start, scale))
    }

    suspend fun zoomScale(): PhoneZoomScale = onEngine {
        val mapping = cameraState.mapping
        PhoneZoomScale(
            presets = mapping.presetDisplayedZooms,
            switchOvers = mapping.switchOverDeviceZooms.map { mapping.displayedZoom(it) },
            digitalFrom = mapping.softwareZoomStartDisplayedZoom,
            minimum = mapping.displayedZoom(mapping.minimumDeviceZoom),
            maximum = mapping.displayedZoom(mapping.maximumDeviceZoom),
            current = cameraState.displayedZoom
        )
    }

    /** Every lens this phone has, with Cameraman's rule for which may be turned off. */
    suspend fun lenses(): List<PhoneLens> = onEngine {
        val lensCatalog = source?.device?.lensCatalog().orEmpty()
        val selection = LensSelection(normalizedLenses(disabledLenses, lensCatalog))
        lensCatalog.map { PhoneLens(it, selection.isEnabled(it), selection.canDisable(it, lensCatalog)) }
    }

    suspend fun setDisabledLenses(ids: Set<String>) = onEngine { setDisabledLensesNow(ids) }

    private fun setDisabledLensesNow(ids: Set<String>) {
        val normalized = normalizedLenses(ids, source?.device?.lensCatalog().orEmpty())
        if (normalized == disabledLenses) return
        disabledLenses = normalized
        source?.device?.setLensSelection(LensSelection(normalized))
    }

    suspend fun flip() = onEngine { source?.device?.flip() }

    /**
     * The screen's rotation in degrees, which the capture turns the picture by so the field is
     * upright in both landscapes.
     */
    suspend fun setDisplayRotation(degrees: Int) = onEngine { source?.device?.setDisplayRotation(degrees) }

    /** Mutes the microphone's contribution: both mixes write silence instead. */
    suspend fun setAudioEnabled(enabled: Boolean) = onEngine { setAudioEnabledNow(enabled) }

    private fun setAudioEnabledNow(enabled: Boolean) {
        audioEnabled = enabled
        mix.soundEnabled = enabled
    }

    // MARK: - Radar

    suspend fun radarSetEnabled(enabled: Boolean) = onEngine { radar.setEnabled(enabled) }
    suspend fun radarScan() = onEngine { radar.scan() }
    suspend fun radarStopScan() = onEngine { radar.stopScan() }
    suspend fun radarPair(serial: String): Boolean = onEngine { radar.pair(serial) }
    suspend fun radarUnpair(serial: String) = onEngine { radar.unpair(serial) }
    suspend fun radarState(): PhoneRadarState = onEngine { radar.state }

    // MARK: - Recordings and uploads

    /** The takes on this phone, each filed under its live stream. */
    suspend fun recordings(): List<PhoneRecording> = onEngine { catalog.recordings() }

    /**
     * Exports the take of [liveStreamId] and sends it as that stream's replacement. Answers the video
     * it became. An upload of the same take already running in this process is the one returned.
     */
    suspend fun uploadRecording(liveStreamId: String, apiBase: String, token: String, title: String): String {
        val running = onEngine {
            val recording = catalog.recordings().firstOrNull { it.liveStreamId == liveStreamId }
                ?: throw PhoneStreamException(PhoneStreamError.NO_RECORDING)
            val videoId = recording.videoId
            if (videoId != null && recording.isUploaded) return@onEngine null to videoId
            uploads[recording.recordingID]?.let { return@onEngine it to null }
            if (take?.liveStreamId == liveStreamId) throw PhoneStreamException(PhoneStreamError.STILL_RECORDING)
            startUpload(recording, PhoneStreamRequest.serverURL(apiBase), token, title) to null
        }
        return running.second ?: running.first!!.await()
    }

    /** Restarts every upload that was opened and has not landed, except one already running here. Answers how many it started. */
    suspend fun resumePendingUploads(apiBase: String, token: String): Int = onEngine {
        val pending = catalog.recordings().filter { it.hasPendingUpload && !uploads.containsKey(it.recordingID) }
        for (recording in pending) {
            startUpload(recording, PhoneStreamRequest.serverURL(apiBase), token, recording.uploadTitle ?: recording.angleName)
        }
        pending.size
    }

    /** The ids of the takes whose upload is running in this process. */
    suspend fun runningUploads(): Set<Long> = onEngine { uploads.keys.toSet() }

    /**
     * Where each upload running in this process stands now, by take: its last report. An upload
     * resumed at launch reports before any screen listens, so a screen that opens part-way reads this
     * instead of waiting for the next report.
     */
    fun runningUploadProgress(): Map<Long, PhoneUploadProgress> = synchronized(uploadProgress) { uploadProgress.toMap() }

    /** Stops the upload of [liveStreamId] and abandons it on the server, so the take can be recorded on or uploaded afresh. */
    suspend fun cancelUpload(liveStreamId: String) = onEngine {
        val recording = catalog.recordings().firstOrNull { it.liveStreamId == liveStreamId } ?: return@onEngine
        val id = recording.recordingID
        uploads[id]?.cancelAndJoin()
        val uploadId = recording.uploadId
        val server = uploadServers.remove(id)
        if (uploadId != null && server != null) environment.makeUploadClient(server.first, server.second).abandonUpload(uploadId)
        catalog.setUpload(null, null, id)
        environment.storage.export(id).delete()
    }

    /** Deletes the take of [liveStreamId], its files and its rows. Not while it records or uploads. */
    suspend fun deleteRecording(liveStreamId: String) = onEngine {
        val recording = catalog.recordings().firstOrNull { it.liveStreamId == liveStreamId } ?: return@onEngine
        if (take?.liveStreamId == liveStreamId) throw PhoneStreamException(PhoneStreamError.STILL_RECORDING)
        if (uploads.containsKey(recording.recordingID)) throw PhoneStreamException(PhoneStreamError.UPLOAD_IN_PROGRESS)
        catalog.delete(recording.recordingID, environment.storage)
    }

    private fun startUpload(recording: PhoneRecording, server: String, token: String, title: String): Deferred<String> {
        val id = recording.recordingID
        uploadServers[id] = server to token
        environment.foreground.uploadStarted(recording.angleName)
        val task = scope.async {
            try {
                upload(recording, server, token, title).also { uploadServers.remove(id) }
            } catch (error: Throwable) {
                if (error !is CancellationException) {
                    report(PhoneUploadProgress(recording.liveStreamId, PhoneUploadProgress.State.FAILED, message = error.message), id)
                }
                throw error
            } finally {
                synchronized(uploadProgress) { uploadProgress.remove(id) }
                uploads.remove(id)
                if (uploads.isEmpty()) environment.foreground.uploadsFinished()
            }
        }
        uploads[id] = task
        return task
    }

    private suspend fun upload(recording: PhoneRecording, server: String, token: String, title: String): String {
        val liveStreamId = recording.liveStreamId
        val id = recording.recordingID
        report(PhoneUploadProgress(liveStreamId, PhoneUploadProgress.State.EXPORTING), id)
        if (recording.endedAt == null) catalog.closeAtLastAnchor(id)
        val summary = index.recording(id) ?: throw PhoneStreamException(PhoneStreamError.NO_RECORDING)
        val output = environment.storage.export(id)
        // From part 1's first picture, placed where it was captured: the upload says when its first
        // frame happened, and the server lines it up with the game's other angles by nothing else.
        val start = uploadStart(index.programAnchors(id), summary.startedAt)
        // A resumed upload sends the bytes the server already has part of: the export it was opened on.
        if (recording.uploadId == null || !output.isFile) {
            withContext(environment.ioDispatcher) {
                val silence = environment.makeRecordingAudioEncoder().let { aac ->
                    try {
                        SilentAac.packet(aac)
                    } finally {
                        aac.close()
                    }
                } ?: throw PhoneStreamException(PhoneStreamError.RECORDING_FAILED, "no coded silence")
                lastExport = ProgrammeExport.export(
                    parts = summary.programFilenames.map { File(environment.storage.program, it) },
                    anchors = index.programAnchors(id),
                    resumeCount = summary.resumeCount,
                    windowStart = start,
                    windowEnd = summary.endedAt,
                    frameRate = PhoneStreamProfile.frameRate,
                    silentPacket = silence,
                    output = output
                )
            }
        }
        // The start goes on the server's clock: this phone's can be a second out ([ServerClock]). The
        // offset measured while the take was recorded is the one that fits it; a take that never had one
        // is read now. Unreachable, the upload's own request fails anyway.
        val offset = recording.serverClockOffset ?: try {
            LiveStreamClient(server, token, environment.http).serverClockOffset(now = environment.clock::now)
        } catch (error: LiveStreamClient.Error) {
            0.0
        }
        val service = environment.uploadSleep?.let { UploadService(environment.makeUploadClient(server, token), sleep = it) }
            ?: UploadService(environment.makeUploadClient(server, token))
        val uploadTitle = recording.uploadTitle ?: title
        val videoId = service.send(
            file = output,
            gameId = recording.gameId,
            title = uploadTitle,
            kind = "program",
            startedAt = start + offset,
            uploadId = recording.uploadId,
            liveStreamId = liveStreamId,
            wholeStream = if (recording.coversWholeStream) true else null,
            onOpened = { uploadId -> catalog.setUpload(uploadId, uploadTitle, id) },
            onProgress = { progress ->
                report(
                    PhoneUploadProgress(
                        liveStreamId,
                        if (progress.step == null) PhoneUploadProgress.State.UPLOADING else PhoneUploadProgress.State.PROCESSING,
                        fraction = progress.fraction,
                        bytesSent = progress.bytesSent,
                        bytesTotal = progress.bytesTotal,
                        step = progress.step
                    ),
                    id
                )
            }
        )
        catalog.markUploaded(id, videoId, environment.clock.now())
        output.parentFile?.deleteRecursively()
        report(PhoneUploadProgress(liveStreamId, PhoneUploadProgress.State.UPLOADED, fraction = 1.0, videoId = videoId), id)
        return videoId
    }

    /**
     * Tells the host where an upload stands, and keeps it for a host that asks later. A report for an
     * upload that has ended, or one that would take the bar back, is dropped.
     */
    private fun report(progress: PhoneUploadProgress, id: Long) {
        synchronized(uploadProgress) {
            when (progress.state) {
                PhoneUploadProgress.State.EXPORTING -> uploadProgress[id] = progress
                PhoneUploadProgress.State.UPLOADING, PhoneUploadProgress.State.PROCESSING -> {
                    val current = uploadProgress[id] ?: return
                    if (progress.state == PhoneUploadProgress.State.UPLOADING) {
                        if (current.state == PhoneUploadProgress.State.PROCESSING) return
                        if (current.state == PhoneUploadProgress.State.UPLOADING && progress.bytesSent < current.bytesSent) return
                    }
                    uploadProgress[id] = progress
                }
                PhoneUploadProgress.State.UPLOADED, PhoneUploadProgress.State.FAILED -> uploadProgress.remove(id)
            }
            // Inside the lock, so two reports reach the host in the order they were kept.
            emit(PhoneStreamEvent.Upload(progress))
        }
    }

    /** Every running upload stops where it is and keeps its id, as a killed process's would. */
    internal suspend fun interruptUploads() = onEngine {
        val running = uploads.values.toList()
        for (task in running) task.cancelAndJoin()
    }

    /**
     * Everything stops where it is, as a killed process would leave it: nothing is finished, no take
     * is closed, and the live session keeps its last heartbeat. The catalog is closed, so a new engine
     * can open the same storage.
     */
    internal suspend fun abandonForTesting() = onEngine {
        statusJob?.cancel()
        storageJob?.cancel()
        recordingSession.stopHeartbeat()
        streamController.stop()
        source?.stop()
        source = null
        mix.stop()
        recordingVideo?.close()
        recordingVideo = null
        encoder.abandonForTesting()
        for (task in uploads.values.toList()) task.cancelAndJoin()
        take = null
        recordingTakeID = null
        isOpen = false
        radar.stop()
        index.close()
    }

    companion object {
        /** How long a part's encoder has to hand over its last pictures at a stop. */
        const val finishInputMillis = 1_000L

        /**
         * How many times the live start is offered to TeamStation, [LIVE_START_RETRY_MILLIS] apart,
         * before it is left to the server's own placement.
         */
        const val LIVE_START_ATTEMPTS = 3
        const val LIVE_START_RETRY_MILLIS = 2_000L

        /**
         * Where an upload of the take with [anchors] starts on the wall clock: when part 1's first
         * picture was captured, the same origin its sound was placed by. The take's own start is when
         * Record was pressed, which is not when any picture in the file was taken, so the phones'
         * uploads sat on the wall clock as far apart as their picture delays and encoder starts. A
         * take with no anchor for its first part has nothing better than its start.
         */
        fun uploadStart(anchors: List<RecordingCatalog.ProgramAnchor>, startedAt: Double): Double =
            RecordingCatalog.partStarts(anchors)[1] ?: startedAt

        @Volatile
        private var instance: PhoneStreamEngine? = null

        /** The process's engine, with the app's own storage, camera, microphone, network and radios. */
        fun shared(context: Context, foreground: PhoneForegroundWork = PhoneForegroundWork.None): PhoneStreamEngine =
            instance ?: synchronized(this) {
                instance ?: PhoneStreamEngine(PhoneStreamEnvironment.live(context, foreground)).also { instance = it }
            }

        /** Lenses switched off, less any that would leave a camera with none. */
        fun normalizedLenses(ids: Set<String>, lensCatalog: List<app.teamstation.streamcore.core.CameraLens>): Set<String> {
            if (lensCatalog.isEmpty()) return ids
            val emptied = CameraPosition.entries.filter { position ->
                val lenses = lensCatalog.filter { it.position == position }
                lenses.isNotEmpty() && lenses.all { it.id in ids }
            }
            return ids.filterTo(mutableSetOf()) { id -> lensCatalog.none { it.id == id && it.position in emptied } }
        }

        /** The pill's lens: the widest lens at or below the zoom, or the zoom itself. */
        fun lensLabel(state: CameraSession.State, lensCatalog: List<app.teamstation.streamcore.core.CameraLens>): String {
            val lenses = lensCatalog.filter { it.position == state.position }.sortedBy { it.displayedZoom }
            return lenses.lastOrNull { it.displayedZoom <= state.displayedZoom + 0.01 }?.title ?: ZoomMapping.label(state.displayedZoom)
        }
    }
}
