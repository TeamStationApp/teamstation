package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.bitrate.CongestionSample
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

/** The ported codecs on their own: URLs, AMF0, chunk reassembly, FLV classification, the ledger. */
class RtmpCodecTest {
    @Test
    fun urlsParseAsDirectorParsesThem() {
        assertEquals(
            RTMPURL.Parsed.Success(RTMPURL("ingest.example.test", 1935, "live", "a/b")),
            RTMPURL.parse("  rtmp://ingest.example.test/live/a/b ")
        )
        assertEquals("rtmp://ingest.example.test:1936/live/key", RTMPURL.require("RTMP://ingest.example.test:1936/live/key").description)
        val failures = mapOf(
            "" to RTMPURL.ParseError.EMPTY,
            "http://ingest.example.test/live/key" to RTMPURL.ParseError.NOT_RTMP,
            "rtmps://ingest.example.test/live/key" to RTMPURL.ParseError.RTMPS_UNSUPPORTED,
            "rtmp:///live/key" to RTMPURL.ParseError.MISSING_HOST,
            "rtmp://ingest.example.test" to RTMPURL.ParseError.MISSING_APP,
            "rtmp://ingest.example.test/live" to RTMPURL.ParseError.MISSING_STREAM
        )
        for ((raw, error) in failures) assertEquals(raw, RTMPURL.Parsed.Failure(error), RTMPURL.parse(raw))
        val thrown = runCatching { RTMPURL.require("") }.exceptionOrNull() as RTMPURL.InvalidURLException
        assertEquals(RTMPURL.ParseError.EMPTY, thrown.error)
        assertEquals("set a stream URL in Settings", thrown.message)
    }

    @Test
    fun amf0RoundTripsEveryValue() {
        val values = listOf(
            AMF0.Number(1.5),
            AMF0.Bool(true),
            AMF0.Bool(false),
            AMF0.Str("onStatus"),
            AMF0.Object(mapOf("code" to AMF0.Str("ok"), "level" to AMF0.Number(2.0))),
            AMF0.Null,
            AMF0.Undefined,
            AMF0.EcmaArray(mapOf("width" to AMF0.Number(1920.0))),
            AMF0.StrictArray(listOf(AMF0.Str("hvc1"), AMF0.Null))
        )
        assertEquals(values, AMF0.decodeList(AMF0.encode(values)))
        assertEquals("ok", values[4].objectValue!!["code"]!!.stringValue)
        assertEquals(1920.0, values[7].objectValue!!["width"]!!.numberValue!!, 0.0)
        assertNull(values[0].stringValue)
        assertNull(values[3].numberValue)
        assertNull(values[3].objectValue)
        assertArrayEquals(byteArrayOf(0x05), AMF0.Null.encode())
        // A long string, and the decoder stopping at what it cannot read.
        val long = byteArrayOf(0x0C, 0, 0, 0, 2) + "hi".toByteArray()
        assertEquals(listOf(AMF0.Str("hi")), AMF0.decodeList(long))
        for (broken in listOf(
            byteArrayOf(0x00, 1, 2),
            byteArrayOf(0x01),
            byteArrayOf(0x02, 0, 5, 1),
            byteArrayOf(0x03, 0, 1, 0x41),
            byteArrayOf(0x03, 0, 0),
            byteArrayOf(0x08, 0, 0),
            byteArrayOf(0x0A, 0, 0),
            byteArrayOf(0x0A, 0, 0, 0, 2, 0x05),
            byteArrayOf(0x0C, 0, 0),
            byteArrayOf(0x11)
        )) {
            assertEquals(broken.toList().toString(), emptyList<AMF0>(), AMF0.decodeList(broken))
        }
        assertNull(AMF0.decode(ByteArray(0), AMF0.Cursor()))
    }

    @Test
    fun theChunkReaderReassemblesEveryHeaderForm() {
        val reader = RTMPChunkReader()
        val out = ByteArrayOutputStream()
        // fmt 0 on a two-byte chunk stream ID (70), payload 200 bytes in 128-byte chunks.
        val first = RTMPMessage(1, RTMPMessageType.VIDEO, 100, ByteArray(200) { it.toByte() })
        out.write(RTMPChunk.encode(first, 70, 128))
        // fmt 1 (delta 10, new length), fmt 2 (delta 5), fmt 3 (same again), by hand.
        out.write(byteArrayOf((1 shl 6 or 5).toByte(), 0, 0, 10, 0, 0, 2, 8, 7, 7))
        // fmt 0 for stream 5 first, so fmt 1 has a state to build on.
        val audio = RTMPMessage(1, RTMPMessageType.AUDIO, 50, byteArrayOf(1, 2))
        val all = RTMPChunk.encode(audio, 5, 128) + out.toByteArray().let { bytes ->
            // Put the stream 5 messages after the stream 70 one.
            bytes
        }
        val messages = reader.push(all.copyOfRange(0, 7)) + reader.push(all.copyOfRange(7, all.size))
        assertEquals(audio, messages[0])
        assertEquals(first, messages[1])
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 60, byteArrayOf(7, 7)), messages[2])
        val fmt2 = reader.push(byteArrayOf((2 shl 6 or 5).toByte(), 0, 0, 5, 9, 9))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 65, byteArrayOf(9, 9)), fmt2.single())
        val fmt3 = reader.push(byteArrayOf((3 shl 6 or 5).toByte(), 4, 4))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 65, byteArrayOf(4, 4)), fmt3.single())

        // A three-byte chunk stream ID and an extended timestamp, read back.
        val far = RTMPMessage(1, RTMPMessageType.AMF0_DATA, 0x1_0000_0000L - 1, byteArrayOf(5))
        assertEquals(far, reader.push(RTMPChunk.encode(far, 400, 128)).single())
        // Extended deltas on fmt 1 and fmt 2.
        val extended1 = byteArrayOf((1 shl 6 or 6).toByte(), -1, -1, -1, 0, 0, 1, 8, 0, 0, 0, 1, 3)
        val base = RTMPMessage(1, RTMPMessageType.AUDIO, 1, byteArrayOf(0))
        reader.push(RTMPChunk.encode(base, 6, 128))
        assertEquals(2L, reader.push(extended1).single().timestamp)
        val extended2 = byteArrayOf((2 shl 6 or 6).toByte(), -1, -1, -1, 0, 0, 0, 2, 3)
        assertEquals(4L, reader.push(extended2).single().timestamp)

        // A fmt 3 header carries an extended timestamp only when the header it follows did, not
        // whenever the timestamp has grown past 24 bits: here the deltas are small and it has none.
        val late = RTMPMessage(1, RTMPMessageType.AUDIO, 0xFFFFF0L, byteArrayOf(0))
        assertEquals(late, reader.push(RTMPChunk.encode(late, 7, 128)).single())
        val pastWrap = reader.push(byteArrayOf((2 shl 6 or 7).toByte(), 0, 0, 0x20, 1))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 0x1000010L, byteArrayOf(1)), pastWrap.single())
        val plainFmt3 = reader.push(byteArrayOf((3 shl 6 or 7).toByte(), 2))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 0x1000010L, byteArrayOf(2)), plainFmt3.single())
        // After an extended header the fmt 3 field is there, and is not payload.
        val extendedFmt3 = reader.push(byteArrayOf((3 shl 6 or 6).toByte(), 0, 0, 0, 2, 3))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 4, byteArrayOf(3)), extendedFmt3.single())
        // Split inside that field, it waits for the rest.
        assertEquals(emptyList<RTMPMessage>(), reader.push(byteArrayOf((3 shl 6 or 6).toByte(), 0, 0)))
        assertEquals(RTMPMessage(1, RTMPMessageType.AUDIO, 4, byteArrayOf(5)), reader.push(byteArrayOf(0, 2, 5)).single())

        // A set chunk size changes how the next chunks are read.
        val setSize = RTMPMessage(0, RTMPMessageType.SET_CHUNK_SIZE, 0, byteArrayOf(0, 0, 1, 0))
        reader.push(RTMPChunk.encode(setSize, 2, 128))
        assertEquals(256, reader.chunkSize)
        val big = RTMPMessage(1, RTMPMessageType.VIDEO, 0, ByteArray(300))
        assertEquals(big, reader.push(RTMPChunk.encode(big, 9, 256)).single())
        reader.setChunkSize(0)
        assertEquals(1, reader.chunkSize)
        // An unknown message type is consumed and skipped.
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf(2, 0, 0, 0, 0, 0, 1, 0x63, 0, 0, 0, 0, 1)))
        // Partial headers wait for more.
        for (partial in listOf(byteArrayOf(0), byteArrayOf(1, 0), byteArrayOf(2, 0, 0))) {
            assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(partial))
        }
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf(2, -1, -1, -1, 0, 0, 1, 8, 0, 0, 0, 0)))
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf((1 shl 6 or 5).toByte(), -1, -1, -1, 0, 0, 1, 8)))
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf((2 shl 6 or 5).toByte(), -1, -1, -1)))
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf((1 shl 6 or 5).toByte(), 0)))
        assertEquals(emptyList<RTMPMessage>(), RTMPChunkReader().push(byteArrayOf((2 shl 6 or 5).toByte(), 0)))
        assertTrue(first.toString().contains("VIDEO"))
        assertEquals(first.hashCode(), RTMPMessage(1, RTMPMessageType.VIDEO, 100, ByteArray(200) { it.toByte() }).hashCode())
        assertFalse(first.equals("video"))
        assertNull(RTMPMessageType.of(99))
    }

    @Test
    fun flvTagsAreClassifiedInBothFramings() {
        val avcHeader = FLVTag.videoSequenceHeader(RTMPVideoCodec.H264, byteArrayOf(1))
        assertTrue(FLVTag.isVideoSequenceHeader(avcHeader))
        assertTrue(FLVTag.isVideoKeyframe(avcHeader))
        val avcDelta = FLVTag.videoFrame(RTMPVideoCodec.H264, false, byteArrayOf(1))
        assertFalse(FLVTag.isVideoSequenceHeader(avcDelta))
        assertFalse(FLVTag.isVideoKeyframe(avcDelta))
        assertTrue(FLVTag.isVideoSequenceHeader(FLVTag.videoSequenceHeader(RTMPVideoCodec.HEVC, byteArrayOf(1))))
        assertFalse(FLVTag.isVideoSequenceHeader(FLVTag.videoFrame(RTMPVideoCodec.HEVC, true, byteArrayOf(1))))
        assertFalse(FLVTag.isVideoSequenceHeader(ByteArray(0)))
        assertFalse(FLVTag.isVideoKeyframe(ByteArray(0)))
        assertTrue(FLVTag.isAudioSequenceHeader(FLVTag.audio(0, byteArrayOf(0x11))))
        assertFalse(FLVTag.isAudioSequenceHeader(FLVTag.audio(1, byteArrayOf(0x11))))
        // Coded frames X carry no composition time; another FourCC carries none either.
        assertEquals(6, FLVTag.enhancedVideo(true, FLVTag.EnhancedPacketType.CODED_FRAMES_X, RTMPVideoCodec.HEVC.fourCC, payload = byteArrayOf(1)).size)
        assertEquals(6, FLVTag.enhancedVideo(true, FLVTag.EnhancedPacketType.CODED_FRAMES, FLVTag.fourCC("av01"), payload = byteArrayOf(1)).size)
        assertEquals(0x68766331L, RTMPVideoCodec.HEVC.fourCC)
        assertEquals(7.0, RTMPVideoCodec.H264.metadataCodecID, 0.0)
        assertEquals(0x68766331.toDouble(), RTMPVideoCodec.HEVC.metadataCodecID, 0.0)
        assertEquals("avc1", RTMPVideoCodec.H264.fourCCString)
        assertEquals("H.264", RTMPVideoCodec.H264.displayName)
        assertEquals(RTMPVideoCodec.H264, RTMPVideoCodec.of(app.teamstation.streamcore.core.StreamCodec.H264))
        val record = FLVTag.avcDecoderConfigurationRecord(byteArrayOf(0x67, 0x42, 0, 0x1F), byteArrayOf(0x68, 1))
        assertEquals(listOf<Byte>(1, 0x42, 0, 0x1F, -1, -31, 0, 4), record.take(8))
        assertEquals(listOf<Byte>(1, 0x64, 0, 0x1F), FLVTag.avcDecoderConfigurationRecord(byteArrayOf(0x67), byteArrayOf(0x68)).take(4))
    }

    @Test
    fun anUnreadableSpsHasNoRecord() {
        val vps = byteArrayOf(0x40, 1, 0)
        val pps = byteArrayOf(0x44, 1, 0)
        assertNull(HEVCDecoderConfiguration.record(listOf(vps, pps)))
        assertNull(HEVCDecoderConfiguration.record(listOf(vps, byteArrayOf(0x42, 1), pps)))
        assertNull(HEVCDecoderConfiguration.record(listOf(vps, byteArrayOf(0x42, 1, 0x01, 0x60), pps)))
        assertNull(HEVCDecoderConfiguration.pictureSize(byteArrayOf(0x42)))
        assertNull(HEVCDecoderConfiguration.nalType(ByteArray(0)))
        assertArrayEquals(byteArrayOf(0, 0, 1, 0, 0, 0), HEVCDecoderConfiguration.rbsp(byteArrayOf(0, 0, 3, 1, 0, 0, 3, 0)))
        val bits = HEVCDecoderConfiguration.BitReader(byteArrayOf(0b0010_0110.toByte()))
        assertEquals(3L, bits.readExpGolomb())
        assertEquals(0L, bits.readExpGolomb())
        assertNull(bits.read(8))
        assertFalse(bits.skip(9))
        assertNull(HEVCDecoderConfiguration.BitReader(ByteArray(5)).readExpGolomb())
    }

    @Test
    fun theLedgerAgesTheOldestWriteAndTakesAudioOut() {
        val ledger = RTMPSendLedger()
        ledger.submitted(0, 0.0)
        ledger.submitted(1000, 10.0)
        ledger.submitted(500, 10.5)
        ledger.offered(1000, isAudio = false)
        ledger.offered(100, isAudio = true)
        assertEquals(1500, ledger.pendingBytes)
        assertEquals(1.0, ledger.queueDelay(11.0), 0.0)
        ledger.delivered(1100)
        assertEquals(400, ledger.pendingBytes)
        assertEquals(0.5, ledger.queueDelay(11.0), 0.0)
        val first = ledger.sample(11.0, droppedPackets = 2, transportBacklogBytes = 300)
        assertEquals(CongestionSample(0.0, 0.5, 1000, 1000, 300, 1000, 2, 0), first)
        ledger.delivered(400)
        val second = ledger.sample(12.0, droppedPackets = 5, transportBacklogBytes = 500)
        assertEquals(CongestionSample(1.0, 0.0, 400, 0, 500, 200, 3, 0), second)
        ledger.submitted(10, 13.0)
        ledger.resetWaiting(listOf(5), listOf(12.5))
        assertEquals(0.5, ledger.queueDelay(13.0), 0.0)
        ledger.clear()
        assertEquals(0.0, ledger.queueDelay(13.0), 0.0)
        // A long run compacts.
        repeat(600) { ledger.submitted(1, it.toDouble()) }
        ledger.delivered(599)
        assertEquals(1, ledger.pendingBytes)
        assertEquals(1.0, ledger.queueDelay(600.0), 0.0)
        val gate = StreamErrorGate()
        assertTrue(gate.shouldPresent("a"))
        assertFalse(gate.shouldPresent("a"))
        gate.reset()
        assertTrue(gate.shouldPresent("a"))
        assertEquals(0.0, StreamMetrics.megabits(100, 0.0), 0.0)
        assertEquals(8.0, StreamMetrics.megabits(1_000_000, 1.0), 0.0)
    }
}
