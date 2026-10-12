package app.teamstation.streamcore.stream

import android.view.Surface
import app.teamstation.streamcore.bitrate.AdaptiveBitrateController
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.rtmp.AMF0
import app.teamstation.streamcore.rtmp.FLVTag
import app.teamstation.streamcore.rtmp.FakeRtmpServer
import app.teamstation.streamcore.rtmp.RTMPClient
import app.teamstation.streamcore.rtmp.RTMPClientError
import app.teamstation.streamcore.rtmp.RTMPMessageType
import app.teamstation.streamcore.rtmp.RTMPURL
import app.teamstation.streamcore.rtmp.RTMPVideoCodec
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.ServerSocket
import java.util.Collections

/** [ProgramStreamer] with fake encoders, publishing to an in-process ingest. */
class ProgramStreamerTest {
    internal class FakeVideoEncoder : StreamVideoEncoding {
        var config: StreamEncoderConfig? = null
        var output: StreamVideoEncoding.Output? = null
        var syncRequests = 0
        val bitrates = Collections.synchronizedList(mutableListOf<Int>())
        var closed = false

        override fun open(config: StreamEncoderConfig, output: StreamVideoEncoding.Output): Surface? {
            this.config = config
            this.output = output
            return null
        }

        override fun requestSyncFrame() {
            syncRequests += 1
        }

        override fun setBitrate(bitrate: Int) {
            bitrates += bitrate
        }

        override fun close() {
            closed = true
        }
    }

    /** One packet per 1024 sample frames, holding its own index, after a priming of 2112. */
    internal class FakeAudioEncoder : StreamAudioEncoding {
        override val audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
        override val primingSamples = 2_112
        private var leftover = 0
        private var count = 0
        var resets = 0
        var closed = false

        override fun encode(samples: ShortArray): List<ByteArray> {
            leftover += samples.size / 2
            val packets = mutableListOf<ByteArray>()
            while (leftover >= 1024) {
                leftover -= 1024
                packets += byteArrayOf(0x21, count.toByte())
                count += 1
            }
            return packets
        }

        override fun reset() {
            resets += 1
            leftover = 0
            count = 0
        }

        override fun close() {
            closed = true
        }
    }

    private class CountingTelemetry : BasicMediaTelemetry() {
        val events = Collections.synchronizedList(mutableListOf<String>())
        override fun recordEncodeSessionChange(delta: Int) { events += "session $delta" }
        override fun recordStreamIdleKeyframe() { events += "idle" }
        override fun recordStreamEncoderReset() { events += "reset" }
        override fun recordEncodeFailure(code: Int) { events += "failure $code" }
    }

    private val vps = hex("40010c01ffff016000000300b0000003000003007817024")
    private val sps = byteArrayOf(
        0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0.toByte(), 0x00, 0x00, 0x03, 0x00, 0x00, 0x03,
        0x00, 0x78, 0xA0.toByte(), 0x03, 0xC0.toByte(), 0x80.toByte(), 0x11, 0x07, 0xCB.toByte(), 0x88.toByte(),
        0x17, 0xB9.toByte(), 0x16, 0x45, 0x2F, 0xFC.toByte(), 0xB9.toByte(), 0xFC.toByte(), 0x4F, 0xE8.toByte(), 0x80.toByte()
    )
    private val pps = byteArrayOf(0x44, 0x01, 0xC0.toByte(), 0x72, 0xF0.toByte(), 0x53, 0x24)
    private val idr = byteArrayOf(0x26, 0x01, 1, 2, 3)
    private val trail = byteArrayOf(0x02, 0x01, 4, 5)

    private fun hex(text: String): ByteArray {
        val even = if (text.length % 2 == 1) text + "0" else text
        return ByteArray(even.length / 2) { even.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    private val closers = mutableListOf<AutoCloseable>()
    private var wall = 1_000.0
    private val videos = mutableListOf<FakeVideoEncoder>()
    private val audio = FakeAudioEncoder()
    private val telemetry = CountingTelemetry()

    @After
    fun tearDown() {
        closers.reversed().forEach { runCatching { it.close() } }
    }

    private fun streamer() = ProgramStreamer(
        telemetry = telemetry,
        videoEncoderFactory = { FakeVideoEncoder().also { videos += it } },
        audioEncoderFactory = { audio },
        wallClock = { wall },
        pictureWall = { wall }
    ).also { closers += AutoCloseable { it.stop() } }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("timed out")
            Thread.sleep(10)
        }
    }

    private fun frame(keyframe: Boolean) = EncodedVideoFrame(
        nalUnits = listOf(if (keyframe) idr else trail),
        parameterSets = if (keyframe) listOf(vps, sps, pps) else emptyList(),
        isKeyframe = keyframe,
        presentationTime = wall
    )

    @Test
    fun aSessionPublishesItsPicturesAndCountedSound() {
        val server = FakeRtmpServer().also { closers += it }
        val streamer = streamer()
        var surfaces = 0
        streamer.onInputSurface { surfaces += 1 }
        val settings = StreamSettings(bitrateLow = 500_000, bitrateHigh = 4_000_000)
        runBlocking { streamer.start(server.url, settings, null) }
        assertTrue(streamer.running)
        assertNull(streamer.inputSurface)
        assertEquals(1, surfaces)
        val encoder = videos.single()
        assertEquals(StreamEncoderConfig(StreamCodec.HEVC, 1920, 1080, 30, 4_000_000, 2.0), encoder.config)
        // A second start while running does nothing.
        runBlocking { streamer.start(server.url, settings, null) }
        assertEquals(1, videos.size)

        // The first picture must be an IDR; the pacer holds the rest to 30 a second.
        assertTrue(streamer.append(wall))
        assertEquals(1, encoder.syncRequests)
        assertFalse(streamer.append(wall))
        repeat(3) {
            wall += 1.0 / 30
            assertTrue(streamer.append(wall))
        }
        assertEquals(1, encoder.syncRequests)
        wall += 1.0 / 30
        // Four in the encoder while an IDR is owed: the fifth waits.
        assertFalse(streamer.append(wall))
        assertEquals(4, streamer.pendingEncodesForTesting)

        val start = wall
        encoder.output!!.onFrame(frame(true))
        wall += 1.0 / 30
        encoder.output!!.onFrame(frame(false))
        assertEquals(2, streamer.pendingEncodesForTesting)

        // Sound that began half a second after the stream: two packets, counted from its epoch.
        streamer.append(AudioFrame(ShortArray(2048 * 2), wallClock = start + 0.5))
        // A break in the mix starts the encoder again.
        streamer.append(AudioFrame(ShortArray(1024 * 2), wallClock = start + 2.0))
        assertEquals(1, audio.resets)

        waitFor { server.messages(RTMPMessageType.VIDEO).size == 3 && server.messages(RTMPMessageType.AUDIO).size == 4 }
        val video = server.messages(RTMPMessageType.VIDEO)
        assertTrue(FLVTag.isVideoSequenceHeader(video[0].payload))
        assertTrue(FLVTag.isVideoKeyframe(video[1].payload))
        assertEquals(0L, video[1].timestamp)
        assertTrue(video[2].timestamp in 31L..34L)
        assertArrayEquals(
            FLVTag.videoFrame(RTMPVideoCodec.HEVC, false, ProgramStreamer.lengthPrefixed(listOf(trail))),
            video[2].payload
        )
        val sound = server.messages(RTMPMessageType.AUDIO)
        assertTrue(FLVTag.isAudioSequenceHeader(sound[0].payload))
        assertEquals(listOf(456L, 456L, 477L), sound.take(3).map { it.timestamp })
        assertEquals(1956L, sound[3].timestamp)
        val metadata = AMF0.decodeList(server.messages(RTMPMessageType.AMF0_DATA).single().payload)
        assertEquals(4_000.0, metadata[2].objectValue!!["videodatarate"]!!.numberValue!!, 0.0)

        val metrics = streamer.metrics
        assertEquals("hevc", metrics.rate.codec)
        assertEquals(4_000_000, metrics.rate.high)
        assertEquals(500_000, metrics.rate.low)

        streamer.requestKeyframe()
        assertEquals(2, encoder.syncRequests)
        streamer.stop()
        assertFalse(streamer.running)
        assertTrue(encoder.closed)
        assertTrue(audio.closed)
        assertEquals(2, surfaces)
        assertEquals(listOf("session 1", "session -1"), telemetry.events.filter { it.startsWith("session") })
        assertFalse(streamer.append(wall))
        streamer.append(AudioFrame(ShortArray(2048), wallClock = wall))
    }

    @Test
    fun theWatchdogAsksForAnIdleIDRAndRebuildsAWedgedEncoder() {
        val streamer = streamer()
        val client = RTMPClient().also { closers += AutoCloseable { it.stop() } }
        streamer.goLiveForTesting(client, StreamSettings())
        val first = videos.single()
        streamer.gopWatchdogTick()
        assertEquals(0, first.syncRequests)

        // A picture came out, then nothing for longer than one and a half GOPs.
        first.output!!.onFrame(frame(true))
        wall += 3.1
        streamer.gopWatchdogTick()
        assertEquals(1, first.syncRequests)
        assertTrue(telemetry.events.contains("idle"))

        // Pictures go in and nothing comes back for two GOPs: the session is rebuilt.
        assertTrue(streamer.append(wall))
        wall += 4.1
        streamer.gopWatchdogTick()
        assertTrue(first.closed)
        assertEquals(2, videos.size)
        assertTrue(telemetry.events.contains("reset"))
        assertEquals(1, videos[1].syncRequests)
        // A callback from the old session is ignored.
        first.output!!.onFrame(frame(true))
        first.output!!.onError(-1, "late")
        assertFalse(telemetry.events.contains("failure -1"))
        videos[1].output!!.onError(-12, "malfunction")
        assertTrue(telemetry.events.contains("failure -12"))
        streamer.stop()
        streamer.gopWatchdogTick()
    }

    @Test
    fun aSessionStartedLiveStampsSoundAgainstItsStart() {
        val streamer = streamer()
        val client = RTMPClient().also { closers += AutoCloseable { it.stop() } }
        streamer.goLiveForTesting(client, StreamSettings(codec = StreamCodec.H264), startWall = wall)
        // Not live on the wire, so nothing is sent and nothing is counted.
        streamer.append(AudioFrame(ShortArray(4096), wallClock = wall))
        videos.single().output!!.onFrame(frame(false))
    }

    @Test
    fun aFailedPublishStopsTheSession() {
        val port = ServerSocket(0).use { it.localPort }
        val streamer = streamer()
        try {
            runBlocking { streamer.start("rtmp://127.0.0.1:$port/live/key", StreamSettings(), null) }
            fail("published")
        } catch (error: RTMPClientError) {
            assertTrue(error is RTMPClientError.ConnectFailed)
        }
        assertFalse(streamer.running)
        assertTrue(videos.single().closed)
        try {
            runBlocking { streamer.start("http://ingest.example.test/live/key", StreamSettings(), null) }
            fail("started")
        } catch (error: RTMPURL.InvalidURLException) {
            assertEquals(RTMPURL.ParseError.NOT_RTMP, error.error)
        }
    }

    @Test
    fun aDropIsReportedOnceAndStopsTheSession() {
        val server = FakeRtmpServer().also { closers += it }
        val streamer = streamer()
        val reported = Collections.synchronizedList(mutableListOf<String>())
        runBlocking { streamer.start(server.url, StreamSettings(codec = StreamCodec.H264), reported::add) }
        server.dropConnections()
        waitFor { reported.isNotEmpty() }
        assertTrue(reported.single().startsWith("stream disconnected"))
        waitFor { !streamer.running }
    }

    @Test
    fun theHelpersMatchDirectors() {
        assertTrue(ProgramStreamer.payloadContainsIDR(listOf(byteArrayOf(0x65)), StreamCodec.H264))
        assertFalse(ProgramStreamer.payloadContainsIDR(listOf(byteArrayOf(0x41)), StreamCodec.H264))
        assertTrue(ProgramStreamer.payloadContainsIDR(listOf(byteArrayOf(0x02), byteArrayOf(0x2A)), StreamCodec.HEVC))
        assertFalse(ProgramStreamer.payloadContainsIDR(listOf(ByteArray(0), byteArrayOf(0x02)), StreamCodec.HEVC))
        val avc = ProgramStreamer.decoderConfigurationRecord(listOf(byteArrayOf(0x67, 0x42, 0, 0x1F), byteArrayOf(0x68, 1)), RTMPVideoCodec.H264)
        assertEquals(0x42, avc!![1].toInt())
        assertNull(ProgramStreamer.decoderConfigurationRecord(listOf(byteArrayOf(0x67, 0x42, 0, 0x1F)), RTMPVideoCodec.H264))
        assertNull(ProgramStreamer.decoderConfigurationRecord(listOf(ByteArray(0)), RTMPVideoCodec.HEVC))
        assertArrayEquals(byteArrayOf(0, 0, 0, 1, 9, 0, 0, 0, 2, 7, 7), ProgramStreamer.lengthPrefixed(listOf(byteArrayOf(9), byteArrayOf(7, 7))))
        val status = AdaptiveBitrateController(4_000_000, 1_000_000).status
        assertEquals(
            StreamRateTelemetry("h264", 4_000_000, 1_000_000, 4_000_000, "hold", 0, 0, 0, 0, 0),
            ProgramStreamer.rateTelemetry(status, RTMPVideoCodec.H264)
        )
    }
}
