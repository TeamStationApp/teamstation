package app.teamstation.streamcore.record

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * Reads back a fragmented MP4 as [FragmentedMp4Writer] writes it, without decoding anything: the
 * tracks the `moov` describes, and every sample of every complete fragment. A fragment whose `moof`
 * or sample data runs past the end of the file, which is what a crash mid-write leaves, ends the
 * reading; everything before it is kept.
 *
 * It reads from disk as it goes, so a part of any length can be read on a phone's heap: the top
 * level is walked box header by box header, only a `moov` or a `moof` is held in memory, every
 * offset is a [Long], and a sample's bytes are read when they are asked for.
 *
 * It stands in for TS Director's AVAssetReader passes: the sound check at Stop reads the part back
 * this way, and the export reads its parts with it.
 */
class FragmentedMp4Reader private constructor(private val file: File) {
    enum class Kind { VIDEO, AUDIO, OTHER }

    class Sample(
        val offset: Long,
        val size: Int,
        /** Decode (and presentation) time in the track's timescale. */
        val ticks: Long,
        val duration: Long,
        val sync: Boolean
    )

    class Track(
        val id: Int,
        val kind: Kind,
        val timescale: Int,
        /** `hvc1`, `avc1` or `mp4a`. */
        val sampleEntry: String,
        /** `hvcC` or `avcC` for a picture track, the AudioSpecificConfig for a sound track. */
        val configuration: ByteArray?,
        val width: Int,
        val height: Int,
        val channels: Int,
        /** The edit list's media time: the priming a player skips. */
        val mediaTime: Long
    ) {
        val samples = mutableListOf<Sample>()

        /** Where the first sample starts and the last one ends, in seconds; null with no samples. */
        val firstSeconds: Double? get() = samples.firstOrNull()?.let { it.ticks.toDouble() / timescale }
        val endSeconds: Double? get() = samples.lastOrNull()?.let { (it.ticks + it.duration).toDouble() / timescale }
    }

    /** The file held open for reading one sample after another; close it when done. */
    class SampleSource internal constructor(private val handle: RandomAccessFile) : Closeable {
        fun read(sample: Sample): ByteArray = ByteArray(sample.size).also {
            handle.seek(sample.offset)
            handle.readFully(it)
        }

        override fun close() = handle.close()
    }

    val tracks = mutableListOf<Track>()

    /** Complete fragments read. */
    var fragments = 0
        private set

    /** Whether the reading reached the end of the file without a cut-off fragment. */
    var complete = true
        private set

    val video: Track? get() = tracks.firstOrNull { it.kind == Kind.VIDEO }
    val audio: Track? get() = tracks.firstOrNull { it.kind == Kind.AUDIO }

    /** One sample's bytes. To read many, use [samples]. */
    fun read(sample: Sample): ByteArray = samples().use { it.read(sample) }

    /** The file opened once for reading many samples. */
    fun samples(): SampleSource = SampleSource(RandomAccessFile(file, "r"))

    private class Box(val type: String, val start: Long, val headerSize: Int, val size: Long) {
        val bodyStart: Long get() = start + headerSize
        val end: Long get() = start + size
    }

    /** The file is not laid out as an MP4: a box runs outside its parent, or one is absurdly large. */
    private class Malformed(message: String) : Exception(message)

    /** One box's bytes held in memory, addressed by file offset. */
    private class Window(val origin: Long, val bytes: ByteArray) {
        val end: Long get() = origin + bytes.size

        fun index(at: Long, count: Int): Int {
            val index = at - origin
            if (index < 0 || index + count > bytes.size) throw Malformed("a field at $at runs outside its box")
            return index.toInt()
        }

        fun u8(at: Long): Int = bytes[index(at, 1)].toInt() and 0xFF

        fun u16(at: Long): Int {
            val index = index(at, 2)
            return ((bytes[index].toInt() and 0xFF) shl 8) or (bytes[index + 1].toInt() and 0xFF)
        }

        fun u32(at: Long): Long {
            val index = index(at, 4)
            var value = 0L
            for (offset in 0 until 4) value = (value shl 8) or (bytes[index + offset].toLong() and 0xFF)
            return value
        }

        fun u64(at: Long): Long = (u32(at) shl 32) or u32(at + 4)

        fun fourCC(at: Long): String = String(bytes, index(at, 4), 4, Charsets.US_ASCII)

        fun copy(from: Long, to: Long): ByteArray {
            val start = index(from, 0)
            return bytes.copyOfRange(start, index(to, 0))
        }
    }

    private fun parse() {
        RandomAccessFile(file, "r").use { handle ->
            val length = handle.length()
            var at = 0L
            var sawMoov = false
            while (at + 8 <= length) {
                val box = header(handle, at, length) ?: break
                if (box.end > length) {
                    complete = false
                    break
                }
                when (box.type) {
                    "moov" -> {
                        parseMoov(load(handle, box))
                        sawMoov = true
                    }
                    "moof" -> {
                        // A moof that does not hold together is where the reading stops, like one cut off.
                        val read = sawMoov && try {
                            parseFragment(load(handle, box), box, length)
                        } catch (malformed: Malformed) {
                            false
                        }
                        if (!read) {
                            complete = false
                            break
                        }
                        fragments += 1
                    }
                }
                at = box.end
            }
            if (at < length) complete = false
        }
    }

    /** A box's header read from the file: 8 bytes, or 16 with a 64-bit size. */
    private fun header(handle: RandomAccessFile, at: Long, length: Long): Box? {
        if (at + 8 > length) return null
        val head = ByteArray(16)
        handle.seek(at)
        handle.readFully(head, 0, 8)
        val window = Window(at, head)
        var size = window.u32(at)
        val type = window.fourCC(at + 4)
        var headerSize = 8
        if (size == 1L) {
            if (at + 16 > length) return null
            handle.readFully(head, 8, 8)
            size = window.u64(at + 8)
            headerSize = 16
        } else if (size == 0L) {
            size = length - at
        }
        if (size < headerSize) return null
        return Box(type, at, headerSize, size)
    }

    /** A `moov` or `moof` into memory. They describe samples and hold none, so they are small. */
    private fun load(handle: RandomAccessFile, box: Box): Window {
        if (box.size > MaxDescriptionBytes) throw Malformed("a ${box.type} of ${box.size} bytes")
        val bytes = ByteArray(box.size.toInt())
        handle.seek(box.start)
        handle.readFully(bytes)
        return Window(box.start, bytes)
    }

    private fun parseMoov(moov: Window) {
        val box = header(moov, moov.origin) ?: throw Malformed("no moov header")
        for (trak in children(moov, box).filter { it.type == "trak" }) {
            var id = 0
            var timescale = 1
            var kind = Kind.OTHER
            var entry = ""
            var configuration: ByteArray? = null
            var width = 0
            var height = 0
            var channels = 0
            var mediaTime = 0L
            for (child in children(moov, trak)) {
                when (child.type) {
                    "tkhd" -> id = moov.u32(child.bodyStart + 12).toInt()
                    "edts" -> children(moov, child).firstOrNull { it.type == "elst" }?.let {
                        if (moov.u32(it.bodyStart + 4) > 0) mediaTime = moov.u32(it.bodyStart + 12)
                    }
                    "mdia" -> for (part in children(moov, child)) {
                        when (part.type) {
                            "mdhd" -> timescale = moov.u32(part.bodyStart + 12).toInt()
                            "hdlr" -> kind = when (moov.fourCC(part.bodyStart + 8)) {
                                "vide" -> Kind.VIDEO
                                "soun" -> Kind.AUDIO
                                else -> Kind.OTHER
                            }
                            "minf" -> {
                                val stsd = children(moov, part).firstOrNull { it.type == "stbl" }
                                    ?.let { stbl -> children(moov, stbl).firstOrNull { it.type == "stsd" } }
                                val sample = stsd?.let { header(moov, it.bodyStart + 8) }
                                if (sample != null) {
                                    entry = sample.type
                                    if (entry == "mp4a") {
                                        channels = moov.u16(sample.bodyStart + 16)
                                        val esds = children(moov, sample, skip = 28).firstOrNull { it.type == "esds" }
                                        configuration = esds?.let { audioSpecificConfig(moov, it) }
                                    } else {
                                        width = moov.u16(sample.bodyStart + 24)
                                        height = moov.u16(sample.bodyStart + 26)
                                        val config = children(moov, sample, skip = 78).firstOrNull { it.type == "hvcC" || it.type == "avcC" }
                                        configuration = config?.let { moov.copy(it.bodyStart, it.end) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            tracks += Track(id, kind, timescale, entry, configuration, width, height, channels, mediaTime)
        }
    }

    /** The DecoderSpecificInfo (tag 5) inside an `esds`. */
    private fun audioSpecificConfig(moov: Window, esds: Box): ByteArray? {
        var at = esds.bodyStart + 4
        while (at < esds.end) {
            val tag = moov.u8(at)
            at += 1
            var length = 0L
            while (true) {
                val byte = moov.u8(at)
                at += 1
                length = (length shl 7) or (byte and 0x7F).toLong()
                if (byte and 0x80 == 0) break
            }
            when (tag) {
                0x03 -> at += 3
                0x04 -> at += 13
                0x05 -> return moov.copy(at, at + length)
                else -> at += length
            }
        }
        return null
    }

    private fun parseFragment(window: Window, moof: Box, length: Long): Boolean {
        val pending = mutableListOf<Pair<Track, Sample>>()
        for (traf in children(window, moof).filter { it.type == "traf" }) {
            var track: Track? = null
            var base = moof.start
            var decode = 0L
            var defaultDuration = 0L
            var defaultSize = 0L
            var defaultFlags = 0L
            for (child in children(window, traf)) {
                val flags = window.u32(child.bodyStart).toInt() and 0xFFFFFF
                val version = window.u8(child.bodyStart)
                when (child.type) {
                    "tfhd" -> {
                        val id = window.u32(child.bodyStart + 4).toInt()
                        track = tracks.firstOrNull { it.id == id }
                        var at = child.bodyStart + 8
                        if (flags and 0x01 != 0) {
                            base = window.u64(at)
                            at += 8
                        }
                        if (flags and 0x02 != 0) at += 4
                        if (flags and 0x08 != 0) {
                            defaultDuration = window.u32(at)
                            at += 4
                        }
                        if (flags and 0x10 != 0) {
                            defaultSize = window.u32(at)
                            at += 4
                        }
                        if (flags and 0x20 != 0) defaultFlags = window.u32(at)
                    }
                    "tfdt" -> decode = if (version == 1) window.u64(child.bodyStart + 4) else window.u32(child.bodyStart + 4)
                    "trun" -> {
                        val target = track ?: return false
                        val count = window.u32(child.bodyStart + 4)
                        var at = child.bodyStart + 8
                        var dataAt = base
                        if (flags and 0x01 != 0) {
                            // data_offset is signed.
                            dataAt = base + window.u32(at).toInt()
                            at += 4
                        }
                        var firstFlags: Long? = null
                        if (flags and 0x04 != 0) {
                            firstFlags = window.u32(at)
                            at += 4
                        }
                        for (index in 0L until count) {
                            var duration = defaultDuration
                            var size = defaultSize
                            var sampleFlags = if (index == 0L && firstFlags != null) firstFlags else defaultFlags
                            if (flags and 0x100 != 0) { duration = window.u32(at); at += 4 }
                            if (flags and 0x200 != 0) { size = window.u32(at); at += 4 }
                            if (flags and 0x400 != 0) { sampleFlags = window.u32(at); at += 4 }
                            if (flags and 0x800 != 0) at += 4
                            if (size > MaxSampleBytes || dataAt < 0 || dataAt + size > length) return false
                            pending += target to Sample(dataAt, size.toInt(), decode, duration, sampleFlags and 0x00010000L == 0L)
                            dataAt += size
                            decode += duration
                        }
                    }
                }
            }
        }
        pending.forEach { (track, sample) -> track.samples += sample }
        return true
    }

    private fun children(window: Window, parent: Box, skip: Int = 0): List<Box> {
        val boxes = mutableListOf<Box>()
        var at = parent.bodyStart + skip
        while (at + 8 <= parent.end) {
            val box = header(window, at) ?: break
            if (box.end > parent.end || box.size < 8) break
            boxes += box
            at = box.end
        }
        return boxes
    }

    private fun header(window: Window, at: Long): Box? {
        if (at + 8 > window.end) return null
        var size = window.u32(at)
        val type = window.fourCC(at + 4)
        var headerSize = 8
        if (size == 1L) {
            if (at + 16 > window.end) return null
            size = window.u64(at + 8)
            headerSize = 16
        } else if (size == 0L) {
            size = window.end - at
        }
        if (size < headerSize) return null
        return Box(type, at, headerSize, size)
    }

    companion object {
        /** The largest `moov` or `moof` read into memory; the writer's are a few kilobytes. */
        const val MaxDescriptionBytes = 16L * 1024 * 1024

        /** The largest sample believed; a 4K keyframe is a few megabytes. */
        const val MaxSampleBytes = 64L * 1024 * 1024

        /**
         * Reads [file], or null when it is missing or not an MP4 with a `moov` this can read. A file
         * that cannot be read from disk throws, naming it.
         */
        fun read(file: File): FragmentedMp4Reader? {
            if (!file.isFile) return null
            val reader = FragmentedMp4Reader(file)
            try {
                reader.parse()
            } catch (malformed: Malformed) {
                return null
            } catch (error: IOException) {
                throw IOException("could not read ${file.name}: ${error.message ?: error.javaClass.simpleName}", error)
            }
            return reader.takeIf { it.tracks.isNotEmpty() }
        }
    }
}
