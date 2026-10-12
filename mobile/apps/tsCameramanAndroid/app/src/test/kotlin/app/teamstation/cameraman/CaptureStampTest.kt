package app.teamstation.cameraman

import android.media.MediaFormat
import app.teamstation.cameraman.core.DeviceIdentity
import app.teamstation.streamcore.core.EncodedAudioFrame
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.encode.AudioEncoder
import app.teamstation.cameraman.rtsp.AudioStampClock
import app.teamstation.cameraman.rtsp.RTSPClientConnection
import app.teamstation.cameraman.rtsp.SDPBuilder
import app.teamstation.cameraman.rtsp.SenderReportSchedule
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Pixel's sound is stamped by capture position, like the iPhone's (U-C2). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CaptureStampTest {
    private val frame = 1024.0 / 48_000

    @Test
    fun `stamps advance by sample count whatever the capture jitter`() {
        val clock = AudioStampClock(48_000.0)
        val jitter = listOf(0.0, 0.003, -0.004, 0.002, -0.001, 0.004)
        val stamps = (0 until 60).map { clock.next(100 + it * frame + jitter[it % jitter.size]) }
        assertEquals((0 until 60).map { it * 1024L }, stamps)
        assertEquals(0, clock.gaps)
    }

    @Test
    fun `a dropout skips the stamp by what was lost, and the stamp never goes back`() {
        val clock = AudioStampClock(48_000.0)
        repeat(10) { clock.next(100 + it * frame) }
        assertEquals(10 * 1024L + 2_400, clock.next(100 + 10 * frame + 0.05))
        assertEquals(2_400L, clock.skippedSamples)
        assertEquals(1, clock.gaps)
        assertEquals(11 * 1024L + 2_400, clock.next(99.0))
        // Past 2^32 samples the stamp wraps on the 32-bit circle.
        val late = AudioStampClock(48_000.0)
        late.next(0.0)
        assertEquals((90_000L * 48_000L) and 0xFFFFFFFFL, late.next(90_000.0))
    }

    @Test
    fun `each stream leads a session with a report, then reports once a second`() {
        val schedule = SenderReportSchedule()
        assertTrue(schedule.reportBeforeFirstPacket(1_000))
        assertFalse(schedule.reportBeforeFirstPacket(1_100))
        assertFalse(schedule.reportIsDue(1_500))
        assertTrue(schedule.reportIsDue(2_000))
        assertFalse(schedule.reportIsDue(2_500))
        schedule.reset()
        assertTrue(schedule.reportBeforeFirstPacket(2_600))
    }

    @Test
    fun `a packet is stamped at its output time less the codec's priming, and captured by the anchors`() {
        assertEquals(1.0 - 2048 / 48_000.0, AudioEncoder.soundTime(1_000_000, 2048 / 48_000.0), 1e-9)
        val anchors = listOf(0.0 to 500.0, 1.0 to 1_000.5)
        // Before every anchor: the earliest moves it.
        assertEquals(499.9, AudioEncoder.captureAt(anchors, -0.1)!!, 1e-9)
        assertEquals(500.5, AudioEncoder.captureAt(anchors, 0.5)!!, 1e-9)
        assertEquals(1_000.6, AudioEncoder.captureAt(anchors, 1.1)!!, 1e-9)
        assertNull(AudioEncoder.captureAt(emptyList(), 1.0))
        val stated = MediaFormat().apply { setInteger(MediaFormat.KEY_ENCODER_DELAY, 1_600) }
        assertEquals(1_600, AudioEncoder.delaySamples(stated))
        assertNull(AudioEncoder.delaySamples(MediaFormat()))
    }

    @Test
    fun `reports lead each stream, and audio stamps follow capture through a dropout`() {
        val identity = DeviceIdentity("00000000-0000-4000-8000-000000000001", "Loopback")
        val listener = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val client = Socket(InetAddress.getLoopbackAddress(), listener.localPort)
        val accepted = listener.accept()
        val connection = RTSPClientConnection(
            socket = accepted,
            sdp = { video, audio ->
                SDPBuilder(
                    identity,
                    SDPBuilder.VideoTrack(StreamCodec.H264, listOf(byteArrayOf(0x67, 0x42, 0, 0x1F), byteArrayOf(0x68, 0xCE.toByte(), 0x3C, 0x80.toByte())), 1920, 1080),
                    SDPBuilder.AudioTrack(byteArrayOf(0x11, 0x90.toByte()), 48_000, 1),
                    video,
                    audio
                ).build()
            },
            hasAudio = true,
            identity = { identity },
            requestKeyframe = {}
        )
        connection.start()
        val input = client.getInputStream()
        val out = client.getOutputStream()
        val url = "rtsp://127.0.0.1:${listener.localPort}/live/mainstream"
        fun exchange(text: String): String {
            out.write(text.toByteArray())
            out.flush()
            return readResponse(input)
        }
        exchange("DESCRIBE $url RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n")
        val setup = exchange("SETUP $url/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n")
        val session = Regex("Session: ([^;\\r\\n]+)").find(setup)!!.groupValues[1]
        exchange("SETUP $url/trackID=1 RTSP/1.0\r\nCSeq: 3\r\nSession: $session\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n")
        exchange("PLAY $url RTSP/1.0\r\nCSeq: 4\r\nSession: $session\r\n\r\n")

        connection.send(EncodedVideoFrame(listOf(byteArrayOf(0x65, 0x88.toByte(), 0x84.toByte(), 0)), isKeyframe = true, presentationTime = 50.0), StreamCodec.H264)
        for (index in 0 until 10) {
            val capture = 50 + index * frame + if (index >= 5) 0.1 else 0.0
            connection.send(EncodedAudioFrame(ByteArray(40) { 0x21 }, capture, 48_000, 1, captureTime = capture))
        }

        client.soTimeout = 3_000
        val packets = mutableListOf<Pair<Int, ByteArray>>()
        while (packets.count { it.first == 2 } < 10) {
            val marker = input.read()
            if (marker < 0) break
            if (marker != 0x24) continue
            val channel = input.read()
            val length = (input.read() shl 8) or input.read()
            packets.add(channel to input.readNBytes(length))
        }
        connection.close()
        client.close()
        listener.close()

        val firstVideo = packets.indexOfFirst { it.first == 0 }
        val firstVideoReport = packets.indexOfFirst { it.first == 1 }
        assertTrue("video report $firstVideoReport before picture $firstVideo", firstVideoReport in 0 until firstVideo)
        val firstAudio = packets.indexOfFirst { it.first == 2 }
        val firstAudioReport = packets.indexOfFirst { it.first == 3 }
        assertTrue("audio report $firstAudioReport before sound $firstAudio", firstAudioReport in 0 until firstAudio)
        // The leading audio report pairs RTP 0 with its capture.
        val report = packets[firstAudioReport].second
        assertEquals(200, report[1].toInt() and 0xFF)
        assertEquals(0L, readUInt32(report, 16))
        // Picture and sound were both captured at 50 s; the sound is reported the phone's capture
        // trim later, which is where it lines up with the picture.
        fun ntp(bytes: ByteArray) = readUInt32(bytes, 8) + readUInt32(bytes, 12) / 4_294_967_296.0
        assertEquals(AudioStampClock.captureTrimSeconds, ntp(report) - ntp(packets[firstVideoReport].second), 0.002)
        assertEquals(0.025, AudioStampClock.captureTrimSeconds, 0.0)
        val stamps = packets.filter { it.first == 2 }.map { readUInt32(it.second, 4) }
        assertEquals(listOf(0L, 1_024, 2_048, 3_072, 4_096, 9_920, 10_944, 11_968, 12_992, 14_016), stamps)
    }

    @Test
    fun `media older than the bound is dropped on the way out, with no hole in the sequence numbers`() {
        val identity = DeviceIdentity("00000000-0000-4000-8000-000000000001", "Loopback")
        val listener = ServerSocket(0, 1, InetAddress.getLoopbackAddress())
        val client = Socket(InetAddress.getLoopbackAddress(), listener.localPort)
        val accepted = listener.accept()
        var now = 50.0
        val keyframeRequests = java.util.concurrent.atomic.AtomicInteger()
        val connection = RTSPClientConnection(
            socket = accepted,
            sdp = { video, audio ->
                SDPBuilder(
                    identity,
                    SDPBuilder.VideoTrack(StreamCodec.H264, listOf(byteArrayOf(0x67, 0x42, 0, 0x1F), byteArrayOf(0x68, 0xCE.toByte(), 0x3C, 0x80.toByte())), 1920, 1080),
                    SDPBuilder.AudioTrack(byteArrayOf(0x11, 0x90.toByte()), 48_000, 1),
                    video,
                    audio
                ).build()
            },
            hasAudio = true,
            identity = { identity },
            requestKeyframe = { keyframeRequests.incrementAndGet() },
            clock = { now }
        )
        connection.start()
        val input = client.getInputStream()
        val out = client.getOutputStream()
        val url = "rtsp://127.0.0.1:${listener.localPort}/live/mainstream"
        fun exchange(text: String): String {
            out.write(text.toByteArray())
            out.flush()
            return readResponse(input)
        }
        exchange("DESCRIBE $url RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n")
        val setup = exchange("SETUP $url/trackID=0 RTSP/1.0\r\nCSeq: 2\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n")
        val session = Regex("Session: ([^;\\r\\n]+)").find(setup)!!.groupValues[1]
        exchange("SETUP $url/trackID=1 RTSP/1.0\r\nCSeq: 3\r\nSession: $session\r\nTransport: RTP/AVP/TCP;unicast;interleaved=2-3\r\n\r\n")
        val play = exchange("PLAY $url RTSP/1.0\r\nCSeq: 4\r\nSession: $session\r\n\r\n")
        assertTrue(play, play.contains("trackID=0;seq=0;rtptime=0"))
        val requestsAtPlay = keyframeRequests.get()

        fun picture(capture: Double, key: Boolean, tag: Byte) =
            EncodedVideoFrame(listOf(byteArrayOf(if (key) 0x65 else 0x41, tag, tag, tag)), isKeyframe = key, presentationTime = capture)
        connection.send(picture(50.0, true, 1), StreamCodec.H264)
        connection.send(EncodedAudioFrame(ByteArray(40) { 1 }, 50.0, 48_000, 1, captureTime = 50.0))
        Thread.sleep(200)
        // Captured 0.1 s after the keyframe, but handed over 1.5 s later: too late to show.
        now = 51.6
        connection.send(picture(50.1, false, 2), StreamCodec.H264)
        connection.send(EncodedAudioFrame(ByteArray(40) { 2 }, 50.1, 48_000, 1, captureTime = 50.1))
        connection.send(picture(51.6, false, 3), StreamCodec.H264)
        connection.send(picture(51.62, true, 4), StreamCodec.H264)
        connection.send(EncodedAudioFrame(ByteArray(40) { 3 }, 51.62, 48_000, 1, captureTime = 51.62))

        client.soTimeout = 3_000
        val packets = mutableListOf<Pair<Int, ByteArray>>()
        while (packets.count { it.first == 0 } < 2 || packets.count { it.first == 2 } < 2) {
            val marker = input.read()
            if (marker < 0) break
            if (marker != 0x24) continue
            val channel = input.read()
            val length = (input.read() shl 8) or input.read()
            packets.add(channel to input.readNBytes(length))
        }
        Thread.sleep(100)
        val snapshot = connection.sendQueueSnapshot()
        connection.close()
        client.close()
        listener.close()

        val pictures = packets.filter { it.first == 0 }.map { it.second }
        assertEquals(listOf(1, 4), pictures.map { it[13].toInt() })
        assertEquals("unbroken", listOf(0, 1), pictures.map { ((it[2].toInt() and 0xFF) shl 8) or (it[3].toInt() and 0xFF) })
        val sounds = packets.filter { it.first == 2 }.map { it.second }
        assertEquals(listOf(0, 1), sounds.map { ((it[2].toInt() and 0xFF) shl 8) or (it[3].toInt() and 0xFF) })
        assertEquals("the stamp skips the sound dropped", 51.62 - 50.0, (readUInt32(sounds[1], 4) - readUInt32(sounds[0], 4)) / 48_000.0, 0.03)
        assertEquals(2, snapshot.droppedFrames)
        assertEquals(1, snapshot.flushes)
        assertEquals(1024 / 48_000.0, snapshot.droppedSoundSeconds, 1e-9)
        assertTrue("a keyframe was asked for", keyframeRequests.get() > requestsAtPlay)
    }

    private fun readUInt32(bytes: ByteArray, at: Int): Long =
        ((bytes[at].toLong() and 0xFF) shl 24) or ((bytes[at + 1].toLong() and 0xFF) shl 16) or
            ((bytes[at + 2].toLong() and 0xFF) shl 8) or (bytes[at + 3].toLong() and 0xFF)

    private fun readResponse(input: InputStream): String {
        val text = StringBuilder()
        while (!text.endsWith("\r\n\r\n")) {
            val next = input.read()
            if (next < 0) break
            text.append(next.toChar())
        }
        val length = Regex("Content-Length: (\\d+)", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1)?.toInt() ?: 0
        if (length > 0) text.append(String(input.readNBytes(length)))
        return text.toString()
    }
}
