package app.teamstation.streamcore.record

import java.io.File
import java.io.RandomAccessFile

/**
 * Reads back a fragmented MP4 as [FragmentedMp4Writer] writes it, without decoding anything: the
 * tracks the `moov` describes, and every sample of every complete fragment. A fragment whose `moof`
 * or sample data runs past the end of the file, which is what a crash mid-write leaves, ends the
 * reading; everything before it is kept.
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

    val tracks = mutableListOf<Track>()

    /** Complete fragments read. */
    var fragments = 0
        private set

    /** Whether the reading reached the end of the file without a cut-off fragment. */
    var complete = true
        private set

    val video: Track? get() = tracks.firstOrNull { it.kind == Kind.VIDEO }
    val audio: Track? get() = tracks.firstOrNull { it.kind == Kind.AUDIO }

    /** One sample's bytes. */
    fun read(sample: Sample): ByteArray = RandomAccessFile(file, "r").use { raf ->
        ByteArray(sample.size).also {
            raf.seek(sample.offset)
            raf.readFully(it)
        }
    }

    private class Box(val type: String, val start: Long, val headerSize: Int, val size: Long) {
        val bodyStart: Long get() = start + headerSize
        val end: Long get() = start + size
    }

    private fun parse() {
        val bytes = file.readBytes()
        val length = bytes.size.toLong()
        var at = 0L
        var sawMoov = false
        while (at + 8 <= length) {
            val box = header(bytes, at) ?: break
            if (box.end > length) {
                complete = false
                break
            }
            when (box.type) {
                "moov" -> {
                    parseMoov(bytes, box)
                    sawMoov = true
                }
                "moof" -> {
                    if (!sawMoov || !parseFragment(bytes, box, length)) {
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

    private fun parseMoov(bytes: ByteArray, moov: Box) {
        for (trak in children(bytes, moov).filter { it.type == "trak" }) {
            var id = 0
            var timescale = 1
            var kind = Kind.OTHER
            var entry = ""
            var configuration: ByteArray? = null
            var width = 0
            var height = 0
            var channels = 0
            var mediaTime = 0L
            for (child in children(bytes, trak)) {
                when (child.type) {
                    "tkhd" -> id = u32(bytes, child.bodyStart + 12).toInt()
                    "edts" -> children(bytes, child).firstOrNull { it.type == "elst" }?.let {
                        if (u32(bytes, it.bodyStart + 4) > 0) mediaTime = u32(bytes, it.bodyStart + 12)
                    }
                    "mdia" -> for (part in children(bytes, child)) {
                        when (part.type) {
                            "mdhd" -> timescale = u32(bytes, part.bodyStart + 12).toInt()
                            "hdlr" -> kind = when (fourCC(bytes, part.bodyStart + 8)) {
                                "vide" -> Kind.VIDEO
                                "soun" -> Kind.AUDIO
                                else -> Kind.OTHER
                            }
                            "minf" -> {
                                val stsd = children(bytes, part).firstOrNull { it.type == "stbl" }
                                    ?.let { stbl -> children(bytes, stbl).firstOrNull { it.type == "stsd" } }
                                val sample = stsd?.let { header(bytes, it.bodyStart + 8) }
                                if (sample != null) {
                                    entry = sample.type
                                    if (entry == "mp4a") {
                                        channels = u16(bytes, sample.bodyStart + 16)
                                        val esds = children(bytes, sample, skip = 28).firstOrNull { it.type == "esds" }
                                        configuration = esds?.let { audioSpecificConfig(bytes, it) }
                                    } else {
                                        width = u16(bytes, sample.bodyStart + 24)
                                        height = u16(bytes, sample.bodyStart + 26)
                                        val config = children(bytes, sample, skip = 78).firstOrNull { it.type == "hvcC" || it.type == "avcC" }
                                        configuration = config?.let { bytes.copyOfRange(it.bodyStart.toInt(), it.end.toInt()) }
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
    private fun audioSpecificConfig(bytes: ByteArray, esds: Box): ByteArray? {
        var at = esds.bodyStart.toInt() + 4
        while (at < esds.end) {
            val tag = bytes[at].toInt() and 0xFF
            at += 1
            var length = 0
            while (true) {
                val byte = bytes[at].toInt() and 0xFF
                at += 1
                length = (length shl 7) or (byte and 0x7F)
                if (byte and 0x80 == 0) break
            }
            when (tag) {
                0x03 -> at += 3
                0x04 -> at += 13
                0x05 -> return bytes.copyOfRange(at, at + length)
                else -> at += length
            }
        }
        return null
    }

    private fun parseFragment(bytes: ByteArray, moof: Box, length: Long): Boolean {
        val pending = mutableListOf<Pair<Track, Sample>>()
        for (traf in children(bytes, moof).filter { it.type == "traf" }) {
            var track: Track? = null
            var base = moof.start
            var decode = 0L
            var defaultDuration = 0L
            var defaultSize = 0
            var defaultFlags = 0L
            for (child in children(bytes, traf)) {
                val flags = u32(bytes, child.bodyStart).toInt() and 0xFFFFFF
                val version = bytes[child.bodyStart.toInt()].toInt() and 0xFF
                when (child.type) {
                    "tfhd" -> {
                        val id = u32(bytes, child.bodyStart + 4).toInt()
                        track = tracks.firstOrNull { it.id == id }
                        var at = child.bodyStart + 8
                        if (flags and 0x01 != 0) {
                            base = u64(bytes, at)
                            at += 8
                        }
                        if (flags and 0x02 != 0) at += 4
                        if (flags and 0x08 != 0) {
                            defaultDuration = u32(bytes, at)
                            at += 4
                        }
                        if (flags and 0x10 != 0) {
                            defaultSize = u32(bytes, at).toInt()
                            at += 4
                        }
                        if (flags and 0x20 != 0) defaultFlags = u32(bytes, at)
                    }
                    "tfdt" -> decode = if (version == 1) u64(bytes, child.bodyStart + 4) else u32(bytes, child.bodyStart + 4)
                    "trun" -> {
                        val target = track ?: return false
                        val count = u32(bytes, child.bodyStart + 4).toInt()
                        var at = child.bodyStart + 8
                        var dataAt = base
                        if (flags and 0x01 != 0) {
                            dataAt = base + u32(bytes, at).toInt()
                            at += 4
                        }
                        var firstFlags: Long? = null
                        if (flags and 0x04 != 0) {
                            firstFlags = u32(bytes, at)
                            at += 4
                        }
                        repeat(count) { index ->
                            var duration = defaultDuration
                            var size = defaultSize
                            var sampleFlags = if (index == 0 && firstFlags != null) firstFlags else defaultFlags
                            if (flags and 0x100 != 0) { duration = u32(bytes, at); at += 4 }
                            if (flags and 0x200 != 0) { size = u32(bytes, at).toInt(); at += 4 }
                            if (flags and 0x400 != 0) { sampleFlags = u32(bytes, at); at += 4 }
                            if (flags and 0x800 != 0) at += 4
                            if (dataAt + size > length) return false
                            pending += target to Sample(dataAt, size, decode, duration, sampleFlags and 0x00010000L == 0L)
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

    private fun children(bytes: ByteArray, parent: Box, skip: Int = 0): List<Box> {
        val boxes = mutableListOf<Box>()
        var at = parent.bodyStart + skip
        while (at + 8 <= parent.end) {
            val box = header(bytes, at) ?: break
            if (box.end > parent.end || box.size < 8) break
            boxes += box
            at = box.end
        }
        return boxes
    }

    private fun header(bytes: ByteArray, at: Long): Box? {
        if (at + 8 > bytes.size) return null
        var size = u32(bytes, at)
        val type = fourCC(bytes, at + 4)
        var headerSize = 8
        if (size == 1L) {
            if (at + 16 > bytes.size) return null
            size = u64(bytes, at + 8)
            headerSize = 16
        } else if (size == 0L) {
            size = bytes.size - at
        }
        if (size < headerSize) return null
        return Box(type, at, headerSize, size)
    }

    companion object {
        /** Reads [file], or null when it is not an MP4 with a `moov` this can read. */
        fun read(file: File): FragmentedMp4Reader? {
            if (!file.isFile) return null
            val reader = FragmentedMp4Reader(file)
            return runCatching { reader.parse() }.map { reader }.getOrNull()?.takeIf { it.tracks.isNotEmpty() }
        }

        private fun u16(bytes: ByteArray, at: Long): Int =
            ((bytes[at.toInt()].toInt() and 0xFF) shl 8) or (bytes[at.toInt() + 1].toInt() and 0xFF)

        private fun u32(bytes: ByteArray, at: Long): Long {
            var value = 0L
            for (index in 0 until 4) value = (value shl 8) or (bytes[at.toInt() + index].toLong() and 0xFF)
            return value
        }

        private fun u64(bytes: ByteArray, at: Long): Long = (u32(bytes, at) shl 32) or u32(bytes, at + 4)

        private fun fourCC(bytes: ByteArray, at: Long): String = String(bytes, at.toInt(), 4, Charsets.US_ASCII)
    }
}
