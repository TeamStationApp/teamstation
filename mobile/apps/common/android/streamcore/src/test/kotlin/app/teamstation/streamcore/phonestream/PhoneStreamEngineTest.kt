package app.teamstation.streamcore.phonestream

import android.graphics.SurfaceTexture
import android.view.Surface
import app.teamstation.streamcore.capture.CameraSession
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.ZoomMapping
import app.teamstation.streamcore.gl.ProgrammeTicker
import app.teamstation.streamcore.record.CountingAac
import app.teamstation.streamcore.record.FragmentedMp4Reader
import app.teamstation.streamcore.record.FragmentedMp4WriterTest
import app.teamstation.streamcore.record.SteadyWall
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.MediaTelemetry
import app.teamstation.streamcore.stream.NetworkPathMonitoring
import app.teamstation.streamcore.stream.ProgramStreamer
import app.teamstation.streamcore.stream.StreamEncoderConfig
import app.teamstation.streamcore.stream.StreamRetryScheduling
import app.teamstation.streamcore.stream.StreamRetryTimer
import app.teamstation.streamcore.stream.StreamSessionController
import app.teamstation.streamcore.stream.StreamSettings
import app.teamstation.streamcore.stream.StreamVideoEncoding
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * The engine's state machine with a fake camera, microphone, stream and recording encoder, against
 * a real catalog and [app.teamstation.streamcore.record.ProgramEncoder], and a stand-in server for the
 * redial and the uploads.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneStreamEngineTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val requests = ConcurrentLinkedQueue<RecordedRequest>()

    /** How far the server's clock reads ahead of this phone's. */
    @Volatile
    private var clockSkew = 3.0

    /** What the next `PATCH …/live-streams/:id` are answered, in turn; then 200. */
    private val patchAnswers = ConcurrentLinkedQueue<MockResponse>()
    private val parts = mutableMapOf<Int, ByteArray>()

    /** What the stand-in server answers next to a live-stream request: a URL, or a status. */
    @Volatile
    private var liveStreamAnswer: MockResponse = stream("rtmp://ingest.example.test/live/key-0002")

    /** When set, part uploads wait on it: an upload cut off mid-way. */
    @Volatile
    private var partGate: CountDownLatch? = null

    @Volatile
    private var serverReceived = emptyList<Int>()

    /** The stand-in server's part size. */
    @Volatile
    private var partSize = 65_536

    /** When set, parts from this index on are refused and not kept: an upload cut off part-way. */
    @Volatile
    private var refuseFromPart: Int? = null

    private var uptime = 500.0
    private var wall = 1_760_000_000.0
    private var free = 10_000_000_000L
    private val steady = SteadyWall(wall = { 1_760_000_000.0 }, uptime = { 500.0 })
    private val mapping = CaptureClockMapping(steady, { (uptime * 1e9).toLong() }, { (uptime * 1e9).toLong() })
    private val dispatchers = mutableListOf<java.util.concurrent.ExecutorService>()

    private lateinit var device: FakeDevice
    private lateinit var microphone: FakeMicrophone
    private lateinit var streamOutput: FakeStream
    private lateinit var scheduler: FakeScheduler
    private lateinit var monitor: FakeMonitor
    private lateinit var foreground: Foreground
    private val videos = mutableListOf<FakeVideo>()
    private var failVideo = false
    private val events = ConcurrentLinkedQueue<PhoneStreamEvent>()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path ?: ""
                return when {
                    path.endsWith("/api/v1/time") -> json("""{"serverTime":${Math.round((wall + clockSkew) * 1000)}}""")
                    request.method == "PATCH" && path.contains("/live-streams/") -> patchAnswers.poll() ?: json("{}")
                    path.contains("/live-streams") -> liveStreamAnswer
                    request.method == "POST" && path.endsWith("/director/uploads") ->
                        json("""{"uploadId":"u1","partSize":$partSize,"parts":${partsFor(JSONObject(request.body.clone().readUtf8()).getLong("sizeBytes"))},"received":[]}""")
                    request.method == "PUT" -> {
                        val index = path.substringAfterLast('/').toInt()
                        if (refuseFromPart?.let { index >= it } == true) {
                            MockResponse().setResponseCode(503).setBody("""{"message":"cut off"}""")
                        } else {
                            partGate?.await(2, TimeUnit.SECONDS)
                            synchronized(parts) { parts[index] = request.body.readByteArray() }
                            json("""{"received":${parts.size},"parts":0,"missing":[]}""")
                        }
                    }
                    request.method == "GET" && path.contains("/director/uploads/") -> {
                        val received = synchronized(parts) { parts.keys.sorted() }
                        val state = if (path.endsWith("ready")) "ready" else "open"
                        json(
                            """{"uploadId":"u1","state":"$state","partSize":$partSize,"parts":${uploadParts},"received":${received},"missing":[],"receivedBytes":0,"videoId":"v1"}"""
                        )
                    }
                    path.endsWith("/finish") -> json("""{"videoId":"v1","state":"ready"}""")
                    request.method == "DELETE" -> MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @Volatile
    private var uploadParts = 0

    private fun partsFor(size: Long): Int = ((size + partSize - 1) / partSize).toInt().also { uploadParts = it }

    @After
    fun tearDown() {
        partGate?.countDown()
        server.shutdown()
        dispatchers.forEach { it.shutdownNow() }
    }

    private fun json(body: String) = MockResponse().setResponseCode(200).setBody(body)

    private fun stream(url: String) = json("""{"id":"s1","label":"Home Plate","url":"$url"}""")

    // MARK: - Fakes

    private class FakeDevice : PhoneCaptureDevice {
        override var onStateChange: ((CameraSession.State) -> Unit)? = null
        override var sensorTimestampsAreRealtime = true
        val attached = mutableMapOf<String, Surface>()
        var ticker: ProgrammeTicker? = null
        var configured: CameraPosition? = null
        var started = 0
        var closed = 0
        var flips = 0
        val zooms = mutableListOf<Pair<String, Double>>()
        var selection: LensSelection? = null
        var preview: Surface? = null
        val lenses = listOf(
            CameraLens("wide", CameraPosition.BACK, "2", 24, 1.0, 1.0),
            CameraLens("ultra", CameraPosition.BACK, "3", 13, 0.5, 0.5)
        )

        override fun configure(position: CameraPosition, settings: app.teamstation.streamcore.core.StreamSettings) {
            configured = position
        }

        override fun start() {
            started += 1
        }

        override fun close() {
            closed += 1
        }

        override fun flip() {
            flips += 1
        }

        override fun setDeviceZoom(value: Double) {
            zooms += "device" to value
        }

        override fun setDisplayedZoom(value: Double) {
            zooms += "displayed" to value
        }

        override fun setLensSelection(selection: LensSelection) {
            this.selection = selection
        }

        override fun lensCatalog(): List<CameraLens> = lenses

        override fun attachEncoder(key: String, surface: Surface?) {
            if (surface == null) attached.remove(key) else attached[key] = surface
        }

        override fun detachEncoder(key: String) {
            attached.remove(key)
        }

        override fun attachPreview(surface: Surface?, width: Int, height: Int) {
            preview = surface
        }

        override fun setProgramme(ticker: ProgrammeTicker?) {
            this.ticker = ticker
        }

        var rotation: Int? = null
        override fun setDisplayRotation(degrees: Int) {
            rotation = degrees
        }
    }

    private class FakeMicrophone : PhoneMicrophone {
        var onSound: ((ShortArray, Double) -> Unit)? = null
        var opens = true
        override fun start(onSound: (ShortArray, Double) -> Unit): Boolean {
            this.onSound = onSound
            return opens
        }

        override fun stop() {
            onSound = null
        }
    }

    /** The recording's encoder: every picture drawn comes straight out, a keyframe every 2 s. */
    private class FakeVideo : StreamVideoEncoding {
        var output: StreamVideoEncoding.Output? = null
        var config: StreamEncoderConfig? = null
        var drawn = 0
        var finished = false
        var closed = false

        override fun open(config: StreamEncoderConfig, output: StreamVideoEncoding.Output): Surface {
            this.config = config
            this.output = output
            return Surface(SurfaceTexture(1))
        }

        fun draw(presentationNanos: Long) {
            val keyframe = drawn % 60 == 0
            val sets = if (keyframe) listOf(FragmentedMp4WriterTest.vps, FragmentedMp4WriterTest.sps, FragmentedMp4WriterTest.pps) else emptyList()
            drawn += 1
            output?.onFrame(EncodedVideoFrame(listOf(byteArrayOf(if (keyframe) 0x26 else 0x02, 1, 2, 3)), sets, keyframe, presentationNanos / 1e9))
        }

        override fun requestSyncFrame() = Unit
        override fun setBitrate(bitrate: Int) = Unit
        override fun finishInput(timeoutMillis: Long) {
            finished = true
        }

        override fun close() {
            closed = true
        }
    }

    private class FakeStream : PhoneStreamOutput {
        val starts = mutableListOf<String>()
        var failNext: Throwable? = null
        var drop: ((String) -> Unit)? = null
        var surfaceListener: ((Surface?) -> Unit)? = null
        var drawn = 0
        var sound = 0
        var settings: StreamSettings? = null
        override var running = false
        override var liveTimelineStart: Double? = null
        override val metrics = ProgramStreamer.Metrics(rate = app.teamstation.streamcore.stream.StreamRateTelemetry(bitrate = 2_000_000))

        override suspend fun start(urlString: String, settings: StreamSettings, onFailure: ((String) -> Unit)?) {
            starts += urlString
            this.settings = settings
            failNext?.let {
                failNext = null
                throw it
            }
            drop = onFailure
            running = true
            surfaceListener?.invoke(Surface(SurfaceTexture(2)))
        }

        override fun stop() {
            if (running) surfaceListener?.invoke(null)
            running = false
        }

        override fun admit(presentationTime: Double): Boolean = running
        override fun append(audio: AudioFrame) {
            if (running) sound += 1
        }

        override fun onInputSurface(listener: ((Surface?) -> Unit)?) {
            surfaceListener = listener
        }
    }

    private class FakeScheduler : StreamRetryScheduling {
        val waits = mutableListOf<Double>()
        var pending: (() -> Unit)? = null
        override fun schedule(afterSeconds: Double, action: () -> Unit): StreamRetryTimer {
            waits += afterSeconds
            pending = action
            return StreamRetryTimer { pending = null }
        }
    }

    private class FakeMonitor : NetworkPathMonitoring {
        var onSatisfied: (() -> Unit)? = null
        override fun start(onSatisfied: () -> Unit) {
            this.onSatisfied = onSatisfied
        }

        override fun cancel() {
            onSatisfied = null
        }
    }

    private class FakeStatus : PhoneDeviceStatusReading {
        override fun battery() = app.teamstation.streamcore.core.BatteryStatus(64, isCharging = true)
        override fun thermal() = app.teamstation.streamcore.core.ThermalBadgeLevel.FAIR
    }

    private class Foreground : PhoneForegroundWork {
        val calls = mutableListOf<String>()
        override fun recordingStarted(angleName: String) {
            calls += "recording $angleName"
        }

        override fun recordingStopped() {
            calls += "stopped"
        }

        override fun uploadStarted(angleName: String) {
            calls += "upload $angleName"
        }

        override fun uploadsFinished() {
            calls += "uploads done"
        }
    }

    // MARK: - Harness

    private lateinit var engineDispatcher: CoroutineDispatcher

    private fun engine(): PhoneStreamEngine {
        device = FakeDevice()
        microphone = FakeMicrophone()
        streamOutput = FakeStream()
        scheduler = FakeScheduler()
        monitor = FakeMonitor()
        foreground = Foreground()
        val executor = Executors.newSingleThreadExecutor()
        dispatchers += executor
        engineDispatcher = executor.asCoroutineDispatcher()
        val environment = PhoneStreamEnvironment(
            storage = PhoneStorage(File(folder.root, "phoneStream")),
            clock = { wall },
            uptime = { uptime },
            makeSource = { PhoneCameraSource(device, microphone, mapping, { wall }, runsSoundThread = false) },
            makeRecordingVideoEncoder = {
                if (failVideo) error("no encoder")
                FakeVideo().also { videos += it }
            },
            makeRecordingAudioEncoder = { CountingAac() },
            makeStream = { _: MediaTelemetry, _: () -> Double, _: (Double) -> Double -> streamOutput },
            freeDiskBytes = { free },
            uploadSleep = {},
            makeRetryScheduler = { scheduler },
            makePathMonitor = { monitor },
            heartbeatSeconds = 3_600.0,
            statusIntervalSeconds = 3_600.0,
            storageCheckSeconds = 3_600.0,
            stopTailSeconds = 0.0,
            deviceStatus = FakeStatus(),
            makeRadar = {
                val context = RuntimeEnvironment.getApplication()
                PhoneRadar(
                    app.teamstation.streamcore.radar.RadarFleet(
                        store = PhoneRadar.store(context),
                        newRadio = { app.teamstation.streamcore.radar.systemRadarRadio(context) },
                        bluetoothOn = { false },
                        locationOn = { true },
                        permissionsGranted = { true },
                        log = {},
                        later = { _, _ -> }
                    )
                ) { false }
            },
            foreground = foreground,
            dispatcher = engineDispatcher,
            ioDispatcher = Dispatchers.IO
        )
        return PhoneStreamEngine(environment).also { engine ->
            engine.observe { events += it }
        }
    }

    private fun <T> on(work: suspend () -> T): T = runBlocking { withContext(engineDispatcher) { work() } }

    private val request get() = PhoneStreamRequest(server.url("/api/v1").toString(), "token-0000", "00000000-0000-4000-8000-0000000000aa", "Google Pixel 10")

    /** [seconds] of camera and microphone at 30 fps, every picture the programme draws coded at once. */
    private fun capture(seconds: Double) {
        repeat((seconds * 30).toInt()) {
            uptime += 1.0 / 30
            wall += 1.0 / 30
            microphone.onSound?.invoke(ShortArray(1_600) { 100 }, wall - 0.04)
            val draws = device.ticker!!.tick(((uptime - 0.03) * 1e9).toLong(), device.attached.keys.toSet())
            for (draw in draws) {
                when (draw.key) {
                    PhoneProgramme.RECORDING_KEY -> videos.last().draw(draw.presentationNanos)
                    PhoneProgramme.STREAM_KEY -> streamOutput.drawn += 1
                }
            }
            on { } // let the engine run what the tick queued
            onSoundThread()
        }
    }

    private fun onSoundThread() = (device.ticker as? PhoneProgramme)?.let { _ -> currentEngine.mix.pump(wall) }

    private lateinit var currentEngine: PhoneStreamEngine

    private fun opened(): PhoneStreamEngine = engine().also {
        currentEngine = it
        runBlocking { it.open("Home Plate") }
    }

    private fun start(engine: PhoneStreamEngine, stream: String = "s1") = runBlocking {
        engine.startRecording("rtmp://ingest.example.test/live/key-0001", stream, "g1", "Home Plate", request)
        on { }
    }

    private fun statuses() = events.filterIsInstance<PhoneStreamEvent.Status>().map { it.status }

    private fun uploads() = events.filterIsInstance<PhoneStreamEvent.Upload>().map { it.upload }

    private fun expect(code: PhoneStreamError, work: suspend () -> Unit) {
        try {
            runBlocking { work() }
            fail("expected $code")
        } catch (error: PhoneStreamException) {
            assertEquals(code, error.code)
        }
    }

    // MARK: - Tests

    @Test
    fun recordingAndStreamRunFromOneTickAndTheStreamComesBackWhileTheRecordingCarriesOn() {
        val engine = opened()
        assertEquals(CameraPosition.BACK, device.configured)
        assertEquals(1, device.started)
        assertTrue(engine.isOpen)
        // A second open applies its arguments to the open engine.
        runBlocking { engine.open("Home Plate", audioEnabled = false, disabledLenses = setOf("ultra")) }
        assertFalse(engine.mix.soundEnabled)
        assertEquals(LensSelection(setOf("ultra")), device.selection)
        runBlocking { engine.setAudioEnabled(true) }
        engine.attachPreview(Surface(SurfaceTexture(3)), 1920, 1080)
        assertNotNull(device.preview)

        start(engine)
        assertEquals(listOf("rtmp://ingest.example.test/live/key-0001"), streamOutput.starts)
        assertEquals(PhoneStreamProfile.streamSettings, streamOutput.settings)
        assertEquals(StreamSessionController.Phase.LIVE, engine.streamController.phase)
        // The phone replaces a connection that stops moving, which TS Director does not.
        assertEquals(PhoneStreamProfile.stallRedialSeconds, engine.streamController.stallRedialSeconds)
        assertTrue(engine.isRecording)
        assertTrue(engine.isStreaming)
        assertEquals(listOf("recording Home Plate"), foreground.calls)
        assertEquals(PhoneStreamProfile.recordingEncoderConfig, videos.single().config)
        assertEquals(setOf(PhoneProgramme.RECORDING_KEY, PhoneProgramme.STREAM_KEY), device.attached.keys)
        // A second start while recording is refused.
        expect(PhoneStreamError.NOT_READY) { engine.startRecording("rtmp://x", "s1", "g1", "Home Plate", request) }

        capture(3.0)
        // The first four ticks come before the first picture's moment, 0.15 s after its capture.
        val recorded = engine.programme.recordingFramesSent
        assertEquals(86L, recorded)
        assertEquals(86, streamOutput.drawn)
        assertTrue(streamOutput.sound > 100)
        var status = on { engine.status }
        assertEquals("live", status.phase)
        assertEquals(2_000, status.bitrateKbps)
        assertEquals(64, status.batteryPercent)
        assertTrue(status.charging)
        assertEquals("fair", status.thermal)
        assertEquals(3.0, status.recordingSeconds, 0.05)
        assertTrue(status.isRecording)
        assertEquals("24 mm", status.lensLabel)

        // The stream drops: it waits 3 s to redial, and the recording misses no grid slot meanwhile.
        on { streamOutput.drop!!("peer went away") }
        on { }
        assertEquals(StreamSessionController.Phase.RETRYING, engine.streamController.phase)
        status = on { engine.status }
        assertEquals("retrying", status.phase)
        assertEquals(3.0, status.retryInSeconds!!, 0.0)
        capture(2.0)
        assertEquals(recorded + 60, engine.programme.recordingFramesSent)
        assertEquals(86, streamOutput.drawn)

        // The redial asks for the held stream, and goes live on the URL the server gives.
        on { scheduler.pending!!() }
        waitFor { streamOutput.starts.size == 2 }
        assertEquals("rtmp://ingest.example.test/live/key-0002", streamOutput.starts.last())
        val redial = requests.first { it.path!!.contains("/live-streams") }
        val body = JSONObject(redial.body.readUtf8())
        assertEquals("s1", body.getString("heldStreamId"))
        assertEquals("Home Plate", body.getString("label"))
        assertEquals("00000000-0000-4000-8000-0000000000aa", body.getString("deviceId"))
        assertEquals("Google Pixel 10", body.getString("deviceModel"))
        waitFor { engine.streamController.phase == StreamSessionController.Phase.LIVE }

        // The network coming back while waiting redials at once; offline, the held URL is used.
        on { streamOutput.drop!!("peer went away") }
        liveStreamAnswer = MockResponse().setResponseCode(503)
        on { monitor.onSatisfied!!() }
        waitFor { streamOutput.starts.size == 3 }
        assertEquals("rtmp://ingest.example.test/live/key-0002", streamOutput.starts.last())
        waitFor { engine.streamController.phase == StreamSessionController.Phase.LIVE }

        // A 410 ends the stream for good, and the recording carries on.
        on { streamOutput.drop!!("peer went away") }
        liveStreamAnswer = MockResponse().setResponseCode(410)
        on { scheduler.pending!!() }
        waitFor { engine.streamController.phase == StreamSessionController.Phase.IDLE }
        assertEquals(StreamSessionController.endedError, engine.streamController.lastError)
        assertEquals(PhoneStreamError.STREAM_ENDED, statuses().last().error)
        assertTrue(engine.isRecording)
        val before = engine.programme.recordingFramesSent
        capture(1.0)
        assertEquals(before + 30, engine.programme.recordingFramesSent)

        runBlocking { engine.stopRecording() }
        assertFalse(engine.isRecording)
        assertFalse(engine.isStreaming)
        assertTrue(videos.single().finished)
        assertTrue(videos.single().closed)
        assertTrue(device.attached.isEmpty())
        assertEquals("stopped", foreground.calls.last())
        val take = runBlocking { engine.recordings() }.single()
        assertEquals("s1", take.liveStreamId)
        assertEquals("g1", take.gameId)
        assertEquals("Home Plate", take.angleName)
        assertEquals(1, take.parts)
        assertNotNull(take.endedAt)
        assertTrue(take.coversWholeStream)
        assertNull(on { engine.catalog.live() })
        // The part holds every grid slot, and its sound reaches its picture.
        val file = File(engine.environment.storage.program, engine.index.recording(take.recordingID)!!.programFilenames.single())
        val reading = FragmentedMp4Reader.read(file)!!
        assertEquals(6.0, reading.video!!.endSeconds!!, 1.0 / 30 + 1e-6)
        val sound = reading.audio!!
        assertTrue(sound.endSeconds!! - sound.mediaTime.toDouble() / sound.timescale >= reading.video!!.endSeconds!! - 0.03)
        runBlocking { engine.stopRecording() }

        runBlocking { engine.close() }
        assertEquals(1, device.closed)
        assertFalse(engine.isOpen)
        runBlocking { engine.close() }
    }

    @Test
    fun aKilledTakeContinuesAsItsNextPartAndUploadsAsOneSpanningTheWallClock() {
        val first = opened()
        start(first)
        val startedAt = wall
        // The stream's first picture goes out, and the take keeps the server's clock offset (3 s).
        streamOutput.liveTimelineStart = wall
        on { first.publishStatus() }
        runBlocking { first.liveStartReport!!.join() }
        assertEquals(3.0, runBlocking { first.recordings() }.single().serverClockOffset!!, 0.05)
        capture(4.0)
        // The process dies: nothing is finished.
        runBlocking { first.abandonForTesting() }
        wall += 20.0
        uptime += 20.0

        val second = opened()
        val interrupted = runBlocking { second.interruptedSession() }!!
        assertEquals("s1", interrupted.liveStreamId)
        assertEquals("g1", interrupted.gameId)
        assertEquals("Home Plate", interrupted.angleName)
        assertTrue(interrupted.streaming)
        assertNotNull(interrupted.recordingID)
        assertTrue(interrupted.downtime >= 20.0)
        assertTrue(runBlocking { second.resumeInterrupted(request) })
        assertNull(runBlocking { second.interruptedSession() })
        // The resume redials the stream it held, never the URL from before the kill as a start.
        waitFor { streamOutput.starts.size == 1 }
        assertEquals("rtmp://ingest.example.test/live/key-0002", streamOutput.starts.single())
        assertEquals("s1", JSONObject(requests.first { it.method == "POST" && it.path!!.contains("/live-streams") }.body.readUtf8()).getString("heldStreamId"))
        capture(3.0)
        runBlocking { second.stopRecording() }
        val endedAt = wall

        val take = runBlocking { second.recordings() }.single()
        assertEquals(2, take.parts)
        assertEquals(startedAt, take.startedAt, 1.0 / 30)
        val anchors = second.index.programAnchors(take.recordingID)
        assertEquals(setOf(1, 2), anchors.map { it.part }.toSet())
        // Part 2 is timed from its first picture: it starts after the 20 s away, not before.
        val starts = app.teamstation.streamcore.record.RecordingCatalog.partStarts(anchors)
        assertEquals(24.0, starts.getValue(2) - starts.getValue(1), 0.1)

        // The server's clock now reads 5 s ahead, as a phone's drifting clock would make it: the take
        // kept the offset from its recording, and the upload uses that one.
        clockSkew = 5.0
        val video = runBlocking { second.uploadRecording("s1", server.url("/api/v1/").toString(), "token-0000", "Home Plate") }
        assertEquals("v1", video)
        val open = requests.first { it.method == "POST" && it.path!!.endsWith("/director/uploads") }
        val body = JSONObject(open.body.readUtf8())
        assertEquals("s1", body.getString("liveStreamId"))
        assertTrue(body.getBoolean("wholeStream"))
        assertEquals("g1", body.getString("gameId"))
        assertEquals("program", body.getString("kind"))
        // It starts where part 1's first picture was captured, not where Record was pressed.
        val partOne = starts.getValue(1)
        assertEquals(partOne, PhoneStreamEngine.uploadStart(anchors, take.startedAt), 0.0)
        assertNotEquals(take.startedAt, partOne, 1e-6)
        assertEquals(take.startedAt, partOne, 0.5)
        // On the server's clock, which reads 3 s ahead of the phone's.
        assertEquals(app.teamstation.streamcore.upload.UploadClient.instant(partOne + 3.0), body.getString("startAt"))
        val uploaded = runBlocking { second.recordings() }.single()
        assertTrue(uploaded.isUploaded)
        assertEquals("v1", uploaded.videoId)
        assertFalse(second.environment.storage.export(take.recordingID).exists())
        assertEquals(PhoneUploadProgress.State.UPLOADED, uploads().last().state)
        assertTrue(uploads().any { it.state == PhoneUploadProgress.State.EXPORTING })
        assertTrue(foreground.calls.containsAll(listOf("upload Home Plate", "uploads done")))
        // What the server received spans the take's wall clock within a frame, the hole held.
        val sent = ByteArrayOutputStream().apply { synchronized(parts) { parts.toSortedMap().values.forEach { write(it) } } }.toByteArray()
        val export = folder.newFile("export.mp4").apply { writeBytes(sent) }
        val reading = FragmentedMp4Reader.read(export)!!
        assertEquals(endedAt - partOne, reading.video!!.endSeconds!!, 1.0 / 30 + 1e-6)
        // Uploaded, it is not sent again, and the stream's next take is a new one.
        assertEquals("v1", runBlocking { second.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") })
        requests.clear()
        liveStreamAnswer = stream("rtmp://ingest.example.test/live/key-0003")
        runBlocking { second.startRecording("rtmp://ingest.example.test/live/key-0003", "s1", "g1", "Home Plate", request) }
        assertEquals(2, runBlocking { second.recordings() }.size)
        runBlocking { second.stopRecording() }
    }

    @Test
    fun anOrdinaryTakeIsCopiedNotRebuilt() {
        // One part, never resumed, its first picture captured a picture delay before Record: the hold
        // at Stop reaches the take's end on the wall clock, so the export copies the part as it is.
        val engine = opened()
        // The preview runs before Record, so the part's first picture was captured before the take began.
        capture(1.0)
        start(engine)
        capture(5.0)
        runBlocking { engine.stopRecording() }
        val take = runBlocking { engine.recordings() }.single()
        assertEquals(1, take.parts)
        val partStart = app.teamstation.streamcore.record.RecordingCatalog.partStarts(engine.index.programAnchors(take.recordingID)).getValue(1)
        assertEquals(take.startedAt - PhoneStreamProfile.pictureDelaySeconds, partStart, 0.05)
        runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") }
        val export = engine.lastExport!!
        assertTrue(export.plan.description, export.plan is app.teamstation.streamcore.record.ProgrammeExport.Plan.Copy)
    }

    @Test
    fun theLiveVideoIsPlacedByTheFirstPublishedPictureOncePerSession() {
        val engine = opened()
        start(engine)
        // Nothing has gone out yet: nothing to say.
        on { engine.publishStatus() }
        assertTrue(requests.none { it.method == "PATCH" })
        // The first picture went out, captured a picture delay before; the server is away once.
        val captured = wall - 0.15
        streamOutput.liveTimelineStart = captured
        patchAnswers += MockResponse().setResponseCode(503)
        on { engine.publishStatus() }
        on { engine.publishStatus() }
        runBlocking { engine.liveStartReport!!.join() }
        val patches = requests.filter { it.method == "PATCH" }
        assertEquals(2, patches.size)
        for (patch in patches) {
            assertEquals("/api/v1/games/g1/live-streams/s1", patch.path)
            // On the server's clock, which reads 3 s ahead of the phone's.
            assertEquals(app.teamstation.streamcore.upload.UploadClient.instant(captured + 3.0), JSONObject(patch.body.clone().readUtf8()).getString("liveStartedAt"))
        }
        // A redial in the same session says nothing more.
        on { engine.publishStatus() }
        assertEquals(2, requests.count { it.method == "PATCH" })
        runBlocking { engine.stopRecording() }

        // A new session on an ended stream says it once, and stops at the 410.
        start(engine, "s2")
        patchAnswers += MockResponse().setResponseCode(410)
        on { engine.publishStatus() }
        runBlocking { engine.liveStartReport!!.join() }
        assertEquals(1, requests.count { it.method == "PATCH" && it.path!!.endsWith("/s2") })
        runBlocking { engine.stopRecording() }
        assertEquals(PhoneStreamEngine.uploadStart(emptyList(), 12.5), 12.5, 0.0)
    }

    @Test
    fun anUploadThatWasCutOffResumesOnceAndBlocksAnotherPart() {
        val first = opened()
        start(first)
        capture(3.0)
        runBlocking { first.stopRecording() }
        // Record again on the same stream: the same take, as its next part.
        start(first)
        capture(1.0)
        runBlocking { first.stopRecording() }
        assertEquals(2, runBlocking { first.recordings() }.single().parts)
        assertEquals(1, runBlocking { first.recordings() }.size)

        expect(PhoneStreamError.NO_RECORDING) { first.uploadRecording("s9", server.url("/").toString(), "token-0000", "x") }
        // The upload is cut off in its first part.
        partGate = CountDownLatch(1)
        val running = Thread {
            runCatching { runBlocking { first.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") } }
        }.apply { start() }
        waitFor { requests.any { it.method == "PUT" } }
        assertEquals(1, runBlocking { first.runningUploads() }.size)
        // A second ask joins the one running instead of starting another.
        assertEquals(0, runBlocking { first.resumePendingUploads(server.url("/").toString(), "token-0000") })
        // While its upload runs, or is cut off, the stream takes no new part.
        expect(PhoneStreamError.UPLOAD_IN_PROGRESS) {
            first.startRecording("rtmp://ingest.example.test/live/key-0001", "s1", "g1", "Home Plate", request)
        }
        expect(PhoneStreamError.UPLOAD_IN_PROGRESS) { first.deleteRecording("s1") }
        runBlocking { first.interruptUploads() }
        running.join(5_000)
        partGate!!.countDown()
        partGate = null
        val cut = runBlocking { first.recordings() }.single()
        assertEquals("u1", cut.uploadId)
        assertEquals("Home Plate", cut.uploadTitle)
        assertFalse(cut.isUploaded)
        assertTrue(runBlocking { first.runningUploads() }.isEmpty())
        expect(PhoneStreamError.UPLOAD_IN_PROGRESS) {
            first.startRecording("rtmp://ingest.example.test/live/key-0001", "s1", "g1", "Home Plate", request)
        }
        runBlocking { first.abandonForTesting() }

        // A relaunch carries on with the upload it opened: one run, however often it is asked.
        val second = opened()
        requests.clear()
        val started = runBlocking { second.resumePendingUploads(server.url("/").toString(), "token-0000") }
        val again = runBlocking { second.resumePendingUploads(server.url("/").toString(), "token-0000") }
        assertEquals(1, started)
        assertEquals(0, again)
        waitFor { runBlocking { second.recordings() }.single().isUploaded }
        assertTrue(requests.none { it.method == "POST" && it.path!!.endsWith("/director/uploads") })
        assertEquals(1, requests.count { it.method == "GET" && it.path!!.endsWith("/director/uploads/u1") })
        assertEquals("v1", runBlocking { second.recordings() }.single().videoId)
    }

    @Test
    fun whereARunningUploadStandsIsReadFromTheEngineAfterARelaunch() {
        partSize = 1_024
        val first = opened()
        start(first)
        capture(3.0)
        runBlocking { first.stopRecording() }
        // Cut off after its first part: the server has that one and refuses the rest.
        refuseFromPart = 1
        runCatching { runBlocking { first.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") } }
        assertTrue(first.runningUploadProgress().isEmpty())
        assertEquals(PhoneUploadProgress.State.FAILED, uploads().last().state)
        val take = runBlocking { first.recordings() }.single()
        assertTrue(take.hasPendingUpload)
        assertTrue(uploadParts > 2)
        runBlocking { first.abandonForTesting() }

        // The relaunch resumes it before anything listens: where it stands is read from the engine,
        // from the part the server already had, not from nothing.
        refuseFromPart = null
        partGate = CountDownLatch(1)
        val second = opened()
        requests.clear()
        assertEquals(1, runBlocking { second.resumePendingUploads(server.url("/").toString(), "token-0000") })
        waitFor { requests.any { it.method == "PUT" } }
        val partway = second.runningUploadProgress()[take.recordingID] ?: error("no progress for the running upload")
        assertEquals(PhoneUploadProgress.State.UPLOADING, partway.state)
        assertEquals("s1", partway.liveStreamId)
        assertEquals(1_024L, partway.bytesSent)
        assertEquals(1_024.0 / partway.bytesTotal, partway.fraction, 1e-9)
        partGate!!.countDown()
        partGate = null
        waitFor { runBlocking { second.recordings() }.single().isUploaded }
        waitFor { second.runningUploadProgress().isEmpty() }
    }

    @Test
    fun anUploadCanBeCancelledAndATakeDeleted() {
        val engine = opened()
        start(engine)
        capture(2.0)
        expect(PhoneStreamError.STILL_RECORDING) { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "x") }
        expect(PhoneStreamError.STILL_RECORDING) { engine.deleteRecording("s1") }
        runBlocking { engine.stopRecording() }
        partGate = CountDownLatch(1)
        Thread { runCatching { runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") } } }.start()
        waitFor { requests.any { it.method == "PUT" } }
        runBlocking { engine.cancelUpload("s1") }
        partGate!!.countDown()
        assertTrue(requests.any { it.method == "DELETE" && it.path!!.endsWith("/director/uploads/u1") })
        val take = runBlocking { engine.recordings() }.single()
        assertNull(take.uploadId)
        assertFalse(engine.environment.storage.export(take.recordingID).exists())
        runBlocking { engine.cancelUpload("s9") }
        runBlocking { engine.deleteRecording("s1") }
        runBlocking { engine.deleteRecording("s1") }
        assertTrue(runBlocking { engine.recordings() }.isEmpty())
    }

    @Test
    fun lowStorageRefusesAStartAndFinishesARunningPartWhileTheStreamGoesOn() {
        val engine = opened()
        free = 1_000_000_000
        expect(PhoneStreamError.INSUFFICIENT_STORAGE) {
            engine.startRecording("rtmp://ingest.example.test/live/key-0001", "s1", "g1", "Home Plate", request)
        }
        assertEquals(PhoneStreamError.INSUFFICIENT_STORAGE, statuses().last().error)
        free = 10_000_000_000
        start(engine)
        capture(2.0)
        free = 400_000_000
        runBlocking { withContext(engineDispatcher) { engine.checkStorage() } }
        assertFalse(engine.isRecording)
        assertTrue(engine.isStreaming)
        assertEquals(PhoneStreamError.RECORDING_STOPPED_LOW_STORAGE, statuses().last().error)
        on { engine.publishStatus() }
        val take = runBlocking { engine.recordings() }.single()
        assertTrue(take.stoppedForLowStorage)
        assertTrue(take.publishedOutsideParts)
        assertNotNull(take.endedAt)
        // Nothing more to stop for.
        runBlocking { withContext(engineDispatcher) { engine.checkStorage() } }
        runBlocking { engine.stopRecording() }
        free = 10_000_000_000
        runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") }
        val body = JSONObject(requests.first { it.method == "POST" && it.path!!.endsWith("/director/uploads") }.body.readUtf8())
        assertFalse(body.has("wholeStream"))
    }

    @Test
    fun aKilledTakeOnAStreamNoLongerWantedIsClosedWhereItGotTo() {
        val first = opened()
        start(first)
        capture(4.0)
        runBlocking { first.abandonForTesting() }
        val second = opened()
        // Record video on another angle: the take the kill left open ends at its last anchor.
        runBlocking {
            second.startRecording("rtmp://ingest.example.test/live/key-0009", "s2", "g1", "First Base", request)
        }
        val closed = runBlocking { second.recordings() }.first { it.liveStreamId == "s1" }
        assertNotNull(closed.endedAt)
        assertEquals(closed.startedAt + 3.0, closed.endedAt!!, 0.5)
        runBlocking { second.stopRecording() }
        // Away more than an hour, the take is closed and nothing resumes.
        start(second, stream = "s3")
        capture(1.0)
        runBlocking { second.abandonForTesting() }
        wall += 4_000
        val third = opened()
        assertNull(runBlocking { third.interruptedSession() })
        assertFalse(runBlocking { third.resumeInterrupted(request) })
        assertNotNull(runBlocking { third.recordings() }.first { it.liveStreamId == "s3" }.endedAt)
        assertFalse(runBlocking { third.resumeInterrupted(request) })
        runBlocking { third.close() }
        expect(PhoneStreamError.NOT_READY) { third.resumeInterrupted(request) }
    }

    @Test
    fun aRecordingThatCannotStartSaysSoAndNotOpenIsNotReady() {
        val engine = engine()
        currentEngine = engine
        expect(PhoneStreamError.NOT_READY) { engine.startRecording("rtmp://x", "s1", "g1", "Home Plate", request) }
        runBlocking { engine.open("Home Plate") }
        failVideo = true
        expect(PhoneStreamError.RECORDING_FAILED) { engine.startRecording("rtmp://x", "s1", "g1", "Home Plate", request) }
        assertFalse(engine.isRecording)
        assertFalse(engine.isStreaming)
        assertEquals(PhoneStreamError.RECORDING_FAILED, statuses().last().error)
        assertNotNull(engine.telemetry.lastRecordingError)
    }

    @Test
    fun theCameraControlsReachTheCamera() {
        val engine = opened()
        val mapping = ZoomMapping(minimumDeviceZoom = 1.0, maximumDeviceZoom = 10.0, displayMultiplier = 0.5, switchOverDeviceZooms = listOf(2.0, 10.0))
        device.onStateChange!!(CameraSession.State(mapping = mapping, deviceZoom = 4.0))
        on { }
        runBlocking { engine.setZoom(2.0) }
        runBlocking { engine.pinch(1.5) }
        runBlocking { engine.pinch(2.0, ended = true) }
        assertEquals(listOf("displayed" to 2.0, "device" to mapping.pinchedDeviceZoom(4.0, 1.5), "device" to mapping.pinchedDeviceZoom(4.0, 2.0)), device.zooms)
        val scale = runBlocking { engine.zoomScale() }
        assertEquals(mapping.presetDisplayedZooms, scale.presets)
        assertEquals(listOf(1.0, 5.0), scale.switchOvers)
        assertEquals(0.5, scale.minimum, 0.0)
        assertEquals(5.0, scale.maximum, 0.0)
        assertEquals(2.0, scale.current, 0.0)
        val lenses = runBlocking { engine.lenses() }
        assertEquals(listOf(true, true), lenses.map { it.enabled })
        runBlocking { engine.setDisabledLenses(setOf("ultra")) }
        assertEquals(LensSelection(setOf("ultra")), device.selection)
        val after = runBlocking { engine.lenses() }
        assertEquals(listOf(true, false), after.map { it.enabled })
        assertEquals(listOf(false, true), after.map { it.canDisable })
        // Both off would leave the back camera with none: nothing changes.
        device.selection = null
        runBlocking { engine.setDisabledLenses(setOf("ultra", "wide")) }
        assertEquals(LensSelection(emptySet()), device.selection)
        runBlocking { engine.flip() }
        assertEquals(1, device.flips)
        runBlocking { engine.setDisplayRotation(270) }
        assertEquals(270, device.rotation)
        runBlocking { engine.setAngleName("First Base") }
        assertEquals("First Base", engine.angleName)
        runBlocking { engine.setAudioEnabled(false) }
        assertFalse(engine.audioEnabled)
        // The radar card.
        assertFalse(runBlocking { engine.radarState() }.enabled)
        runBlocking { engine.radarSetEnabled(true) }
        runBlocking { engine.radarScan() }
        assertTrue(runBlocking { engine.radarState() }.scanning)
        runBlocking { engine.radarStopScan() }
        assertTrue(runBlocking { engine.radarPair("ADFA0000001") })
        runBlocking { engine.radarUnpair("ADFA0000001") }
        waitFor { events.any { it is PhoneStreamEvent.Radar } }
        runBlocking { engine.radarSetEnabled(false) }
    }

    @Test
    fun theProcessHasOneEngine() {
        val context = RuntimeEnvironment.getApplication()
        val engine = PhoneStreamEngine.shared(context)
        assertSame(engine, PhoneStreamEngine.shared(context))
        assertEquals(File(context.filesDir, "phoneStream"), engine.environment.storage.root)
        val live = PhoneStreamEnvironment.live(context)
        assertTrue(live.makeRecordingVideoEncoder() is app.teamstation.streamcore.stream.MediaCodecStreamEncoder)
        assertTrue(live.makeStream(MediaTelemetry.None, { 0.0 }, { it }) is ProgramStreamerOutput)
        assertTrue(live.freeDiskBytes() > 0)
        assertNotNull(live.makePathMonitor())
        assertTrue(live.makeSource().device is CameraSessionDevice)
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 10_000_000_000L
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("timed out")
            on { }
            Thread.sleep(5)
        }
    }

    @Suppress("unused")
    private fun near(a: Double, b: Double, within: Double) = abs(a - b) <= within
}
