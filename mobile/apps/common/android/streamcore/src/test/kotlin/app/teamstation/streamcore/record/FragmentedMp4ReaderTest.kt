package app.teamstation.streamcore.record

import app.teamstation.streamcore.record.FragmentedMp4WriterTest.Companion.writeFixture
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * The reader on parts a phone records for half an hour or more: larger than the heap, with samples
 * past 2 GB, read from disk box by box. The parts are made sparse: a real recording's fragments, with
 * a `free` box of the size wanted between them that takes no room on disk.
 */
class FragmentedMp4ReaderTest {
    @get:Rule
    val folder = TemporaryFolder()

    private class TopBox(val type: String, val start: Long, val size: Long)

    private fun topBoxes(file: File): List<TopBox> = RandomAccessFile(file, "r").use { handle ->
        val boxes = mutableListOf<TopBox>()
        var at = 0L
        while (at + 8 <= handle.length()) {
            handle.seek(at)
            val size = handle.readInt().toLong() and 0xFFFFFFFFL
            val type = ByteArray(4).also { handle.readFully(it) }.toString(Charsets.US_ASCII)
            boxes += TopBox(type, at, size)
            at += size
        }
        boxes
    }

    private fun bytes(file: File, from: Long, to: Long): ByteArray = RandomAccessFile(file, "r").use { handle ->
        ByteArray((to - from).toInt()).also {
            handle.seek(from)
            handle.readFully(it)
        }
    }

    /**
     * A 14 s recording (five fragments) with [gap] bytes of `free` box after its second fragment, so
     * the last three fragments sit [gap] bytes further on. [largeSize] writes the box's size in the
     * 64-bit form.
     */
    private class Sparse(val source: File, val part: File, val cut: Long, val gap: Long)

    private fun sparsePart(name: String, gap: Long, largeSize: Boolean = false): Sparse {
        val source = folder.newFile("source-$name")
        writeFixture(source, seconds = 14).finish(1.0 / 30)
        val boxes = topBoxes(source)
        val cut = boxes.filter { it.type == "mdat" }[1].let { it.start + it.size }
        val part = folder.newFile(name)
        RandomAccessFile(part, "rw").use { out ->
            out.write(bytes(source, 0, cut))
            if (largeSize) {
                out.writeInt(1)
                out.write("free".toByteArray(Charsets.US_ASCII))
                out.writeLong(gap)
            } else {
                out.writeInt(gap.toInt())
                out.write("free".toByteArray(Charsets.US_ASCII))
            }
            // Nothing is written inside the box, so the file system leaves it as a hole.
            out.seek(cut + gap)
            out.write(bytes(source, cut, source.length()))
        }
        assertEquals(source.length() + gap, part.length())
        return Sparse(source, part, cut, gap)
    }

    private fun assertSameSamples(sparse: Sparse) {
        val expected = FragmentedMp4Reader.read(sparse.source)!!
        val reader = FragmentedMp4Reader.read(sparse.part)!!
        assertTrue(reader.complete)
        assertEquals(5, reader.fragments)
        for ((want, got) in listOf(expected.video!! to reader.video!!, expected.audio!! to reader.audio!!)) {
            assertEquals(want.samples.size, got.samples.size)
            reader.samples().use { source ->
                expected.samples().use { original ->
                    want.samples.zip(got.samples).forEach { (a, b) ->
                        assertEquals(a.ticks, b.ticks)
                        assertEquals(a.duration, b.duration)
                        assertEquals(a.sync, b.sync)
                        // Samples after the gap are found where they now are.
                        assertEquals(if (a.offset < sparse.cut) a.offset else a.offset + sparse.gap, b.offset)
                        assertArrayEquals(original.read(a), source.read(b))
                    }
                }
            }
        }
    }

    @Test
    fun aPartLargerThanTheHeapIsReadFromDisk() {
        // Larger than everything the test JVM may allocate: reading it whole cannot succeed.
        val gap = Runtime.getRuntime().maxMemory() + 64L * 1024 * 1024
        val sparse = sparsePart("program-20261012-100000.mp4", gap, largeSize = gap > 0xFFFFFFFFL)
        val source = sparse.source
        val part = sparse.part
        assertTrue(part.length() > Runtime.getRuntime().maxMemory())
        // Which is how the reader once read it, and failed.
        assertTrue(runCatching { part.readBytes() }.exceptionOrNull() is OutOfMemoryError)
        assertSameSamples(sparse)

        // The export reads it too, a sample at a time: rebuilt (a resumed take), every picture and
        // packet lands in a file the size of the media.
        val anchors = (0 until 4).map { RecordingCatalog.ProgramAnchor(1, it * 3.0, 1_000.0 + it * 3.0) }
        val reading = ProgrammeExport.read(part)!!
        assertTrue(reading.completed)
        assertEquals(14.0, reading.lastPictureEnd, 1e-6)
        val output = File(folder.root, "export.mp4")
        val result = ProgrammeExport.export(listOf(part), anchors, 1, 1_000.0, 1_014.0, 30, byteArrayOf(0x21, 0x10), output)
        assertEquals("reencode: resumed 1 time", result.plan.description)
        assertTrue(output.length() < source.length() * 2)
        val exported = FragmentedMp4Reader.read(output)!!
        val original = FragmentedMp4Reader.read(source)!!
        assertEquals(original.video!!.samples.size, exported.video!!.samples.size)
        assertArrayEquals(original.read(original.video!!.samples.last()), exported.read(exported.video!!.samples.last()))
        assertArrayEquals(original.read(original.audio!!.samples[400]), exported.read(exported.audio!!.samples[400]))
    }

    @Test
    fun samplesPastTwoGigabytesKeepTheirOffsets() {
        val gap = 3L * 1024 * 1024 * 1024
        val sparse = sparsePart("program-20261012-110000.mp4", gap, largeSize = true)
        assertSameSamples(sparse)
        val reader = FragmentedMp4Reader.read(sparse.part)!!
        val last = reader.video!!.samples.last()
        assertTrue(last.offset > Int.MAX_VALUE)
        // The 32-bit size form reaches 4 GB too.
        val plain = sparsePart("program-20261012-120000.mp4", gap, largeSize = false)
        assertTrue(FragmentedMp4Reader.read(plain.part)!!.video!!.samples.last().offset > Int.MAX_VALUE)
    }

    @Test
    fun whatDoesNotHoldTogetherEndsTheReadingOrIsNotAnMp4() {
        val file = folder.newFile("fixture.mp4")
        writeFixture(file).finish()
        val boxes = topBoxes(file)
        val moof = boxes.last { it.type == "moof" }

        // A sample larger than any picture: the reading stops before its fragment.
        val huge = folder.newFile("huge-sample.mp4")
        file.copyTo(huge, overwrite = true)
        RandomAccessFile(huge, "rw").use { handle ->
            // The first trun entry's size: mfhd (16) + traf header (8) + tfhd (16) + tfdt (20) + trun
            // header (8) + version/flags, count, offset (12) + the first duration (4).
            handle.seek(moof.start + 8 + 16 + 8 + 16 + 20 + 8 + 12 + 4)
            handle.writeInt(0x7FFFFFFF)
        }
        FragmentedMp4Reader.read(huge)!!.let {
            assertFalse(it.complete)
            assertEquals(2, it.fragments)
        }

        // A moof whose own fields run outside it ends the reading the same way.
        val short = folder.newFile("short-moof.mp4")
        file.copyTo(short, overwrite = true)
        RandomAccessFile(short, "rw").use { handle ->
            // The trun claims a million samples, more than the moof holds.
            handle.seek(moof.start + 8 + 16 + 8 + 16 + 20 + 8 + 4)
            handle.writeInt(1_000_000)
        }
        FragmentedMp4Reader.read(short)!!.let {
            assertFalse(it.complete)
            assertEquals(2, it.fragments)
        }

        // A moov larger than any a recorder writes is not believed.
        val bigMoov = folder.newFile("big-moov.mp4")
        RandomAccessFile(bigMoov, "rw").use { handle ->
            handle.writeInt(FragmentedMp4Reader.MaxDescriptionBytes.toInt() + 16)
            handle.write("moov".toByteArray(Charsets.US_ASCII))
            handle.setLength(FragmentedMp4Reader.MaxDescriptionBytes + 16)
        }
        assertNull(FragmentedMp4Reader.read(bigMoov))
    }

    @Test
    fun aFileThatCannotBeReadSaysWhich() {
        val file = folder.newFile("program-20261012-130000.mp4")
        writeFixture(file).finish()
        assertTrue(file.setReadable(false))
        try {
            val error = runCatching { FragmentedMp4Reader.read(file) }.exceptionOrNull()
            assertTrue(error is IOException)
            assertTrue(error!!.message!!, error.message!!.startsWith("could not read program-20261012-130000.mp4"))
        } finally {
            file.setReadable(true)
        }
    }
}
