package app.teamstation.streamcore.record

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

/** The export's plan, every reason it gives, and the copy and the placed rebuild it writes. */
class ProgrammeExportTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val reading = ProgrammeExport.PartReading(0.0, 600.0, 600.0, true)
    private fun anchors(part: Int = 1, start: Double = 1_000.0, count: Int = 10, spread: Double = 0.0) =
        (0 until count).map { RecordingCatalog.ProgramAnchor(part, it * 3.0, start + it * 3.0 + (if (it % 2 == 0) 0.0 else spread)) }

    private fun plan(
        parts: Int = 1,
        resumes: Int = 0,
        anchors: List<RecordingCatalog.ProgramAnchor> = anchors(),
        reading: ProgrammeExport.PartReading? = this.reading,
        start: Double = 1_000.0,
        end: Double? = 1_600.0
    ) = ProgrammeExport.plan(parts, resumes, anchors, reading, start, end, 30).description

    @Test
    fun everyDoubtSendsItToARebuild() {
        assertEquals("copy from 1000.000000", plan())
        assertEquals("copy from 1000.000000", plan(end = null))
        assertEquals("reencode: 2 programme parts", plan(parts = 2))
        assertEquals("reencode: resumed 1 time", plan(resumes = 1))
        assertEquals("reencode: resumed 3 times", plan(resumes = 3))
        assertEquals("reencode: anchors for part 2", plan(anchors = anchors() + anchors(part = 2)))
        assertEquals("reencode: no anchors", plan(anchors = emptyList()))
        assertEquals("reencode: anchors disagree by 1.000 s", plan(anchors = anchors(spread = 1.0)))
        assertEquals("reencode: part does not read to its end", plan(reading = null))
        assertEquals("reencode: part does not read to its end", plan(reading = reading.copy(completed = false)))
        assertEquals("reencode: part does not read to its end", plan(reading = reading.copy(lastPictureEnd = 590.0)))
        assertEquals("reencode: part starts 0.500 s late", plan(start = 999.5))
        assertEquals("reencode: part ends 2.000 s early", plan(end = 1_602.0))
        assertEquals(2, ProgrammeExport.partNumber(File("program-20261012-100000-2.mp4")))
        assertEquals(1, ProgrammeExport.partNumber(File("program-20261012-100000.mp4")))
        assertNull(ProgrammeExport.partNumber(File("clip.mp4")))
    }

    private val silent = byteArrayOf(0x21, 0x10, 0x04, 0x60, 0x8C.toByte(), 0x1C)

    /**
     * A part of [seconds] at 30 fps with its sound, as the recording writes it: with [priming], the
     * encoder's priming packets come first and the edit list skips them, so the first real sample
     * plays with the first picture.
     */
    private fun part(
        name: String,
        seconds: Int,
        priming: Int = 0,
        keyframeEvery: Int = 60,
        video: FragmentedMp4Writer.VideoTrack = FragmentedMp4WriterTest.videoTrack
    ): File {
        val file = folder.newFile(name)
        val audio = FragmentedMp4Writer.AudioTrack(byteArrayOf(0x11, 0x90.toByte()), primingSamples = priming)
        val writer = FragmentedMp4Writer(file, video, if (priming == 0) FragmentedMp4WriterTest.audioTrack else audio)
        repeat(priming / 1024) { writer.writeAudio(primingPacket) }
        var packets = 0
        for (frame in 0 until seconds * 30) {
            writer.writeVideo(byteArrayOf(0, 0, 0, 3, 0x26, 1, frame.toByte()), frame / 30.0, frame % keyframeEvery == 0)
            while (packets * 1024.0 / 48_000 < (frame + 1) / 30.0) {
                writer.writeAudio(byteArrayOf(0x21, 0x55))
                packets += 1
            }
        }
        writer.finish()
        return file
    }

    @Test
    fun anUnbrokenTakeIsCopiedAsItIs() {
        val file = part("program-20261012-100000.mp4", 10)
        val reading = ProgrammeExport.read(file)!!
        assertEquals(ProgrammeExport.PartReading(0.0, 10.0, 10.0, true), reading)
        val output = File(folder.root, "out/copy.mp4")
        val result = ProgrammeExport.export(listOf(file), anchors(count = 4), 0, 1_000.0, 1_010.0, 30, silent, output)
        assertTrue(result.plan is ProgrammeExport.Plan.Copy)
        assertArrayEquals(file.readBytes(), output.readBytes())
        assertNull(ProgrammeExport.read(folder.newFile("nothing.mp4")))
        RandomAccessFile(file, "rw").use { it.setLength(file.length() - 5) }
        assertFalse(ProgrammeExport.read(file)!!.completed)
    }

    @Test
    fun partsArePlacedByTheirWallStartWithTheHoleHeldAndSilent() {
        val first = part("program-20261012-100000.mp4", 10)
        val second = part("program-20261012-100000-2.mp4", 10)
        val anchors = anchors(count = 4) + anchors(part = 2, start = 1_020.0, count = 4)
        val output = File(folder.root, "placed.mp4")
        val result = ProgrammeExport.export(listOf(first, second, File(folder.root, "gone.mp4")), anchors, 1, 1_000.0, 1_030.0, 30, silent, output)
        assertEquals("reencode: 2 programme parts", result.plan.description)
        val reader = FragmentedMp4Reader.read(output)!!
        val video = reader.video!!
        assertEquals(600, video.samples.size)
        // The last picture before the hole lasts until the first after it.
        val held = video.samples[299]
        assertEquals((20.0 - 299 / 30.0) * 90_000, held.duration.toDouble(), 1.0)
        assertEquals(20.0, video.samples[300].ticks / 90_000.0, 1e-6)
        assertEquals(30.0, video.endSeconds!!, 1e-6)
        val audio = reader.audio!!
        assertEquals(30.0, audio.endSeconds!!, 1024.0 / 48_000)
        // Every packet between the parts is silence, and there are as many as the hole needs.
        val inHole = audio.samples.filter { it.ticks / 48_000.0 in 10.1..19.9 }
        assertTrue(inHole.isNotEmpty())
        assertTrue(inHole.all { reader.read(it).contentEquals(silent) })
        val partTwo = audio.samples.filter { it.ticks / 48_000.0 in 20.05..29.9 }
        assertTrue(partTwo.none { reader.read(it).contentEquals(silent) })
    }

    private val primingPacket = byteArrayOf(0x21, 0x77)

    @Test
    fun partsThatStartAfterTheTakeKeepEachPartsSoundWithItsPicture() {
        // Each part's first picture came 0.24 s after it was asked for (the camera starting), and the
        // AAC encoder primes with two packets: the picture track starts 0.24 s in, after the take's
        // silence, and each part's first real sound plays with its first picture.
        val first = part("program-20261012-100000.mp4", 10, priming = 2048)
        val second = part("program-20261012-100000-2.mp4", 10, priming = 2048)
        val anchors = anchors(start = 1_000.24, count = 4) + anchors(part = 2, start = 1_020.24, count = 4)
        val output = File(folder.root, "late.mp4")
        ProgrammeExport.export(listOf(first, second), anchors, 1, 1_000.0, 1_030.24, 30, silent, output)
        val reader = FragmentedMp4Reader.read(output)!!
        val video = reader.video!!
        assertEquals(0.24, video.samples.first().ticks / 90_000.0, 1e-4)
        assertEquals(20.24, video.samples[300].ticks / 90_000.0, 1e-4)
        val audio = reader.audio!!
        // The output skips the first part's priming as the part did.
        assertEquals(2048L, audio.mediaTime)
        val playsAt = { ticks: Long -> (ticks - audio.mediaTime) / 48_000.0 }
        val real = audio.samples.filter { reader.read(it).contentEquals(byteArrayOf(0x21, 0x55)) }
        val packet = 1024.0 / 48_000
        assertEquals(0.24, playsAt(real.first().ticks), packet)
        assertEquals(20.24, playsAt(real.first { playsAt(it.ticks) > 15 }.ticks), packet)
        // Before the first part only silence and its priming; the second part's priming is in the hole.
        assertTrue(audio.samples.takeWhile { it !== real.first() }.all { sample ->
            reader.read(sample).let { it.contentEquals(silent) || it.contentEquals(primingPacket) }
        })
    }

    @Test
    fun aPartThatOpensBeforeTheTakeKeepsItsSoundAndPictureUnderOneHead() {
        // A phone's part opens on a picture captured a picture delay (0.15 s) before Record, so its
        // timeline starts before the take's. Rebuilt, the output starts where that part does, with
        // the picture and the part's first real sound both at 0: a reader that ignores the edit list
        // (the server's remux) finds them starting together, and no sample is written before 0.
        val first = part("program-20261012-100000.mp4", 10, priming = 2048)
        val second = part("program-20261012-100000-2.mp4", 10, priming = 2048)
        val anchors = anchors(start = 999.85, count = 4) + anchors(part = 2, start = 1_019.85, count = 4)
        val output = File(folder.root, "early.mp4")
        ProgrammeExport.export(listOf(first, second), anchors, 1, 1_000.0, 1_030.0, 30, silent, output)
        val reader = FragmentedMp4Reader.read(output)!!
        val video = reader.video!!
        assertEquals(0.0, video.samples.first().ticks / 90_000.0, 1e-6)
        assertEquals(20.0, video.samples[300].ticks / 90_000.0, 1e-4)
        val audio = reader.audio!!
        assertEquals(2048L, audio.mediaTime)
        val playsAt = { ticks: Long -> (ticks - audio.mediaTime) / 48_000.0 }
        val real = audio.samples.filter { reader.read(it).contentEquals(byteArrayOf(0x21, 0x55)) }
        val packet = 1024.0 / 48_000
        assertEquals(0.0, playsAt(real.first().ticks), packet / 2)
        assertEquals(20.0, playsAt(real.first { playsAt(it.ticks) > 15 }.ticks), packet)
        // Both run to the take's end, counted from that head.
        assertEquals(30.15, video.endSeconds!!, 1e-4)
        assertEquals(30.15, playsAt(audio.samples.last().ticks + audio.samples.last().duration), packet)
    }

    @Test
    fun aPartWithNoAnchorsIsLeftOutAndNoneIsAnError() {
        val first = part("program-20261012-100000.mp4", 2)
        val output = File(folder.root, "none.mp4")
        assertTrue(runCatching {
            ProgrammeExport.export(listOf(first, part("program-20261012-100000-2.mp4", 2)), emptyList(), 0, 1_000.0, null, 30, silent, output)
        }.isFailure)
        // Overlapping parts: the second's samples before the first's end are left out, and so is
        // everything up to its next keyframe, which here it never has: its pictures after the overlap
        // depend on the keyframe that was left out.
        val anchors = anchors(count = 1) + anchors(part = 2, start = 1_001.0, count = 1)
        val placed = File(folder.root, "overlap.mp4")
        ProgrammeExport.export(listOf(first, File(folder.root, "program-20261012-100000-2.mp4")), anchors, 0, 1_000.0, null, 30, silent, placed)
        val reader = FragmentedMp4Reader.read(placed)!!
        assertEquals(60, reader.video!!.samples.size)
        // With no end to the take, both run to where the last part's media ends: its sound, half a
        // packet past its picture.
        assertEquals(reader.audio!!.endSeconds!!, reader.video!!.endSeconds!!, 1e-4)
        assertEquals(3.0, reader.audio!!.endSeconds!!, 1024.0 / 48_000)
    }

    @Test
    fun anOverlappingPartStartsAtItsFirstKeyframeAfterTheOverlap() {
        // Part 2 opens half a second before part 1's last picture, with a keyframe every second: its
        // opening keyframe is in the overlap, so it starts at its next one, never on a picture that
        // depends on one left out.
        val first = part("program-20261012-100000.mp4", 4, keyframeEvery = 30)
        val second = part("program-20261012-100000-2.mp4", 4, keyframeEvery = 30)
        val anchors = anchors(count = 1) + anchors(part = 2, start = 1_003.5, count = 1)
        val output = File(folder.root, "keyframe.mp4")
        ProgrammeExport.export(listOf(first, second), anchors, 1, 1_000.0, 1_007.5, 30, silent, output)
        val video = FragmentedMp4Reader.read(output)!!.video!!
        val partTwo = video.samples.drop(120)
        assertTrue(partTwo.first().sync)
        assertEquals(4.5, partTwo.first().ticks / 90_000.0, 1e-6)
        assertEquals(120 + 90, video.samples.size)
        // Part 1's last picture lasts until part 2's keyframe.
        assertEquals(4.5, (video.samples[119].ticks + video.samples[119].duration) / 90_000.0, 1e-6)
    }

    @Test
    fun partsWithDifferentPictureSettingsAreRefused() {
        val config = FragmentedMp4WriterTest.videoTrack.decoderConfiguration.copyOf().also { it[it.size - 1] = (it.last() + 1).toByte() }
        val first = part("program-20261012-100000.mp4", 2)
        val second = part("program-20261012-100000-2.mp4", 2, video = FragmentedMp4Writer.VideoTrack(app.teamstation.streamcore.core.StreamCodec.HEVC, 1920, 1080, config))
        val anchors = anchors(count = 1) + anchors(part = 2, start = 1_010.0, count = 1)
        val output = File(folder.root, "mismatched.mp4")
        val refused = runCatching { ProgrammeExport.export(listOf(first, second), anchors, 1, 1_000.0, 1_012.0, 30, silent, output) }
        assertTrue(refused.exceptionOrNull() is ProgrammeExport.MismatchedParts)
        assertTrue(refused.exceptionOrNull()!!.message!!.contains("program-20261012-100000-2.mp4"))
        assertFalse(output.exists())
    }

    @Test
    fun aLongPartIsRebuiltInterleavedAndHeldAFragmentAtATime() {
        // Twenty minutes in one part, rebuilt because the take was resumed: its pictures and sound go
        // out side by side, so the rebuild holds about one fragment of samples at a time. Written
        // pictures first, the part's whole sound sat in memory until the end.
        val minutes = 20
        val file = part("program-20261012-100000.mp4", minutes * 60)
        val output = File(folder.root, "long.mp4")
        val result = ProgrammeExport.export(listOf(file), anchors(count = 4), 1, 1_000.0, 1_000.0 + minutes * 60, 30, silent, output)
        assertEquals("reencode: resumed 1 time", result.plan.description)
        // A fragment is 3 s: 90 pictures and about 141 packets.
        assertTrue("held ${result.peakQueuedSamples} samples at once", result.peakQueuedSamples in 200..300)
        val reader = FragmentedMp4Reader.read(output)!!
        val video = reader.video!!
        val audio = reader.audio!!
        assertEquals(minutes * 60 * 30, video.samples.size)
        assertEquals(minutes * 60.0, audio.endSeconds!!, 1024.0 / 48_000)
        assertEquals(minutes * 60 / 3.0, reader.fragments.toDouble(), 2.0)
        // Interleaved on disk: a minute in, the sound sits before the pictures of a minute later.
        val soundAtOneMinute = audio.samples.first { it.ticks >= 60 * 48_000 }
        val pictureAtTwoMinutes = video.samples.first { it.ticks >= 120 * 90_000 }
        assertTrue(soundAtOneMinute.offset < pictureAtTwoMinutes.offset)
    }
}
