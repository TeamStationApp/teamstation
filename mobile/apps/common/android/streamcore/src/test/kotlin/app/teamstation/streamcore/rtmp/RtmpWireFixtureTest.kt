package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.MediaFixtures
import app.teamstation.streamcore.hex
import app.teamstation.streamcore.int
import app.teamstation.streamcore.list
import app.teamstation.streamcore.long
import app.teamstation.streamcore.obj
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The bytes on the wire equal TS Director's (`rtmp-*.bin` from `MediaFixtureWriter`), built from the
 * same inputs, and each chunked message reads back through [RTMPChunkReader].
 */
class RtmpWireFixtureTest {
    private val vps = bytes(
        0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03,
        0x00, 0x00, 0x03, 0x00, 0x78, 0x17, 0x02, 0x40
    )
    private val sps = bytes(
        0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03,
        0x00, 0x78, 0xA0, 0x03, 0xC0, 0x80, 0x11, 0x07, 0xCB, 0x88, 0x17, 0xB9, 0x16, 0x45, 0x2F, 0xFC,
        0xB9, 0xFC, 0x4F, 0xE8, 0x80
    )
    private val pps = bytes(0x44, 0x01, 0xC0, 0x72, 0xF0, 0x53, 0x24)
    private val audioSpecificConfig = bytes(0x11, 0x90)
    private val index = MediaFixtures.json("rtmp-wire.json")
    private val url = RTMPURL.require(index["url"] as String)

    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    private fun assertFixture(name: String, actual: ByteArray) {
        val expected = MediaFixtures.bytes("rtmp-$name.bin")
        assertEquals(name, expected.hex(), actual.hex())
        val entry = index["entries"].list().map { it.obj() }.first { it["name"] == name }
        assertEquals(name, expected.size, entry["bytes"].int())
        val stream = entry["chunkStreamID"] ?: return
        // A chunked message reads back as itself.
        val reader = RTMPChunkReader()
        reader.setChunkSize(entry["chunkSize"].int())
        val message = reader.push(actual).single()
        assertEquals(entry["messageType"].int(), message.type.rawValue)
        assertEquals(entry["timestamp"].long(), message.timestamp)
        assertTrue(stream.int() > 0)
    }

    @Test
    fun theHandshakeEqualsDirectors() {
        assertFixture("handshake-c0c1-head", RTMPHandshake.c0c1(0x01020304).copyOf(9))
        assertEquals(1 + RTMPHandshake.packetSize, RTMPHandshake.c0c1().size)
        val s1 = ByteArray(RTMPHandshake.packetSize) { (it % 251).toByte() }
        assertFixture("handshake-c2", RTMPHandshake.c2(s1))
    }

    @Test
    fun connectAndPublishEqualDirectors() {
        for (codec in listOf(RTMPVideoCodec.HEVC, RTMPVideoCodec.H264)) {
            val message = RTMPMessage(0, RTMPMessageType.AMF0_COMMAND, 0, RTMPClient.connectPayload(url, codec))
            assertFixture("connect-${codec.rawValue}", RTMPChunk.encode(message, 3, 4096))
        }
        val publish = RTMPMessage(1, RTMPMessageType.AMF0_COMMAND, 0, RTMPClient.publishPayload(url.stream))
        assertFixture("publish", RTMPChunk.encode(publish, 3, 4096))
        val metadata = RTMPMessage(
            1,
            RTMPMessageType.AMF0_DATA,
            0,
            RTMPClient.metadataPayload(1920, 1080, 30, 4_000_000, RTMPVideoCodec.HEVC)
        )
        assertFixture("onmetadata-hevc", RTMPChunk.encode(metadata, 4, 4096))
    }

    @Test
    fun theTagsEqualDirectors() {
        val record = HEVCDecoderConfiguration.record(listOf(vps, sps, pps))
        assertNotNull(record)
        assertFixture("hevc-sequence-start-tag", FLVTag.videoSequenceHeader(RTMPVideoCodec.HEVC, record!!))
        val keyframe = bytes(0x00, 0x00, 0x00, 0x08, 0x26, 0x01) + ByteArray(6) { it.toByte() }
        assertFixture("hevc-keyframe-tag", FLVTag.videoFrame(RTMPVideoCodec.HEVC, true, keyframe))
        val delta = bytes(0x00, 0x00, 0x00, 0x05, 0x02, 0x01, 0xAA, 0xBB, 0xCC)
        assertFixture("hevc-delta-tag", FLVTag.videoFrame(RTMPVideoCodec.HEVC, false, delta))
        assertFixture("aac-sequence-header-tag", FLVTag.audio(0, audioSpecificConfig))
        assertFixture("aac-raw-tag", FLVTag.audio(1, ByteArray(16) { (it * 3).toByte() }))
    }

    @Test
    fun chunkingEqualsDirectors() {
        val big = RTMPMessage(
            1,
            RTMPMessageType.VIDEO,
            1_234,
            FLVTag.videoFrame(RTMPVideoCodec.HEVC, true, ByteArray(300) { (it % 256).toByte() })
        )
        assertFixture("video-chunked-128", RTMPChunk.encode(big, 6, 128))
        val audio = RTMPMessage(
            1,
            RTMPMessageType.AUDIO,
            0x00FF_FFFFL + 5,
            FLVTag.audio(1, ByteArray(10) { 0x5A })
        )
        assertFixture("audio-extended-timestamp", RTMPChunk.encode(audio, 5, 4096))
    }

    @Test
    fun theRecordTakesParameterSetsInAnyOrder() {
        val record = HEVCDecoderConfiguration.record(listOf(pps, sps, vps))!!
        assertArrayEquals(record, HEVCDecoderConfiguration.record(listOf(vps, sps, pps)))
        assertEquals(1920 to 1080, HEVCDecoderConfiguration.pictureSize(sps))
    }
}
