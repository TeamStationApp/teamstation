package co.gamestation.cameraman

import co.gamestation.cameraman.core.EncodedAudioFrame
import co.gamestation.cameraman.core.EncodedVideoFrame
import co.gamestation.cameraman.rtsp.AACPacketizer
import co.gamestation.cameraman.rtsp.H264Packetizer
import co.gamestation.cameraman.rtsp.HEVCPacketizer
import co.gamestation.cameraman.rtsp.InterleavedChannel
import co.gamestation.cameraman.rtsp.InterleavedFramer
import co.gamestation.cameraman.rtsp.RTPLimits
import co.gamestation.cameraman.rtsp.RTPPacketWriter
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The packetizers are round-tripped rather than only inspected: every test that fragments also
 * reassembles, because a packetizer that agrees with a depacketizer written from the same
 * misunderstanding proves nothing.
 */
class H264PacketizerTest {
    private val packetizer = H264Packetizer()

    @Test
    fun `a NAL that fits goes out whole`() {
        val nal = ByteArray(100) { (it + 1).toByte() }.also { it[0] = 0x65 }
        val payloads = packetizer.payloads(nal)
        assertEquals(1, payloads.size)
        assertArrayEquals(nal, payloads[0])
    }

    @Test
    fun `a NAL that does not fit becomes FU-A fragments that reassemble`() {
        val nal = ByteArray(4_000) { (it % 251).toByte() }
        nal[0] = 0x65 // IDR slice, nal_ref_idc 3.
        val payloads = packetizer.payloads(nal)
        assertTrue(payloads.size > 1)

        for (payload in payloads) {
            assertTrue(payload.size <= RTPLimits.defaultMaximumPayloadCount)
            // The FU indicator keeps the original nal_ref_idc and substitutes type 28.
            assertEquals(28, payload[0].toInt() and 0x1F)
            assertEquals(0x60, payload[0].toInt() and 0xE0)
            // Every fragment repeats the original type in the FU header.
            assertEquals(5, payload[1].toInt() and 0x1F)
        }

        // Start bit on the first only, end bit on the last only.
        assertEquals(0x80, payloads.first()[1].toInt() and 0x80)
        assertEquals(0, payloads.first()[1].toInt() and 0x40)
        assertEquals(0x40, payloads.last()[1].toInt() and 0x40)
        assertEquals(0, payloads.last()[1].toInt() and 0x80)

        val reassembled = reassembleFUA(payloads)
        assertArrayEquals(nal, reassembled)
    }

    @Test
    fun `parameter sets precede the picture in a keyframe's payloads`() {
        val frame = EncodedVideoFrame(
            nalUnits = listOf(byteArrayOf(0x65, 1, 2)),
            parameterSets = listOf(byteArrayOf(0x67, 3), byteArrayOf(0x68, 4)),
            isKeyframe = true,
            presentationTime = 0.0
        )
        val payloads = packetizer.payloads(frame)
        assertEquals(3, payloads.size)
        // A decoder that receives the slice before the parameter sets that describe it shows a black
        // tile until the next keyframe.
        assertEquals(0x67, payloads[0][0].toInt() and 0xFF)
        assertEquals(0x68, payloads[1][0].toInt() and 0xFF)
        assertEquals(0x65, payloads[2][0].toInt() and 0xFF)
    }

    @Test
    fun `an empty NAL produces nothing rather than a header-only packet`() {
        assertTrue(packetizer.payloads(ByteArray(0)).isEmpty())
    }

    @Test
    fun `the clock is 90 kHz regardless of frame rate`() {
        assertEquals(90_000L, H264Packetizer.clockRate)
    }

    private fun reassembleFUA(payloads: List<ByteArray>): ByteArray {
        val body = java.io.ByteArrayOutputStream()
        var header = 0
        for ((index, payload) in payloads.withIndex()) {
            val indicator = payload[0].toInt() and 0xFF
            val fuHeader = payload[1].toInt() and 0xFF
            if (index == 0) header = (indicator and 0xE0) or (fuHeader and 0x1F)
            body.write(payload, 2, payload.size - 2)
        }
        return byteArrayOf(header.toByte()) + body.toByteArray()
    }
}

class HEVCPacketizerTest {
    private val packetizer = HEVCPacketizer()

    @Test
    fun `a NAL that fits goes out whole`() {
        val nal = byteArrayOf(0x26, 0x01, 1, 2, 3)
        assertArrayEquals(nal, packetizer.payloads(nal).single())
    }

    @Test
    fun `fragments use type 49 and a three-byte header, and reassemble`() {
        val nal = ByteArray(4_000) { (it % 241).toByte() }
        // Type 19 (IDR_W_RADL) in bits 1..6 of the first byte.
        nal[0] = (19 shl 1).toByte()
        nal[1] = 0x01
        val payloads = packetizer.payloads(nal)
        assertTrue(payloads.size > 1)

        for (payload in payloads) {
            assertTrue(payload.size <= RTPLimits.defaultMaximumPayloadCount)
            // Fragmentation type 49, layer id and TID preserved from the original header.
            assertEquals(49, (payload[0].toInt() and 0xFF) shr 1 and 0x3F)
            assertEquals(0x01, payload[1].toInt() and 0xFF)
            assertEquals(19, payload[2].toInt() and 0x3F)
        }
        assertEquals(0x80, payloads.first()[2].toInt() and 0x80)
        assertEquals(0x40, payloads.last()[2].toInt() and 0x40)

        val body = java.io.ByteArrayOutputStream()
        for (payload in payloads) body.write(payload, 3, payload.size - 3)
        assertArrayEquals(nal, byteArrayOf(nal[0], nal[1]) + body.toByteArray())
    }

    @Test
    fun `a NAL shorter than its two-byte header produces nothing`() {
        assertTrue(packetizer.payloads(byteArrayOf(0x26)).isEmpty())
    }
}

class AACPacketizerTest {
    private val packetizer = AACPacketizer()

    @Test
    fun `one access unit behind a two-byte AU-header section`() {
        val unit = ByteArray(300) { (it % 97).toByte() }
        val payload = packetizer.payload(
            EncodedAudioFrame(unit, presentationTime = 0.0, sampleRate = 48_000, channelCount = 1)
        )
        assertNotNull(payload)
        payload!!
        assertEquals(4 + unit.size, payload.size)

        // AU-headers-length is in *bits*, and it is the one field every hand-rolled RFC 3640 sender
        // writes in bytes by mistake.
        val headerBits = ((payload[0].toInt() and 0xFF) shl 8) or (payload[1].toInt() and 0xFF)
        assertEquals(AACPacketizer.sizeLength + AACPacketizer.indexLength, headerBits)

        val auHeader = ((payload[2].toInt() and 0xFF) shl 8) or (payload[3].toInt() and 0xFF)
        assertEquals(unit.size, auHeader shr AACPacketizer.indexLength)
        assertEquals(0, auHeader and 0x07)
        assertArrayEquals(unit, payload.copyOfRange(4, payload.size))
    }

    @Test
    fun `an access unit too large for the 13-bit size field is refused`() {
        // Emitting it would wrap the length field and the receiver would read the wrong size.
        val tooBig = ByteArray(1 shl AACPacketizer.sizeLength)
        assertNull(
            packetizer.payload(EncodedAudioFrame(tooBig, 0.0, 48_000, 1))
        )
        assertNull(packetizer.payload(EncodedAudioFrame(ByteArray(0), 0.0, 48_000, 1)))
    }

    @Test
    fun `the timestamp steps by 1024 samples per access unit`() {
        assertEquals(0L, AACPacketizer.timestamp(0))
        assertEquals(1024L, AACPacketizer.timestamp(1))
        assertEquals(10240L, AACPacketizer.timestamp(10))
        // It has to wrap at 32 bits like any other RTP timestamp rather than growing without bound.
        assertTrue(AACPacketizer.timestamp(Int.MAX_VALUE) <= 0xFFFFFFFFL)
    }
}

class RTPPacketWriterTest {

    @Test
    fun `writes the twelve-byte header RFC 3550 defines`() {
        val writer = RTPPacketWriter(payloadType = 96, ssrc = 0x12345678L)
        val packet = writer.packet(
            sequenceNumber = 0xBEEF,
            timestamp = 0xCAFEBABEL,
            marker = true,
            payload = byteArrayOf(1, 2, 3)
        )
        assertEquals(RTPPacketWriter.headerCount + 3, packet.size)
        // Version 2, no padding, no extension, no contributing sources.
        assertEquals(0x80, packet[0].toInt() and 0xFF)
        // Marker bit set, payload type 96.
        assertEquals(0x80 or 96, packet[1].toInt() and 0xFF)
        assertEquals(0xBE, packet[2].toInt() and 0xFF)
        assertEquals(0xEF, packet[3].toInt() and 0xFF)
        assertEquals(0xCA, packet[4].toInt() and 0xFF)
        assertEquals(0x12, packet[8].toInt() and 0xFF)
        assertArrayEquals(byteArrayOf(1, 2, 3), packet.copyOfRange(12, packet.size))
    }

    @Test
    fun `an unmarked packet clears the top bit rather than leaving it set`() {
        val writer = RTPPacketWriter(payloadType = 97, ssrc = 1)
        val packet = writer.packet(1, 1, marker = false, payload = ByteArray(0))
        assertEquals(97, packet[1].toInt() and 0xFF)
    }
}

class InterleavedFramerTest {

    @Test
    fun `frames as dollar, channel and a big-endian length`() {
        val payload = ByteArray(300) { it.toByte() }
        val framed = InterleavedFramer.frame(InterleavedChannel.video, payload)
        assertNotNull(framed)
        framed!!
        assertEquals(0x24, framed[0].toInt() and 0xFF)
        assertEquals(0, framed[1].toInt() and 0xFF)
        assertEquals(300 shr 8, framed[2].toInt() and 0xFF)
        assertEquals(300 and 0xFF, framed[3].toInt() and 0xFF)
        assertArrayEquals(payload, framed.copyOfRange(4, framed.size))
    }

    @Test
    fun `a payload too large for the 16-bit length is refused`() {
        assertNull(
            InterleavedFramer.frame(0, ByteArray(InterleavedFramer.maximumPayloadSize + 1))
        )
    }

    @Test
    fun `channels follow what GS Producer asks for`() {
        assertEquals(0, InterleavedChannel.video)
        assertEquals(1, InterleavedChannel.videoControl)
        assertEquals(2, InterleavedChannel.audio)
        assertEquals(3, InterleavedChannel.audioControl)
    }

    @Test
    fun `a batch of frames parses back into the original payloads`() {
        val payloads = listOf(byteArrayOf(1, 2), byteArrayOf(3, 4, 5), ByteArray(1_000))
        val batch = InterleavedFramer.frames(InterleavedChannel.video, payloads)

        var offset = 0
        val parsed = ArrayList<ByteArray>()
        while (offset < batch.size) {
            assertEquals(0x24, batch[offset].toInt() and 0xFF)
            val length = ((batch[offset + 2].toInt() and 0xFF) shl 8) or
                (batch[offset + 3].toInt() and 0xFF)
            parsed.add(batch.copyOfRange(offset + 4, offset + 4 + length))
            offset += 4 + length
        }
        assertEquals(payloads.size, parsed.size)
        for (index in payloads.indices) assertArrayEquals(payloads[index], parsed[index])
    }
}
