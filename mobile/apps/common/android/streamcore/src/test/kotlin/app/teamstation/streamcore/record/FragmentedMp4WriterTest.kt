package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.hex
import app.teamstation.streamcore.rtmp.FLVTag
import app.teamstation.streamcore.rtmp.HEVCDecoderConfiguration
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

/**
 * The fragmented MP4 the recording is written as: its box layout, equal byte for byte to the
 * reference in the test resources; its samples read back; a fragment every 3 s; and a file cut off
 * mid-fragment keeping every fragment before the cut.
 */
class FragmentedMp4WriterTest {
    @get:Rule
    val folder = TemporaryFolder()

    companion object {
        val vps = bytes(
            0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03,
            0x00, 0x00, 0x03, 0x00, 0x78, 0x17, 0x02, 0x40
        )
        val sps = bytes(
            0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03,
            0x00, 0x78, 0xA0, 0x03, 0xC0, 0x80, 0x11, 0x07, 0xCB, 0x88, 0x17, 0xB9, 0x16, 0x45, 0x2F, 0xFC,
            0xB9, 0xFC, 0x4F, 0xE8, 0x80
        )
        val pps = bytes(0x44, 0x01, 0xC0, 0x72, 0xF0, 0x53, 0x24)

        fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

        val videoTrack = FragmentedMp4Writer.VideoTrack(StreamCodec.HEVC, 1920, 1080, HEVCDecoderConfiguration.record(listOf(vps, sps, pps))!!)
        val audioTrack = FragmentedMp4Writer.AudioTrack(bytes(0x11, 0x90))

        /** Seven seconds: a picture every 1/30 s, a keyframe every 2 s, and the AAC packets beside it. */
        fun writeFixture(file: File, seconds: Int = 7): FragmentedMp4Writer {
            val writer = FragmentedMp4Writer(file, videoTrack, audioTrack)
            var packets = 0
            for (frame in 0 until seconds * 30) {
                val key = frame % 60 == 0
                val unit = if (key) bytes(0x26, 0x01, frame and 0xFF) else bytes(0x02, 0x01, frame and 0xFF, 0x55)
                assertTrue(writer.writeVideo(byteArrayOf(0, 0, 0, unit.size.toByte()) + unit, frame / 30.0, key))
                while (packets * 1024.0 / 48_000 < (frame + 1) / 30.0) {
                    writer.writeAudio(bytes(0x21, packets and 0xFF, 0x0A))
                    packets += 1
                }
            }
            return writer
        }

        /** Every box's type, nested ones indented, from an independent walk of the bytes. */
        fun layout(bytes: ByteArray): List<String> {
            val containers = setOf("moov", "trak", "mdia", "minf", "stbl", "dinf", "mvex", "moof", "traf", "edts")
            val out = mutableListOf<String>()
            fun walk(from: Int, to: Int, depth: Int) {
                var at = from
                while (at + 8 <= to) {
                    val size = ((bytes[at].toLong() and 0xFF) shl 24 or ((bytes[at + 1].toLong() and 0xFF) shl 16) or
                        ((bytes[at + 2].toLong() and 0xFF) shl 8) or (bytes[at + 3].toLong() and 0xFF)).toInt()
                    val type = String(bytes, at + 4, 4, Charsets.US_ASCII)
                    out += "  ".repeat(depth) + "$type $size"
                    if (type in containers) walk(at + 8, at + size, depth + 1)
                    if (type == "stsd") walk(at + 16, at + size, depth + 1)
                    at += size
                }
            }
            walk(0, bytes.size, 0)
            return out
        }
    }

    @Test
    fun theLayoutMatchesTheReferenceByteForByte() {
        val file = folder.newFile("fixture.mp4")
        writeFixture(file).finish(1.0 / 30)
        val written = file.readBytes()
        // The reference lives with the tests; a first run with none writes it, to be reviewed and kept.
        val reference = File("src/test/resources/record/reference-fragmented.mp4")
        if (!reference.exists()) {
            reference.parentFile.mkdirs()
            reference.writeBytes(written)
            error("wrote ${reference.path}; review and commit it")
        }
        assertEquals(reference.readBytes().hex(), written.hex())

        val boxes = layout(written)
        assertEquals(
            listOf(
                "ftyp 28", "moov", "  mvhd 108", "  trak", "    tkhd 92", "    mdia", "      mdhd 32", "      hdlr 45",
                "      minf", "        vmhd 20", "        dinf 36", "          dref 28", "        stbl", "          stsd",
                "            hvc1", "          stts 16", "          stsc 16", "          stsz 20", "          stco 16",
                "  trak", "    tkhd 92", "    mdia", "      mdhd 32", "      hdlr 45", "      minf", "        smhd 16",
                "        dinf 36", "          dref 28", "        stbl", "          stsd", "            mp4a", "          stts 16",
                "          stsc 16", "          stsz 20", "          stco 16", "  mvex 72"
            ),
            boxes.take(36).map { line -> if (line.trim().split(" ")[0] in setOf("moov", "trak", "mdia", "minf", "stbl", "stsd", "hvc1", "mp4a")) line.substringBeforeLast(' ') else line }
        )
        // Three fragments: 0–3 s, 3–6 s and the last second, each a moof with both tracks and its mdat.
        assertEquals(3, boxes.count { it.startsWith("moof") })
        assertEquals(3, boxes.count { it.startsWith("mdat") })
        assertEquals(6, boxes.count { it.trim().startsWith("traf") })
    }

    @Test
    fun theSamplesReadBack() {
        val file = folder.newFile("readback.mp4")
        val writer = writeFixture(file)
        writer.finish(1.5)
        assertEquals(210, writer.videoSamples)
        val reader = FragmentedMp4Reader.read(file)!!
        assertTrue(reader.complete)
        assertEquals(3, reader.fragments)
        val video = reader.video!!
        assertEquals("hvc1", video.sampleEntry)
        assertEquals(1920, video.width)
        assertEquals(1080, video.height)
        assertEquals(90_000, video.timescale)
        assertArrayEquals(videoTrack.decoderConfiguration, video.configuration)
        assertEquals(210, video.samples.size)
        assertEquals(0.0, video.firstSeconds!!, 0.0)
        // The last picture lasts the 1.5 s it was given.
        assertEquals(209 / 30.0 + 1.5, video.endSeconds!!, 1e-6)
        assertEquals(4, video.samples.count { it.sync })
        assertArrayEquals(bytes(0, 0, 0, 4, 0x02, 0x01, 1, 0x55), reader.read(video.samples[1]))
        val audio = reader.audio!!
        assertEquals("mp4a", audio.sampleEntry)
        assertEquals(2, audio.channels)
        assertArrayEquals(bytes(0x11, 0x90), audio.configuration)
        assertEquals(writer.audioSamples, audio.samples.size)
        assertEquals(audio.samples.size * 1024.0 / 48_000, audio.endSeconds!!, 1e-9)
        assertEquals(audio.endSeconds!!, writer.audioEndSeconds, 1e-9)
        assertEquals(0L, audio.mediaTime)
    }

    @Test
    fun aFileCutOffMidFragmentKeepsEveryCompleteFragment() {
        val file = folder.newFile("cut.mp4")
        writeFixture(file).finish()
        val whole = FragmentedMp4Reader.read(file)!!
        val lastMoof = run {
            val bytes = file.readBytes()
            var at = 0
            var last = 0
            while (at + 8 <= bytes.size) {
                val size = ((bytes[at].toInt() and 0xFF) shl 24) or ((bytes[at + 1].toInt() and 0xFF) shl 16) or
                    ((bytes[at + 2].toInt() and 0xFF) shl 8) or (bytes[at + 3].toInt() and 0xFF)
                if (String(bytes, at + 4, 4, Charsets.US_ASCII) == "moof") last = at
                at += size
            }
            last
        }
        // Cut inside the last fragment's mdat, and again inside its moof.
        for (cut in listOf(file.length() - 10, lastMoof + 20L)) {
            val copy = folder.newFile("cut-$cut.mp4")
            file.copyTo(copy, overwrite = true)
            RandomAccessFile(copy, "rw").use { it.setLength(cut) }
            val reader = FragmentedMp4Reader.read(copy)!!
            assertFalse(reader.complete)
            assertEquals(whole.fragments - 1, reader.fragments)
            val kept = whole.video!!.samples.size - reader.video!!.samples.size
            assertEquals("the last fragment's 30 pictures go", 30, kept)
            assertEquals(6.0, reader.video!!.endSeconds!!, 1e-9)
        }
    }

    @Test
    fun anAudioOnlyFileFragmentsOnSoundAndAnH264TrackIsAvc1() {
        val file = folder.newFile("audio.mp4")
        val writer = FragmentedMp4Writer(file, null, FragmentedMp4Writer.AudioTrack(bytes(0x11, 0x90), primingSamples = 2048))
        repeat(300) { writer.writeAudio(bytes(1, 2, 3)) }
        assertFalse(writer.writeVideo(bytes(1), 0.0, true))
        writer.finish()
        writer.finish()
        val reader = FragmentedMp4Reader.read(file)!!
        assertNull(reader.video)
        assertEquals(300, reader.audio!!.samples.size)
        assertEquals(2048L, reader.audio!!.mediaTime)
        assertEquals(3, reader.fragments)

        val avc = folder.newFile("avc.mp4")
        val record = FLVTag.avcDecoderConfigurationRecord(bytes(0x67, 0x42, 0, 0x1F), bytes(0x68, 0xCE))
        val h264 = FragmentedMp4Writer(avc, FragmentedMp4Writer.VideoTrack(StreamCodec.H264, 640, 360, record, bt709 = false), null)
        assertTrue(h264.writeVideo(bytes(0, 0, 0, 1, 0x65), 0.0, true))
        assertFalse(h264.writeVideo(bytes(0, 0, 0, 1, 0x41), 0.0, false))
        h264.writeAudio(bytes(1))
        h264.finish()
        val read = FragmentedMp4Reader.read(avc)!!
        assertEquals("avc1", read.video!!.sampleEntry)
        assertArrayEquals(record, read.video!!.configuration)
        assertEquals(1.0 / 30, read.video!!.endSeconds!!, 1e-4)
        val abandoned = FragmentedMp4Writer(folder.newFile("abandoned.mp4"), videoTrack, audioTrack)
        abandoned.writeVideo(bytes(0, 0, 0, 1, 0x26), 0.0, true)
        abandoned.abandon()
        abandoned.abandon()
        assertEquals(0, FragmentedMp4Reader.read(abandoned.file)!!.fragments)
        assertNull(FragmentedMp4Reader.read(folder.newFile("empty.mp4")))
        assertNull(FragmentedMp4Reader.read(File(folder.root, "missing.mp4")))
    }

    @Test
    fun soundWithoutPicturesIsCutByItsOwnLengthAndTheForceCanWaitForTheOwner() {
        // One picture, then twenty seconds of sound and no picture: the sound is not held whole for a
        // fragment the pictures never cut, but cut every two fragments' length.
        val file = folder.newFile("soundOnly.mp4")
        val writer = FragmentedMp4Writer(file, videoTrack, audioTrack, syncEachFragment = false)
        assertTrue(writer.syncPending())
        assertTrue(writer.writeVideo(bytes(0, 0, 0, 1, 0x26), 0.0, true))
        val packets = (20 * 48_000) / 1024
        repeat(packets) { writer.writeAudio(bytes(0x21, it and 0xFF)) }
        // The fragments went to the file, and the force waits for the owner to ask for it.
        assertTrue(writer.audioSamples > packets - 282)
        assertTrue(writer.peakQueuedSamples <= 282)
        assertTrue(writer.hasPendingSync)
        assertTrue(writer.syncPending())
        assertFalse(writer.hasPendingSync)
        writer.finish(20.0)
        assertTrue(writer.syncPending())
        val reader = FragmentedMp4Reader.read(file)!!
        assertTrue(reader.complete)
        assertEquals(packets, reader.audio!!.samples.size)
        assertEquals(1, reader.video!!.samples.size)
        assertEquals(20.0, reader.video!!.endSeconds!!, 1e-6)
        assertTrue(reader.fragments >= 3)
    }

    @Test
    fun aForceTheStorageRefusesSaysSoAndAClosedFileHasNothingToForce() {
        val file = folder.newFile("refused.mp4")
        var refuse = true
        val writer = FragmentedMp4Writer(file, videoTrack, audioTrack, syncEachFragment = false, forceToStorage = {
            if (refuse) throw java.io.SyncFailedException("sync failed")
        })
        repeat(4) { writer.writeVideo(bytes(0, 0, 0, 1, if (it == 0) 0x26 else 0x02), it * 1.5, it == 0) }
        assertTrue(writer.hasPendingSync)
        assertFalse(writer.syncPending())
        // Not forced, so still pending.
        assertTrue(writer.hasPendingSync)
        refuse = false
        assertTrue(writer.syncPending())
        assertFalse(writer.hasPendingSync)
        // Closed meanwhile: its owner forced it as it finished, or let it go.
        repeat(3) { writer.writeVideo(bytes(0, 0, 0, 1, 0x02), 6.0 + it * 1.5, false) }
        assertTrue(writer.hasPendingSync)
        writer.abandon()
        refuse = true
        assertTrue(writer.syncPending())
    }

    @Test
    fun aFrameOfJitterIsHeldOutAndAHoleKeepsOneFrame() {
        val file = folder.newFile("jitter.mp4")
        val writer = FragmentedMp4Writer(file, videoTrack, null)
        val frame = 1.0 / 30
        writer.writeVideo(bytes(0, 0, 0, 1, 0x26), 0.0, true, frame)
        writer.writeVideo(bytes(0, 0, 0, 1, 0x02), frame + 0.001, false, frame)
        writer.writeVideo(bytes(0, 0, 0, 1, 0x02), frame + 0.001 + 30.0, false, frame)
        writer.finish()
        val video = FragmentedMp4Reader.read(file)!!.video!!
        val first = video.samples[0]
        assertEquals(frame + 0.001, first.duration.toDouble() / video.timescale, 1e-4)
        val across = video.samples[1]
        assertEquals(frame, across.duration.toDouble() / video.timescale, 1e-4)
        // The jitter stayed in the first fragment. A flush per picture would be three.
        assertEquals(2, FragmentedMp4Reader.read(file)!!.fragments)
    }
}
