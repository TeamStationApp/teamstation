package app.teamstation.streamcore.stream

import android.view.Surface
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.encode.NALUnitConversion
import app.teamstation.streamcore.rtmp.RTMPClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Collections
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Scenario E6: the Kotlin stream path publishing to real RTMP servers, run by
 * `scripts/rtmpInterop.mjs` and skipped everywhere else.
 *
 * [StreamSessionController] keeps a [ProgramStreamer] on the air at the URL in `TS_RTMP_INTEROP_URL`
 * for `TS_RTMP_INTEROP_SECONDS`. The encoders are stand-ins that replay an HEVC 1920×1080 and AAC
 * clip the script made with ffmpeg (`TS_RTMP_INTEROP_FIXTURE`), at 30 pictures a second and in 20 ms
 * runs of mix, on the wall clock; everything from the stream clock to the socket is the real code.
 * `TS_RTMP_INTEROP_MODE` says what to expect of the server:
 * - `hls`: the server's node-media-server splitter; one session, never dropped.
 * - `stall`: a server that stops reading; the backlog stays within the send budget, it sheds, and
 *   what it leaves starts on a keyframe.
 * - `reconnect`: a sink killed and restarted; the controller redials and goes live again.
 * Every second's numbers go to `TS_RTMP_INTEROP_LOG`.
 */
class RtmpInteropTest {
    private val url = System.getenv("TS_RTMP_INTEROP_URL")
    private val mode = System.getenv("TS_RTMP_INTEROP_MODE") ?: "hls"
    private val seconds = System.getenv("TS_RTMP_INTEROP_SECONDS")?.toDoubleOrNull() ?: 40.0
    private val log = System.getenv("TS_RTMP_INTEROP_LOG")?.let(::File)
    private val epoch = System.currentTimeMillis() / 1000.0 - System.nanoTime() / 1e9

    /** The wall clock, carried forward on the monotonic one, as `SteadyWall` does. */
    private fun wall(): Double = epoch + System.nanoTime() / 1e9

    private fun note(line: String) {
        val stamped = "[%7.3f] %s".format(wall() - start, line)
        println(stamped)
        log?.appendText("$stamped\n")
    }

    private val start = wall()

    /** One coded picture of the clip. */
    private class Picture(val units: List<ByteArray>, val keyframe: Boolean)

    /** The clip's pictures, in order, and its parameter sets. */
    private class Clip(val pictures: List<Picture>, val parameterSets: List<ByteArray>, val sound: List<ByteArray>)

    private fun loadClip(directory: File): Clip {
        val units = NALUnitConversion.elementaryUnitsFromAnnexB(File(directory, "fixture.h265").readBytes())
        val sets = mutableListOf<ByteArray>()
        val pictures = mutableListOf<Picture>()
        var current = mutableListOf<ByteArray>()
        for (unit in units) {
            val type = (unit[0].toInt() ushr 1) and 0x3F
            when {
                type in 32..34 -> if (sets.count { (it[0].toInt() ushr 1) and 0x3F == type } == 0) sets += unit
                type < 32 -> {
                    // first_slice_segment_in_pic_flag opens a new picture.
                    val first = unit.size > 2 && unit[2].toInt() and 0x80 != 0
                    if (first && current.isNotEmpty()) {
                        pictures += picture(current)
                        current = mutableListOf()
                    }
                    current += unit
                }
            }
        }
        if (current.isNotEmpty()) pictures += picture(current)
        val aac = File(directory, "fixture.aac").readBytes()
        val sound = mutableListOf<ByteArray>()
        var offset = 0
        while (offset + 7 <= aac.size) {
            val header = if (aac[offset + 1].toInt() and 0x01 == 0) 9 else 7
            val length = ((aac[offset + 3].toInt() and 0x03) shl 11) or ((aac[offset + 4].toInt() and 0xFF) shl 3) or
                ((aac[offset + 5].toInt() and 0xE0) ushr 5)
            if (length <= header || offset + length > aac.size) break
            sound += aac.copyOfRange(offset + header, offset + length)
            offset += length
        }
        return Clip(pictures, sets, sound)
    }

    private fun picture(units: List<ByteArray>) =
        Picture(units, units.any { ((it[0].toInt() ushr 1) and 0x3F) in 16..21 })

    /** Replays the clip from its first picture, at the stream's rate, into whoever opened it. */
    private inner class ReplayEncoder(private val clip: Clip, private val streamer: () -> ProgramStreamer) : StreamVideoEncoding {
        @Volatile
        private var open = false

        override fun open(config: StreamEncoderConfig, output: StreamVideoEncoding.Output): Surface? {
            open = true
            thread(name = "replay-video", isDaemon = true) {
                val begun = System.nanoTime()
                var index = 0
                var waitingForKey = false
                while (open) {
                    val due = begun + index * 1_000_000_000L / config.frameRate
                    val pause = due - System.nanoTime()
                    if (pause > 0) Thread.sleep(pause / 1_000_000, (pause % 1_000_000).toInt())
                    val picture = clip.pictures[index % clip.pictures.size]
                    index += 1
                    val admitted = streamer().append(wall())
                    // A picture the streamer refuses is one a real encoder never saw. The clip's next
                    // pictures refer to it, so the replay waits for a keyframe, as the encoder's would.
                    if (!admitted) {
                        waitingForKey = true
                        continue
                    }
                    if (waitingForKey && !picture.keyframe) {
                        output.onFrame(EncodedVideoFrame(emptyList(), isKeyframe = false, presentationTime = wall()))
                        continue
                    }
                    waitingForKey = false
                    output.onFrame(
                        EncodedVideoFrame(
                            nalUnits = picture.units,
                            parameterSets = if (picture.keyframe) clip.parameterSets else emptyList(),
                            isKeyframe = picture.keyframe,
                            presentationTime = wall()
                        )
                    )
                }
            }
            return null
        }

        override fun requestSyncFrame() = Unit
        override fun setBitrate(bitrate: Int) = Unit
        override fun close() {
            open = false
        }
    }

    /** The clip's AAC packets, one per 1024 samples of mix, after ffmpeg's priming of 1024. */
    private class ReplayAac(private val clip: Clip) : StreamAudioEncoding {
        override val audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
        override val primingSamples = 1024
        private var samples = 0
        private var next = 0

        override fun encode(samples: ShortArray): List<ByteArray> {
            this.samples += samples.size / 2
            val packets = mutableListOf<ByteArray>()
            while (this.samples >= 1024) {
                this.samples -= 1024
                packets += clip.sound[next % clip.sound.size]
                next += 1
            }
            return packets
        }

        override fun reset() {
            samples = 0
            next = 0
        }

        override fun close() = Unit
    }

    @Test
    fun publishesTheClipAndHoldsTheStreamUp() {
        assumeTrue("TS_RTMP_INTEROP_URL names the ingest for scripts/rtmpInterop.mjs", url != null)
        val clip = loadClip(File(System.getenv("TS_RTMP_INTEROP_FIXTURE")))
        note("mode=$mode url=${url!!.substringBeforeLast('/')}/… pictures=${clip.pictures.size} keyframes=${clip.pictures.count { it.keyframe }} aac=${clip.sound.size}")
        val settings = StreamSettings(
            codec = StreamCodec.HEVC,
            width = 1920,
            height = 1080,
            frameRate = 30,
            bitrateLow = 500_000,
            // Against the stall server the top of the range is the plan's floor, so the send budget
            // (30 s of it, and half again) is one a twenty-second stall overfills.
            bitrateHigh = if (mode == "stall") 500_000 else 4_000_000,
            gopSeconds = 2.0
        )
        val budget = RTMPClient.sendBudget(settings.bitrateHigh)
        val clients = Collections.synchronizedList(mutableListOf<RTMPClient>())
        lateinit var streamer: ProgramStreamer
        streamer = ProgramStreamer(
            videoEncoderFactory = { ReplayEncoder(clip) { streamer } },
            audioEncoderFactory = { ReplayAac(clip) },
            clientFactory = { RTMPClient().also { clients += it } },
            wallClock = ::wall
        )
        val main = Executors.newSingleThreadExecutor { Thread(it, "interop-main").apply { isDaemon = true } }
        val scope = CoroutineScope(SupervisorJob() + main.asCoroutineDispatcher())
        val phases = Collections.synchronizedList(mutableListOf<String>())
        val controller = StreamSessionController(
            publisher = streamer,
            host = StreamSessionController.Host(
                requestURL = { reason ->
                    note("dial ${reason.rawValue}")
                    url
                },
                settings = { settings },
                dropped = { note("dropped: $it") },
                redialing = { note("redialing") }
            ),
            scope = scope
        )
        runBlocking(scope.coroutineContext) { controller.start() }

        // The mix, in 20 ms runs on the wall clock, contiguous by count as the mixer makes it.
        val running = java.util.concurrent.atomic.AtomicBoolean(true)
        val mix = thread(name = "replay-mix", isDaemon = true) {
            val first = wall()
            var run = 0
            while (running.get()) {
                val at = first + run * 0.02
                val pause = at - wall()
                if (pause > 0) Thread.sleep((pause * 1000).toLong())
                streamer.append(AudioFrame(ShortArray(960 * 2), wallClock = at))
                run += 1
            }
        }

        var maxQueued = 0
        var lastDropped = 0L
        var lastSent = -1L
        var shedChecks = 0
        var shedOnKeyframe = 0
        val endAt = wall() + seconds
        var nextNote = wall()
        while (wall() < endAt) {
            Thread.sleep(100)
            val phase = runBlocking(scope.coroutineContext) { controller.phase }
            if (phases.lastOrNull() != phase.rawValue) {
                phases += phase.rawValue
                note("phase ${phase.rawValue}")
            }
            val client = clients.lastOrNull() ?: continue
            val metrics = client.metrics
            maxQueued = maxOf(maxQueued, metrics.queuedBytes)
            val sent = client.bytesSentForTesting
            // Just shed, and nothing has left since: the queue now starts where shedding left it.
            if (metrics.droppedPackets > lastDropped && sent == lastSent) {
                shedChecks += 1
                if (client.firstQueuedVideoIsKeyframeForTesting) shedOnKeyframe += 1
            }
            lastDropped = metrics.droppedPackets
            lastSent = sent
            if (wall() >= nextNote) {
                nextNote += 1.0
                note(
                    "session=${clients.size} phase=${phase.rawValue} sent=$sent queued=${metrics.queuedBytes} " +
                        "budget=$budget dropped=${metrics.droppedPackets} rate=${streamer.metrics.rate.bitrate} " +
                        "decision=${streamer.metrics.rate.lastDecision}"
                )
            }
        }
        running.set(false)
        mix.join()
        val finalPhase = runBlocking(scope.coroutineContext) {
            val phase = controller.phase
            controller.stop()
            phase
        }
        main.shutdown()
        val dropped = clients.sumOf { it.metrics.droppedPackets }
        note("end: sessions=${clients.size} phases=${phases.joinToString(">")} maxQueued=$maxQueued budget=$budget dropped=$lastDropped shedChecks=$shedChecks shedOnKeyframe=$shedOnKeyframe")

        when (mode) {
            "hls" -> {
                assertEquals(1, clients.size)
                assertEquals(StreamSessionController.Phase.LIVE, finalPhase)
                assertEquals(0L, dropped)
            }
            "stall" -> {
                assertEquals(StreamSessionController.Phase.LIVE, finalPhase)
                assertEquals("the stall never dropped the publish", 1, clients.size)
                assertTrue("the backlog $maxQueued stays within the budget $budget", maxQueued <= budget)
                assertTrue("the backlog was shed", lastDropped > 0)
                assertTrue("shedding was seen", shedChecks > 0)
                assertEquals("shedding leaves the queue on a keyframe", shedChecks, shedOnKeyframe)
            }
            "reconnect" -> {
                assertTrue("the controller redialled after the sink went away", clients.size >= 2)
                assertTrue(phases.contains("retrying"))
                assertEquals(StreamSessionController.Phase.LIVE, finalPhase)
            }
        }
    }
}
