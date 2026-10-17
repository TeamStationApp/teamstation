package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.Json
import app.teamstation.streamcore.hex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The wall-clock SEI is byte for byte the one TeamStation reads and TS Director writes: all three
 * check `src/test/wallClockSeiVectors.json`.
 */
class WallClockSEITest {
    @Suppress("UNCHECKED_CAST")
    private val vectors: Map<String, Any?> by lazy {
        val configured = System.getProperty("wallClockSeiVectors")?.let(::File)
        val file = configured?.takeIf { it.isFile }
            ?: generateSequence(File("").absoluteFile) { it.parentFile }
                .map { File(it, "src/test/wallClockSeiVectors.json") }
                .first { it.isFile }
        Json.parse(file.readText()) as Map<String, Any?>
    }

    @Suppress("UNCHECKED_CAST")
    private val cases: List<Map<String, Any?>> get() = vectors["vectors"] as List<Map<String, Any?>>

    @Test
    fun theIdentityMatchesTheServers() {
        assertEquals(vectors["uuid"], WallClockSEI.UUID.hex())
        assertEquals((vectors["version"] as Double).toInt(), WallClockSEI.VERSION)
        assertEquals((vectors["payloadType"] as Double).toInt(), WallClockSEI.PAYLOAD_TYPE)
        assertEquals((vectors["payloadSize"] as Double).toInt(), WallClockSEI.PAYLOAD_SIZE)
    }

    @Test
    fun everyVectorEncodesToTheServersBytesInBothCodecs() {
        assertTrue(cases.size >= 4)
        for (case in cases) {
            val wallMs = (case["wallMs"] as Double).toLong()
            val corrected = case["corrected"] as Boolean
            assertEquals(case["name"] as String, case["h264"], WallClockSEI.encode(RTMPVideoCodec.H264, wallMs, corrected).hex())
            assertEquals(case["name"] as String, case["hevc"], WallClockSEI.encode(RTMPVideoCodec.HEVC, wallMs, corrected).hex())
        }
    }

    @Test
    fun emulationPreventionBreaksEveryStartCode() {
        assertEquals("00000300000301", WallClockSEI.addEmulationPrevention(byteArrayOf(0, 0, 0, 0, 1)).hex())
        assertEquals("000004", WallClockSEI.addEmulationPrevention(byteArrayOf(0, 0, 4)).hex())
    }

    @Test
    fun aSliceIsTheFramesPicture() {
        assertTrue(WallClockSEI.isSlice(RTMPVideoCodec.H264, 0x65))
        assertTrue(WallClockSEI.isSlice(RTMPVideoCodec.H264, 0x41))
        assertFalse(WallClockSEI.isSlice(RTMPVideoCodec.H264, 0x06))
        assertFalse(WallClockSEI.isSlice(RTMPVideoCodec.H264, 0x67))
        assertTrue(WallClockSEI.isSlice(RTMPVideoCodec.HEVC, (19 shl 1).toByte()))
        assertTrue(WallClockSEI.isSlice(RTMPVideoCodec.HEVC, (1 shl 1).toByte()))
        assertFalse(WallClockSEI.isSlice(RTMPVideoCodec.HEVC, (39 shl 1).toByte()))
        assertFalse(WallClockSEI.isSlice(RTMPVideoCodec.HEVC, (35 shl 1).toByte()))
    }

    @Test
    fun aFramesSeiGoesAfterWhatPrecedesItsPicture() {
        val delimiter = byteArrayOf((35 shl 1).toByte(), 1, 0x50)
        val other = byteArrayOf((39 shl 1).toByte(), 1, 5, 1, 0x7F, 0x80.toByte())
        val idr = byteArrayOf((19 shl 1).toByte(), 1, 9)
        val onServer = FrameWallClock(contentWallMs = 1_700_000_000_000, serverClockOffsetMs = -250)
        assertEquals(1_699_999_999_750, onServer.wallMs)
        assertTrue(onServer.corrected)
        val sei = WallClockSEI.encode(RTMPVideoCodec.HEVC, onServer.wallMs, true)
        assertEquals(
            listOf(delimiter, other, sei, idr).map { it.hex() },
            onServer.inserted(listOf(delimiter, other, idr), RTMPVideoCodec.HEVC).map { it.hex() }
        )
        // Unmeasured: the phone's own clock, the corrected bit clear; and with no slice, at the end.
        val own = FrameWallClock(contentWallMs = 1_700_000_000_123, serverClockOffsetMs = null)
        assertFalse(own.corrected)
        assertEquals(
            listOf(delimiter.hex(), WallClockSEI.encode(RTMPVideoCodec.HEVC, 1_700_000_000_123, false).hex()),
            own.inserted(listOf(delimiter), RTMPVideoCodec.HEVC).map { it.hex() }
        )
        val h264 = FrameWallClock(contentWallMs = 1_700_000_000_000, serverClockOffsetMs = 0)
        val slice = byteArrayOf(0x65, 1)
        assertEquals(
            listOf(WallClockSEI.encode(RTMPVideoCodec.H264, 1_700_000_000_000, true).hex(), slice.hex()),
            h264.inserted(listOf(slice), RTMPVideoCodec.H264).map { it.hex() }
        )
    }
}
