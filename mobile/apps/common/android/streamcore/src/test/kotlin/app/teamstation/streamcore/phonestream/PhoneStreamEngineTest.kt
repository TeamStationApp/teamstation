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
import kotlinx.coroutines.launch
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
import org.junit.Assert.assertNotSame
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

    /** When set, the server's clock is not answered. */
    @Volatile
    private var timeFails = false

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

    /** When set, a part's encoder holds its finish until it is opened: a stop that takes a while. */
    @Volatile
    private var finishGate: CountDownLatch? = null
    private val events = ConcurrentLinkedQueue<PhoneStreamEvent>()

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                val path = request.path ?: ""
                return when {
                    path.endsWith("/api/v1/time") && timeFails -> MockResponse().setResponseCode(503)
                    path.endsWith("/api/v1/time") -> json("""{"now":${Math.round((wall + clockSkew) * 1000)}}""")
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

        @Volatile
        var reopens = 0
        override fun reopen() {
            reopens += 1
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
    private class FakeVideo(private val gate: () -> CountDownLatch?) : StreamVideoEncoding {
        var output: StreamVideoEncoding.Output? = null
        var config: StreamEncoderConfig? = null
        var drawn = 0

        @Volatile
        var finishing = false

        @Volatile
        var finished = false

        @Volatile
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
            finishing = true
            // A stop's encoder can take its time handing over its last pictures.
            gate()?.await(10, TimeUnit.SECONDS)
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
        override var serverClockOffsetMs: Int? = null
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

    /** The radar's own thread, standing in for the main thread the fleet belongs to. */
    private val radarExecutor = Executors.newSingleThreadExecutor { Thread(it, "radar-test") }.also { dispatchers += it }
    private val radarDispatcher = radarExecutor.asCoroutineDispatcher()

    /** The threads the radar fleet was driven from. */
    private val radarThreads = ConcurrentLinkedQueue<String>()

    /** Each open gets a camera of its own, as the app's does, rather than the one fake. */
    private var newDeviceEachOpen = false
    private var storageCheckSeconds = 3_600.0
    private var serverClockSeconds = 3_600.0
    private var cameraReopenSeconds = 3_600.0

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
            makeSource = {
                if (newDeviceEachOpen) device = FakeDevice()
                PhoneCameraSource(device, microphone, mapping, { wall }, runsSoundThread = false)
            },
            makeRecordingVideoEncoder = {
                if (failVideo) error("no encoder")
                FakeVideo { finishGate }.also { videos += it }
            },
            makeRecordingAudioEncoder = { CountingAac() },
            makeStream = { _: MediaTelemetry, _: () -> Double, _: (Double) -> Double -> streamOutput },
            freeDiskBytes = { free },
            uploadSleep = {},
            makeRetryScheduler = { scheduler },
            makePathMonitor = { monitor },
            heartbeatSeconds = 3_600.0,
            statusIntervalSeconds = 3_600.0,
            storageCheckSeconds = storageCheckSeconds,
            serverClockIntervalSeconds = serverClockSeconds,
            cameraReopenSeconds = cameraReopenSeconds,
            stopTailSeconds = 0.0,
            deviceStatus = FakeStatus(),
            makeRadar = {
                val context = RuntimeEnvironment.getApplication()
                PhoneRadar(
                    app.teamstation.streamcore.radar.RadarFleet(
                        store = PhoneRadar.store(context),
                        newRadio = { app.teamstation.streamcore.radar.systemRadarRadio(context) },
                        bluetoothOn = {
                            radarThreads += Thread.currentThread().name.substringBefore(" @coroutine")
                            false
                        },
                        locationOn = { true },
                        permissionsGranted = { true },
                        log = {},
                        later = { _, _ -> }
                    )
                ) { false }
            },
            foreground = foreground,
            dispatcher = engineDispatcher,
            ioDispatcher = Dispatchers.IO,
            radarDispatcher = radarDispatcher
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
        // On the phone's clock, with the offset to the server's that the take kept (3 s) beside it,
        // which the server adds.
        assertEquals(app.teamstation.streamcore.upload.UploadClient.instant(partOne), body.getString("startAt"))
        assertEquals(3_000, body.getInt("serverClockOffsetMs"))
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
    fun aRenameOnTheAirKeepsTheStreamAndEveryRedialAndResumeSendsTheNewLabel() {
        val first = opened()
        start(first)
        capture(1.0)
        runBlocking { first.setAngleName("First Base") }
        assertEquals("First Base", first.angleName)
        // The take and the live row carry the new name.
        assertEquals("First Base", runBlocking { first.recordings() }.single().angleName)
        assertEquals("First Base", on { first.catalog.live() }!!.angleName)
        // The stream drops: the redial asks for the same stream under the new label.
        on { streamOutput.drop!!("peer went away") }
        on { scheduler.pending!!() }
        waitFor { streamOutput.starts.size == 2 }
        val redial = JSONObject(requests.first { it.path!!.contains("/live-streams") }.body.readUtf8())
        assertEquals("s1", redial.getString("heldStreamId"))
        assertEquals("First Base", redial.getString("label"))
        // A rename to the same name changes nothing; one off the air renames only the screen's angle.
        runBlocking { first.setAngleName("First Base") }
        capture(1.0)
        runBlocking { first.abandonForTesting() }

        // Killed and resumed: the resume sends the new label with the stream held.
        requests.clear()
        val second = opened()
        assertEquals("First Base", runBlocking { second.interruptedSession() }!!.angleName)
        assertTrue(runBlocking { second.resumeInterrupted(request) })
        waitFor { streamOutput.starts.size == 1 }
        val resumed = JSONObject(requests.first { it.method == "POST" && it.path!!.contains("/live-streams") }.body.readUtf8())
        assertEquals("s1", resumed.getString("heldStreamId"))
        assertEquals("First Base", resumed.getString("label"))
        runBlocking { second.stopRecording() }
        runBlocking { second.setAngleName("Third Base") }
        assertEquals("Third Base", second.angleName)
        assertEquals("First Base", runBlocking { second.recordings() }.single().angleName)
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
    fun theStreamsFramesCarryTheServersClockMeasuredAsItStarts() {
        val engine = opened()
        start(engine)
        // Measured as the session starts streaming, on the server's clock 3 s ahead of the phone's.
        waitFor { streamOutput.serverClockOffsetMs != null }
        assertEquals(3_000, streamOutput.serverClockOffsetMs)
        val reads = requests.count { it.path!!.endsWith("/api/v1/time") }
        assertEquals(ServerClock.TRIPS_PER_SAMPLE, reads)
        assertTrue(engine.serverClockFollower!!.isActive)
        // The live start uses the same measurement.
        streamOutput.liveTimelineStart = wall - 0.15
        on { engine.publishStatus() }
        runBlocking { engine.liveStartReport!!.join() }
        assertEquals(reads, requests.count { it.path!!.endsWith("/api/v1/time") })
        // Stopped, it is measured no more, and the stream keeps the offset for the next publish.
        runBlocking { engine.stopRecording() }
        assertNull(engine.serverClockFollower)
        assertEquals(3_000, streamOutput.serverClockOffsetMs)
    }

    private fun timeReads() = requests.count { it.path!!.endsWith("/api/v1/time") }

    @Test
    fun theServersClockIsMeasuredAgainEachIntervalAndHeldThroughAMissAndARedial() {
        serverClockSeconds = 0.1
        val engine = opened()
        start(engine)
        waitFor { streamOutput.serverClockOffsetMs == 3_000 }
        // An interval on, it is measured again, and the frames follow the new offset.
        clockSkew = 4.5
        waitFor { streamOutput.serverClockOffsetMs == 4_500 }
        assertTrue(timeReads() >= 2 * ServerClock.TRIPS_PER_SAMPLE)
        // An unanswered measurement keeps the last offset, so the frames stay on the server's clock.
        timeFails = true
        val missed = timeReads()
        waitFor { timeReads() >= missed + 2 * ServerClock.TRIPS_PER_SAMPLE }
        assertEquals(4_500, streamOutput.serverClockOffsetMs)
        // The stream drops and redials: the offset holds, and the follower carries on.
        on { streamOutput.drop!!("peer went away") }
        assertEquals(4_500, streamOutput.serverClockOffsetMs)
        on { scheduler.pending!!() }
        waitFor { streamOutput.starts.size == 2 }
        assertEquals(4_500, streamOutput.serverClockOffsetMs)
        assertTrue(engine.serverClockFollower!!.isActive)
        timeFails = false
        clockSkew = 2.0
        waitFor { streamOutput.serverClockOffsetMs == 2_000 }
        runBlocking { engine.stopRecording() }
        assertNull(engine.serverClockFollower)
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

    /** Runs [work] on its own thread, as the bridge's calls arrive. */
    private fun concurrently(work: suspend () -> Unit): Thread = Thread { runBlocking { work() } }.apply { start() }

    @Test
    fun aCloseOrRecordDuringAStopWaitsForThePartToFinish() {
        val engine = opened()
        start(engine)
        capture(3.0)
        finishGate = CountDownLatch(1)
        val gate = finishGate!!
        val stopping = concurrently { engine.stopRecording() }
        waitFor { videos.last().finishing }
        // Record on the same stream, and Close, while the part is still finishing: both wait.
        val recording = concurrently { engine.startRecording("rtmp://ingest.example.test/live/key-0001", "s1", "g1", "Home Plate", request) }
        val closing = concurrently { engine.close() }
        Thread.sleep(200)
        assertTrue(stopping.isAlive)
        assertTrue(recording.isAlive)
        assertTrue(closing.isAlive)
        // The stop's sound tail has not been cut by a close: the mix is still running.
        assertTrue(engine.isOpen)
        finishGate = null
        gate.countDown()
        stopping.join(10_000)
        recording.join(10_000)
        closing.join(10_000)
        assertFalse(stopping.isAlive || recording.isAlive || closing.isAlive)
        // The stop closed its part before Record continued the take as its next part; Close then
        // stopped that one too.
        val take = runBlocking { engine.recordings() }.single()
        assertEquals(2, take.parts)
        assertNotNull(take.endedAt)
        assertFalse(engine.isOpen)
        assertTrue(videos.all { it.closed })
        // The first part kept its sound out to its picture.
        val first = File(engine.environment.storage.program, engine.index.recording(take.recordingID)!!.programFilenames.first())
        val reading = FragmentedMp4Reader.read(first)!!
        val sound = reading.audio!!
        assertTrue(sound.endSeconds!! - sound.mediaTime.toDouble() / sound.timescale >= reading.video!!.endSeconds!! - 0.03)
    }

    @Test
    fun aStopDuringALowStorageFinishWaitsForItAndTheTakeIsClosed() {
        storageCheckSeconds = 0.05
        val engine = opened()
        start(engine)
        capture(2.0)
        finishGate = CountDownLatch(1)
        val gate = finishGate!!
        free = 400_000_000
        // The storage loop starts the part's finish, and Stop lands half-way through it.
        waitFor { videos.last().finishing }
        val stopping = concurrently { engine.stopRecording() }
        Thread.sleep(200)
        assertTrue(stopping.isAlive)
        finishGate = null
        gate.countDown()
        stopping.join(10_000)
        assertFalse(stopping.isAlive)
        assertFalse(engine.isRecording)
        assertFalse(engine.isStreaming)
        assertTrue(videos.single().closed)
        val take = runBlocking { engine.recordings() }.single()
        assertTrue(take.stoppedForLowStorage)
        assertNotNull(take.endedAt)
        assertNull(on { engine.catalog.live() })
        assertEquals("stopped", foreground.calls.last())
    }

    @Test
    fun aFailedRecordingEncoderGoesOnInANewPartAndOneThatKeepsFailingStops() {
        val engine = opened()
        start(engine)
        capture(3.0)
        // The part's codec dies: the part is finished and the take goes on in a new part, new codec.
        videos.single().output!!.onError(-38, "codec died")
        waitFor { videos.size == 2 && engine.isRecording && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        assertTrue(videos.first().closed)
        capture(3.0)
        assertTrue(engine.isRecording)
        assertNull(on { engine.status }.error)
        // A late report from the dead codec changes nothing.
        videos.first().output!!.onError(-38, "codec died")
        on { }
        assertEquals(2, videos.size)
        // It keeps failing: after three new parts the part stops, the stream goes on, and the screen
        // is told the recording failed.
        repeat(PhoneStreamEngine.MAX_ENCODER_RECOVERIES - 1) {
            val count = videos.size
            videos.last().output!!.onError(-38, "codec died")
            waitFor { videos.size == count + 1 && engine.isRecording }
            capture(0.5)
        }
        videos.last().output!!.onError(-38, "codec died")
        // Told once the part is finished.
        waitFor { statuses().last().error == PhoneStreamError.RECORDING_FAILED }
        assertFalse(engine.isRecording)
        assertTrue(engine.isStreaming)
        val take = runBlocking { engine.recordings() }.single()
        assertEquals(1 + PhoneStreamEngine.MAX_ENCODER_RECOVERIES, take.parts)
        assertNotNull(take.endedAt)
        assertTrue(videos.all { it.closed })
        runBlocking { engine.stopRecording() }
        // The take exports across its parts.
        runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") }
        assertTrue(runBlocking { engine.recordings() }.single().isUploaded)
    }

    @Test
    fun aPartWhoseFileStopsTakingWritesStopsAndTheTakeGoesOnAtTheNextRecord() {
        val engine = opened()
        start(engine)
        capture(3.0)
        // The phone's storage refuses the next write.
        engine.encoder.soundSinkOverride = object : app.teamstation.streamcore.record.SoundSink {
            override val isReadyForMoreSound = true
            override fun appendSound(samples: ShortArray): Boolean = throw java.io.IOException("No space left on device")
            override fun finishSound() = Unit
        }
        capture(1.0)
        waitFor { statuses().last().error == PhoneStreamError.RECORDING_FAILED }
        engine.encoder.soundSinkOverride = null
        assertFalse(engine.isRecording)
        assertTrue(engine.isStreaming)
        assertTrue(videos.single().closed)
        val stopped = runBlocking { engine.recordings() }.single()
        assertNotNull(stopped.endedAt)
        assertTrue(engine.telemetry.lastRecordingError!!.contains("No space left on device"))
        runBlocking { engine.stopRecording() }
        // Record on the same stream continues the take as its next part.
        start(engine)
        capture(1.0)
        runBlocking { engine.stopRecording() }
        assertEquals(2, runBlocking { engine.recordings() }.single().parts)
    }

    @Test
    fun aLostCameraIsOpenedAgainAndTheRecordingPausesUntilItIsBack() {
        cameraReopenSeconds = 0.02
        val engine = opened()
        start(engine)
        capture(2.0)
        val lost = CameraSession.State(isRunning = false, isInterrupted = true, interruptionReason = "videoInUse")
        // Another app takes the camera: the status says so, and the part is finished rather than fill
        // with the last picture held; the take goes on.
        device.onStateChange!!(lost)
        waitFor { statuses().lastOrNull()?.error == PhoneStreamError.CAMERA_UNAVAILABLE }
        waitFor { videos.single().closed }
        assertFalse(device.attached.containsKey(PhoneProgramme.RECORDING_KEY))
        assertTrue(engine.isRecording)
        assertTrue(engine.isStreaming)
        assertNull(runBlocking { engine.recordings() }.single().endedAt)
        // It is asked to open again, and again, each wait longer than the last.
        waitFor { device.reopens >= 3 }
        assertEquals(device.reopens, engine.cameraReopens)
        // The camera is back: the take goes on as its next part.
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { videos.size == 2 && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        assertNull(on { engine.status }.error)
        val reopened = device.reopens
        capture(2.0)
        assertEquals(reopened, device.reopens)
        runBlocking { engine.stopRecording() }
        val take = runBlocking { engine.recordings() }.single()
        assertEquals(2, take.parts)
        assertNotNull(take.endedAt)
        // The stream published only a held picture while the camera was away: the take still covers it.
        assertTrue(take.coversWholeStream)

        // Lost again: Record is refused, and coming back to the screen tries the camera at once.
        device.onStateChange!!(CameraSession.State(failure = "cameraError deviceFatal"))
        waitFor { on { engine.status }.error == PhoneStreamError.CAMERA_UNAVAILABLE }
        expect(PhoneStreamError.CAMERA_UNAVAILABLE) {
            engine.startRecording("rtmp://ingest.example.test/live/key-0001", "s2", "g1", "Home Plate", request)
        }
        val before = engine.cameraReopens
        runBlocking { engine.open("Home Plate") }
        assertEquals(before + 1, engine.cameraReopens)
        // Lost while the take is stopped meanwhile: Stop closes it as it stands.
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { on { engine.status }.error == null }
        start(engine, stream = "s3")
        capture(1.0)
        device.onStateChange!!(lost)
        waitFor { videos.last().closed }
        runBlocking { engine.stopRecording() }
        assertFalse(engine.isRecording)
        assertNotNull(runBlocking { engine.recordings() }.first { it.liveStreamId == "s3" }.endedAt)
        runBlocking { engine.close() }
        assertNull(on { engine.status }.error)
        val closedAt = engine.cameraReopens
        Thread.sleep(100)
        assertEquals(closedAt, engine.cameraReopens)
    }

    @Test
    fun aTakeThatLostItsCameraAndGotItBackUploadsAsTheWholeStream() {
        cameraReopenSeconds = 0.02
        val engine = opened()
        start(engine)
        capture(2.0)
        device.onStateChange!!(CameraSession.State(isRunning = false, isInterrupted = true, interruptionReason = "videoInUse"))
        waitFor { videos.single().closed }
        // The stream stays on the air through the loss, and the status loop runs meanwhile.
        assertTrue(engine.isStreaming)
        repeat(3) { on { engine.publishStatus() } }
        assertFalse(runBlocking { engine.recordings() }.single().publishedOutsideParts)
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { videos.size == 2 && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        capture(2.0)
        runBlocking { engine.stopRecording() }
        val take = runBlocking { engine.recordings() }.single()
        assertEquals(2, take.parts)
        assertFalse(take.publishedOutsideParts)
        // The upload replaces the live copy rather than sit beside it.
        runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") }
        val body = JSONObject(requests.first { it.method == "POST" && it.path!!.endsWith("/director/uploads") }.body.readUtf8())
        assertTrue(body.getBoolean("wholeStream"))
    }

    @Test
    fun aTakeThatLostItsCameraAndThenStoppedForLowStorageIsNotTheWholeStream() {
        cameraReopenSeconds = 0.02
        val engine = opened()
        start(engine)
        capture(2.0)
        device.onStateChange!!(CameraSession.State(isRunning = false, isInterrupted = true, interruptionReason = "videoInUse"))
        waitFor { videos.single().closed }
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { videos.size == 2 && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        capture(2.0)
        // Storage runs low: the part stops while the stream goes on, so the take no longer covers it.
        free = 400_000_000
        runBlocking { withContext(engineDispatcher) { engine.checkStorage() } }
        assertFalse(engine.isRecording)
        assertTrue(engine.isStreaming)
        on { engine.publishStatus() }
        runBlocking { engine.stopRecording() }
        val take = runBlocking { engine.recordings() }.single()
        assertTrue(take.stoppedForLowStorage)
        assertTrue(take.publishedOutsideParts)
        free = 10_000_000_000
        runBlocking { engine.uploadRecording("s1", server.url("/").toString(), "token-0000", "Home Plate") }
        val body = JSONObject(requests.first { it.method == "POST" && it.path!!.endsWith("/director/uploads") }.body.readUtf8())
        assertFalse(body.has("wholeStream"))
    }

    @Test
    fun aLostCameraIsBackOnlyOnceItRunsAgain() {
        cameraReopenSeconds = 0.02
        val engine = opened()
        start(engine)
        capture(2.0)
        val failed = CameraSession.State(isRunning = false, failure = "cameraError deviceFatal")
        device.onStateChange!!(failed)
        waitFor { statuses().lastOrNull()?.error == PhoneStreamError.CAMERA_UNAVAILABLE }
        waitFor { videos.single().closed }
        // The camera is being opened again: not running yet, and no failure named. It is not back.
        device.onStateChange!!(CameraSession.State(isRunning = false))
        on { }
        val reopens = device.reopens
        waitFor { device.reopens > reopens }
        assertEquals(PhoneStreamError.CAMERA_UNAVAILABLE, on { engine.status }.error)
        assertEquals(1, videos.size)
        expect(PhoneStreamError.NOT_READY) { engine.startRecording("rtmp://x", "s2", "g1", "Home Plate", request) }
        // That open fails too: still lost, and still no part.
        device.onStateChange!!(failed)
        on { }
        assertEquals(PhoneStreamError.CAMERA_UNAVAILABLE, on { engine.status }.error)
        assertEquals(1, videos.size)
        // Running again: the take goes on as its next part.
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { videos.size == 2 && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        assertNull(on { engine.status }.error)
        capture(1.0)
        runBlocking { engine.stopRecording() }
        assertEquals(2, runBlocking { engine.recordings() }.single().parts)
    }

    @Test
    fun aClosedCamerasLastStateDoesNotReachTheNextOpen() {
        newDeviceEachOpen = true
        val engine = opened()
        val first = device
        first.onStateChange!!(CameraSession.State(isRunning = true))
        on { }
        // The state the first camera posts as it closes is on its way when the screen opens again.
        val stale = first.onStateChange!!
        runBlocking { engine.close() }
        assertNull(first.onStateChange)
        runBlocking { engine.open("Home Plate") }
        assertNotSame(first, device)
        device.onStateChange!!(CameraSession.State(isRunning = true))
        stale(CameraSession.State(isRunning = false, isInterrupted = true, interruptionReason = "videoInUse"))
        on { }
        assertNull(on { engine.status }.error)
        assertEquals(0, device.reopens)
        // Record is not refused.
        start(engine)
        capture(1.0)
        runBlocking { engine.stopRecording() }
        assertEquals(1, runBlocking { engine.recordings() }.single().parts)
    }

    @Test
    fun aTakeResumedWhileTheCameraIsLostGoesOnOnceItIsBack() {
        val first = opened()
        start(first)
        capture(3.0)
        runBlocking { first.abandonForTesting() }
        val second = opened()
        device.onStateChange!!(CameraSession.State(isRunning = false, isInterrupted = true))
        waitFor { on { second.status }.error == PhoneStreamError.CAMERA_UNAVAILABLE }
        assertTrue(runBlocking { second.resumeInterrupted(request) })
        // Nothing to record from yet: no part opens until the camera is back.
        assertTrue(second.isRecording)
        assertTrue(videos.size == 1)
        device.onStateChange!!(CameraSession.State(isRunning = true))
        waitFor { videos.size == 2 && device.attached.containsKey(PhoneProgramme.RECORDING_KEY) }
        capture(1.0)
        runBlocking { second.stopRecording() }
        assertEquals(2, runBlocking { second.recordings() }.single().parts)
        assertTrue(PhoneStreamEngine.cameraIsLost(CameraSession.State(failure = "x")))
        assertFalse(PhoneStreamEngine.cameraIsLost(CameraSession.State(isRunning = true, failure = "x")))
        assertFalse(PhoneStreamEngine.cameraIsLost(CameraSession.State()))
    }

    @Test
    fun aFailureInsideTheEngineIsLoggedAndTheTakeIsMarkedOnce() {
        val engine = opened()
        // A job that throws is logged, not left to end the process.
        runBlocking { engine.scopeForTesting.launch { error("something broke") }.join() }
        assertTrue(engine.telemetry.lastError!!.contains("something broke"))
        start(engine)
        capture(2.0)
        free = 400_000_000
        runBlocking { withContext(engineDispatcher) { engine.checkStorage() } }
        val id = runBlocking { engine.recordings() }.single().recordingID
        on { engine.publishStatus() }
        assertTrue(runBlocking { engine.recordings() }.single().publishedOutsideParts)
        // Marked once: the status loop does not write it again four times a second.
        engine.index.database.execSQL("UPDATE phone_recordings SET published_outside_parts = 0 WHERE recording_id = ?;", arrayOf<Any>(id))
        repeat(4) { on { engine.publishStatus() } }
        assertFalse(runBlocking { engine.recordings() }.single().publishedOutsideParts)
        runBlocking { engine.stopRecording() }
    }

    @Test
    fun aResumeWhosePartCannotOpenClosesTheTakeAndTheNextRecordWritesItsOwn() {
        val first = opened()
        start(first)
        capture(3.0)
        runBlocking { first.abandonForTesting() }
        val second = opened()
        // The resumed part opens, then its encoder will not: the part is finished and the take closed.
        failVideo = true
        assertTrue(runBlocking { second.resumeInterrupted(request) })
        assertFalse(second.encoder.running)
        assertFalse(second.recordingSession.isRecording)
        assertFalse(second.isRecording)
        assertTrue(second.isStreaming)
        assertEquals(PhoneStreamError.RECORDING_FAILED, on { second.status }.error)
        val resumed = runBlocking { second.recordings() }.single()
        assertNotNull(resumed.endedAt)
        runBlocking { second.stopRecording() }
        // Record on another stream writes a take of its own, into files of its own.
        failVideo = false
        start(second, stream = "s2")
        capture(1.0)
        runBlocking { second.stopRecording() }
        val takes = runBlocking { second.recordings() }
        val own = second.index.recording(takes.first { it.liveStreamId == "s2" }.recordingID)!!.programFilenames
        val old = second.index.recording(resumed.recordingID)!!.programFilenames
        assertEquals(1, own.size)
        assertTrue(own.none { it in old })
    }

    @Test
    fun aStopWhoseSoundCodecThrowsStillClosesTheTake() {
        val engine = opened()
        start(engine)
        capture(3.0)
        // The AAC codec dies as the part finishes: the mix's tail and the hold fill reach it.
        engine.encoder.soundSinkOverride = object : app.teamstation.streamcore.record.SoundSink {
            override val isReadyForMoreSound = true
            override fun appendSound(samples: ShortArray): Boolean = throw IllegalStateException("codec released")
            override fun finishSound() = Unit
        }
        runBlocking { engine.stopRecording() }
        engine.encoder.soundSinkOverride = null
        assertFalse(engine.encoder.running)
        assertFalse(engine.recordingSession.isRecording)
        assertNotNull(runBlocking { engine.recordings() }.single().endedAt)
        // Record on another stream writes a take of its own.
        start(engine, stream = "s2")
        capture(1.0)
        runBlocking { engine.stopRecording() }
        assertEquals(2, runBlocking { engine.recordings() }.size)
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
        // Every call reached the fleet on its thread, never the engine's.
        assertTrue(radarThreads.isNotEmpty())
        assertEquals(setOf("radar-test"), radarThreads.toSet())
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

    @Test
    fun leavingAndRecordingAgainContinuesTheSameTakeOnTheSameStream() {
        val first = opened()
        start(first)
        capture(0.5)
        val id = runBlocking { first.recordings() }.single().recordingID
        runBlocking {
            first.stopRecording()
            first.close()
        }
        val second = opened()
        assertTrue(streamOutput.starts.isEmpty())
        runBlocking {
            second.startRecording("rtmp://ingest.example.test/live/key-0002", "s1", "g1", "Home Plate", request)
        }
        capture(0.3)
        on { streamOutput.drop!!("peer went away") }
        on { scheduler.pending!!() }
        waitFor { streamOutput.starts.size == 2 }
        val body = JSONObject(requests.first { it.path!!.contains("/live-streams") }.body.readUtf8())
        assertEquals("s1", body.getString("heldStreamId"))
        runBlocking { second.stopRecording() }
        val takes = runBlocking { second.recordings() }
        assertEquals(1, takes.size)
        assertEquals(id, takes.single().recordingID)
        assertEquals(2, takes.single().parts)
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
