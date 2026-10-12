package app.teamstation.streamcore

import app.teamstation.streamcore.encode.ADTSHeader
import app.teamstation.streamcore.encode.AudioSpecificConfigBuilder
import app.teamstation.streamcore.encode.NALUnitConversion
import app.teamstation.streamcore.encode.PCMPendingBuffer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioSpecificConfigTest {

    @Test
    fun `AAC-LC at 48k mono is the known-good two bytes`() {
        // Object type 2 (5 bits), frequency index 3 for 48 kHz (4 bits), channel config 1 (4 bits),
        // then three zero flags: 00010 0011 0001 000 -> 0x11 0x88.
        val config = AudioSpecificConfigBuilder.aacLC(48_000, 1)
        assertNotNull(config)
        assertArrayEquals(byteArrayOf(0x11, 0x88.toByte()), config)
        assertEquals("1188", AudioSpecificConfigBuilder.hex(config!!))
    }

    @Test
    fun `AAC-LC at 44_1k stereo`() {
        // Frequency index 4, channel config 2: 00010 0100 0010 000 -> 0x12 0x10.
        assertArrayEquals(
            byteArrayOf(0x12, 0x10),
            AudioSpecificConfigBuilder.aacLC(44_100, 2)
        )
    }

    @Test
    fun `a rate AAC cannot express is refused rather than mis-encoded`() {
        assertNull(AudioSpecificConfigBuilder.aacLC(47_000, 1))
        assertNull(AudioSpecificConfigBuilder.aacLC(48_000, 0))
        assertNull(AudioSpecificConfigBuilder.aacLC(48_000, 8))
    }

    @Test
    fun `hex is lower case with no separators, which is what SDP config= wants`() {
        assertEquals("00ff10", AudioSpecificConfigBuilder.hex(byteArrayOf(0, 0xFF.toByte(), 0x10)))
    }
}

class ADTSHeaderTest {

    @Test
    fun `describes AAC-LC at 48k stereo`() {
        val header = ADTSHeader.make(300, 48_000, 2)
        assertNotNull(header)
        header!!
        assertEquals(7, header.size)
        // Syncword, MPEG-4, layer 0, protection absent.
        assertEquals(0xFF, header[0].toInt() and 0xFF)
        assertEquals(0xF1, header[1].toInt() and 0xFF)

        val profile = (header[2].toInt() shr 6) and 0x03
        assertEquals(1, profile)

        val frequencyIndex = (header[2].toInt() shr 2) and 0x0F
        assertEquals(48_000, AudioSpecificConfigBuilder.sampleRateIndices[frequencyIndex])

        val highChannelBit = (header[2].toInt() and 0x01) shl 2
        val lowChannelBits = (header[3].toInt() and 0xFF) shr 6
        assertEquals(2, highChannelBit or lowChannelBits)
    }

    @Test
    fun `the length field covers the header as well as the payload`() {
        val header = ADTSHeader.make(300, 44_100, 1)
        assertEquals(307, frameLength(header!!))
    }

    @Test
    fun `the length field survives its byte boundaries`() {
        // The field is split across three bytes, so an off-by-one in the shifts only shows up at
        // values that straddle a byte edge.
        for (payloadCount in listOf(1, 7, 8, 255, 256, 2_040, 2_048, 8_184)) {
            val header = ADTSHeader.make(payloadCount, 48_000, 2)
            assertNotNull("payload $payloadCount", header)
            assertEquals("payload $payloadCount", payloadCount + 7, frameLength(header!!))
        }
    }

    @Test
    fun `wrap prefixes the payload without altering it`() {
        val accessUnit = byteArrayOf(0x21, 0x1A, 0xBC.toByte(), 0xDE.toByte())
        val frame = ADTSHeader.wrap(accessUnit, 48_000, 1)
        assertNotNull(frame)
        assertEquals(7 + accessUnit.size, frame!!.size)
        assertArrayEquals(accessUnit, frame.copyOfRange(7, frame.size))
    }

    @Test
    fun `a frame ADTS cannot describe is refused rather than mis-headered`() {
        assertNull(ADTSHeader.make(0, 48_000, 1))
        assertNull(ADTSHeader.make(300, 47_000, 1))
        assertNull(ADTSHeader.make(1 shl 13, 48_000, 1))
    }

    /** The 13-bit field is split across bytes 3, 4 and 5. */
    private fun frameLength(header: ByteArray): Int {
        val high = (header[3].toInt() and 0x03) shl 11
        val middle = (header[4].toInt() and 0xFF) shl 3
        val low = (header[5].toInt() and 0xFF) shr 5
        return high or middle or low
    }
}

/**
 * The layout conversion is where the two platforms genuinely differ — VideoToolbox emits AVCC and
 * MediaCodec emits Annex-B — so both directions are tested here rather than only the one this build
 * uses. The AVCC path is what TS Director's decoder consumes.
 */
class NALUnitConversionTest {

    @Test
    fun `splits Annex-B on four-byte start codes`() {
        val data = byteArrayOf(
            0, 0, 0, 1, 0x67, 0x42,
            0, 0, 0, 1, 0x68, 0xCE.toByte(),
            0, 0, 0, 1, 0x65, 0x01, 0x02
        )
        val units = NALUnitConversion.elementaryUnitsFromAnnexB(data)
        assertEquals(3, units.size)
        assertArrayEquals(byteArrayOf(0x67, 0x42), units[0])
        assertArrayEquals(byteArrayOf(0x68, 0xCE.toByte()), units[1])
        assertArrayEquals(byteArrayOf(0x65, 0x01, 0x02), units[2])
    }

    @Test
    fun `splits Annex-B on three-byte start codes too`() {
        // MediaCodec mixes both widths within one buffer on some encoders, so assuming four would
        // fold two NAL units into one and the second would decode as picture data.
        val data = byteArrayOf(0, 0, 1, 0x67, 0x42, 0, 0, 1, 0x68, 0xCE.toByte())
        val units = NALUnitConversion.elementaryUnitsFromAnnexB(data)
        assertEquals(2, units.size)
        assertArrayEquals(byteArrayOf(0x67, 0x42), units[0])
        assertArrayEquals(byteArrayOf(0x68, 0xCE.toByte()), units[1])
    }

    @Test
    fun `a buffer with no start code yields nothing rather than one bogus unit`() {
        assertTrue(NALUnitConversion.elementaryUnitsFromAnnexB(byteArrayOf(1, 2, 3, 4)).isEmpty())
        assertTrue(NALUnitConversion.elementaryUnitsFromAnnexB(ByteArray(0)).isEmpty())
    }

    @Test
    fun `Annex-B round-trips through the elementary form`() {
        val units = listOf(byteArrayOf(0x67, 1, 2), byteArrayOf(0x68, 3), byteArrayOf(0x65, 4, 5, 6))
        val annexB = NALUnitConversion.annexBFromElementaryUnits(units)
        val back = NALUnitConversion.elementaryUnitsFromAnnexB(annexB)
        assertEquals(units.size, back.size)
        for (index in units.indices) assertArrayEquals(units[index], back[index])
    }

    @Test
    fun `AVCC round-trips through the elementary form`() {
        val units = listOf(byteArrayOf(0x67, 1, 2), byteArrayOf(0x65, 3, 4, 5))
        val avcc = NALUnitConversion.avccFromElementaryUnits(units)
        val back = NALUnitConversion.elementaryUnitsFromAVCC(avcc)
        assertNotNull(back)
        assertEquals(units.size, back!!.size)
        for (index in units.indices) assertArrayEquals(units[index], back[index])
    }

    @Test
    fun `a truncated AVCC buffer is refused rather than partially decoded`() {
        // A truncated final unit decodes into visible corruption and is better dropped than sent.
        assertNull(NALUnitConversion.elementaryUnitsFromAVCC(byteArrayOf(0, 0, 0, 9, 1, 2)))
        assertNull(NALUnitConversion.elementaryUnitsFromAVCC(byteArrayOf(0, 0)))
        assertNull(NALUnitConversion.elementaryUnitsFromAVCC(byteArrayOf(1, 2), lengthSize = 5))
    }
}

class PCMPendingBufferTest {

    @Test
    fun `takes whole frames and holds the remainder over`() {
        val buffer = PCMPendingBuffer()
        buffer.append(ByteArray(100) { it.toByte() })
        assertEquals(100, buffer.readableCount)

        val chunk = buffer.take(40)
        assertNotNull(chunk)
        assertEquals(40, chunk!!.size)
        assertEquals(60, buffer.readableCount)
        // Short of a frame is held over rather than padded with silence, which would put a click
        // into the stream at every buffer boundary.
        assertNull(buffer.take(61))
    }

    @Test
    fun `unread puts a frame back exactly`() {
        val buffer = PCMPendingBuffer()
        buffer.append(byteArrayOf(1, 2, 3, 4, 5, 6))
        val taken = buffer.take(4)!!
        buffer.unread(taken.size)
        assertEquals(6, buffer.readableCount)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), buffer.take(4))
    }

    @Test
    fun `compacting gives the consumed prefix back rather than only sliding a cursor`() {
        val buffer = PCMPendingBuffer()
        buffer.append(ByteArray(PCMPendingBuffer.compactThreshold * 2))
        buffer.take(PCMPendingBuffer.compactThreshold)
        assertEquals(PCMPendingBuffer.compactThreshold * 2, buffer.storedCount)

        buffer.compactIfNeeded()
        // The decisive property: allocated bytes shrink, so a microphone drained as fast as it
        // arrives does not still climb megabytes a minute.
        assertEquals(PCMPendingBuffer.compactThreshold, buffer.storedCount)
        assertEquals(PCMPendingBuffer.compactThreshold, buffer.readableCount)
    }

    @Test
    fun `draining everything releases the storage`() {
        val buffer = PCMPendingBuffer()
        buffer.append(ByteArray(64))
        buffer.take(64)
        buffer.compactIfNeeded()
        assertEquals(0, buffer.storedCount)
        assertEquals(0, buffer.readableCount)
    }

    @Test
    fun `skip discards without reading`() {
        val buffer = PCMPendingBuffer()
        buffer.append(byteArrayOf(1, 2, 3, 4))
        buffer.skip(2)
        assertEquals(2, buffer.readableCount)
        assertArrayEquals(byteArrayOf(3, 4), buffer.take(2))
    }
}
