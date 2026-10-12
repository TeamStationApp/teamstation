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

    /** A part of [seconds] at 30 fps with its sound, as the recording writes it. */
    private fun part(name: String, seconds: Int): File {
        val file = folder.newFile(name)
        val writer = FragmentedMp4Writer(file, FragmentedMp4WriterTest.videoTrack, FragmentedMp4WriterTest.audioTrack)
        var packets = 0
        for (frame in 0 until seconds * 30) {
            writer.writeVideo(byteArrayOf(0, 0, 0, 3, 0x26, 1, frame.toByte()), frame / 30.0, frame % 60 == 0)
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

    @Test
    fun aPartWithNoAnchorsIsLeftOutAndNoneIsAnError() {
        val first = part("program-20261012-100000.mp4", 2)
        val output = File(folder.root, "none.mp4")
        assertTrue(runCatching {
            ProgrammeExport.export(listOf(first, part("program-20261012-100000-2.mp4", 2)), emptyList(), 0, 1_000.0, null, 30, silent, output)
        }.isFailure)
        // Overlapping parts: the second's samples before the first's end are left out.
        val anchors = anchors(count = 1) + anchors(part = 2, start = 1_001.0, count = 1)
        val placed = File(folder.root, "overlap.mp4")
        ProgrammeExport.export(listOf(first, File(folder.root, "program-20261012-100000-2.mp4")), anchors, 0, 1_000.0, null, 30, silent, placed)
        val reader = FragmentedMp4Reader.read(placed)!!
        assertEquals(60 + 30, reader.video!!.samples.size)
        // With no end to the take, both run to where the last part's media ends: its sound, half a
        // packet past its picture.
        assertEquals(reader.audio!!.endSeconds!!, reader.video!!.endSeconds!!, 1e-4)
        assertEquals(3.0, reader.audio!!.endSeconds!!, 1024.0 / 48_000)
    }
}
