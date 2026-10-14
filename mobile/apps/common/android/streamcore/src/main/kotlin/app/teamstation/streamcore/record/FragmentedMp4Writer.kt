package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.StreamCodec
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.IOException
import kotlin.math.roundToLong

/**
 * A fragmented MP4 muxer for one HEVC (or H.264) track and one AAC track, which writes a `moof` and
 * its `mdat` every [fragmentSeconds].
 *
 * Android's `MediaMuxer` cannot fragment, and TS Director's recording survives a crash precisely
 * because AVAssetWriter fragments it every 3 s: the `moov` at the front describes the tracks and no
 * samples, and every fragment after it is complete in itself, so a file cut off anywhere keeps
 * every fragment written before the cut. Each fragment is forced to storage as it is written.
 *
 * Times are seconds on the part's own timeline. A picture's duration is not known until the next one
 * arrives, so the newest picture is held back to the next fragment; [finish] gives the last one its
 * duration, which is how the hold at Stop is written as one picture lasting out the take. Sound is
 * contiguous: every AAC packet lasts 1024 samples from where the last one ended.
 */
class FragmentedMp4Writer(
    val file: File,
    private val video: VideoTrack?,
    private val audio: AudioTrack?,
    private val fragmentSeconds: Double = 3.0,
    /**
     * Whether each fragment is forced to storage as it is written. False leaves the force to the
     * owner, through [syncPending], so it can do it outside whatever lock it writes under: one slow
     * fsync held under the recorder's lock froze the preview, the stream's pictures and the live sound.
     */
    private val syncEachFragment: Boolean = true,
    /** How the file is forced to storage: `FileDescriptor.sync`, or a refusal in a test. */
    private val forceToStorage: (FileDescriptor) -> Unit = FileDescriptor::sync
) {
    /** A picture track: the codec, its size, and its decoder configuration record (`hvcC` or `avcC`). */
    class VideoTrack(
        val codec: StreamCodec,
        val width: Int,
        val height: Int,
        val decoderConfiguration: ByteArray,
        val timescale: Int = 90_000,
        /** BT.709 primaries, transfer and matrix, stated in a `colr` box as TS Director's master is. */
        val bt709: Boolean = true
    )

    /** An AAC-LC track. [primingSamples] is skipped with an edit list. */
    class AudioTrack(
        val audioSpecificConfig: ByteArray,
        val sampleRate: Int = 48_000,
        val channels: Int = 2,
        val primingSamples: Int = 0,
        val bitrate: Int = 192_000
    )

    private class Sample(val data: ByteArray, val ticks: Long, var duration: Long, val sync: Boolean)

    private val fileOut = FileOutputStream(file)

    /** Every box and sample goes through this, and is flushed to [fileOut] at the end of each fragment. */
    private val out = BufferedOutputStream(fileOut, 64 * 1024)
    private var sequence = 0
    private var audioTicks = 0L

    /** The sound queued for the next fragment, in samples: kept as it changes, never summed. */
    private var audioQueueTicks = 0L
    private val videoQueue = mutableListOf<Sample>()
    private val audioQueue = mutableListOf<Sample>()
    private var heldPicture: Sample? = null
    private var fragmentStart: Double? = null

    @Volatile
    private var closed = false

    /** Fragments handed to the file. */
    @Volatile
    private var flushedFragments = 0

    /** Fragments forced to storage: a fragment counts only once a force after it succeeded. */
    @Volatile
    private var syncedFragments = 0

    /** Fragments handed to the file that have not been forced to storage. */
    internal val hasPendingSync: Boolean get() = !closed && flushedFragments > syncedFragments

    /** Pictures and packets written to the file, held-back picture included once it is. */
    var videoSamples = 0
        private set
    var audioSamples = 0
        private set

    /** The most samples ever queued for one fragment, both tracks together: what the writer held in memory at once. */
    var peakQueuedSamples = 0
        private set

    /** Where the sound written so far ends, in seconds. */
    val audioEndSeconds: Double get() = audio?.let { (audioTicks + audioQueueTicks).toDouble() / it.sampleRate } ?: 0.0

    init {
        try {
            out.write(ftyp())
            out.write(moov())
            out.flush()
        } catch (error: IOException) {
            runCatching { fileOut.close() }
            throw error
        }
    }

    /**
     * One coded picture, length-prefixed NAL units, presented at [seconds]. A picture at or before
     * the one before it is refused: the track's times only move forward.
     */
    fun writeVideo(sample: ByteArray, seconds: Double, keyframe: Boolean): Boolean {
        val track = video ?: return false
        check(!closed) { "writer is finished" }
        val ticks = (seconds * track.timescale).roundToLong()
        val held = heldPicture
        if (held != null) {
            if (ticks <= held.ticks) return false
            held.duration = ticks - held.ticks
            videoQueue += held
        }
        heldPicture = Sample(sample, ticks, 0, keyframe)
        if (fragmentStart == null) fragmentStart = seconds
        if (seconds - (fragmentStart ?: seconds) >= fragmentSeconds) flush(next = seconds)
        return true
    }

    /** One AAC packet, 1024 samples after the last. */
    fun writeAudio(packet: ByteArray) {
        val track = audio ?: return
        check(!closed) { "writer is finished" }
        audioQueue += Sample(packet, audioTicks + audioQueueTicks, StreamPacketSamples, true)
        audioQueueTicks += StreamPacketSamples
        val seconds = (audioTicks + audioQueueTicks).toDouble() / track.sampleRate
        if (video == null) {
            if (fragmentStart == null) fragmentStart = 0.0
            if (seconds - (fragmentStart ?: 0.0) >= fragmentSeconds) flush(next = seconds)
        } else if (audioQueueTicks.toDouble() / track.sampleRate >= fragmentSeconds * AUDIO_CUT_FRAGMENTS) {
            // Pictures normally cut the fragments, and sound written beside them goes in with them.
            // Sound that runs on without pictures (a part's sound written after its pictures, or a
            // picture track that has stopped) is cut by its own length, so it is never held whole.
            flush(next = null)
        }
    }

    /**
     * Writes the held picture with [lastPictureSeconds] of duration (a frame when null), the last
     * fragment, and closes the file.
     */
    fun finish(lastPictureSeconds: Double? = null) {
        if (closed) return
        val held = heldPicture
        val track = video
        if (held != null && track != null) {
            val fallback = track.timescale / 30L
            held.duration = lastPictureSeconds?.let { maxOf(1L, (it * track.timescale).roundToLong()) } ?: fallback
            videoQueue += held
            heldPicture = null
        }
        closed = true
        try {
            flush(next = null)
            out.flush()
            forceToStorage(fileOut.fd)
        } finally {
            runCatching { fileOut.close() }
        }
    }

    /** Closes the file without writing what is buffered, as a crash would leave it. */
    fun abandon() {
        if (closed) return
        closed = true
        runCatching { fileOut.close() }
    }

    /**
     * Forces the fragments written since the last call to storage, when the writer was made without
     * [syncEachFragment]. Safe from any thread, alongside the writes. False when storage refused, and
     * the fragments stay unforced; a file closed meanwhile has nothing left to force, because [finish]
     * forced it and [abandon] let it go.
     */
    fun syncPending(): Boolean {
        val through = flushedFragments
        if (through <= syncedFragments) return true
        return try {
            forceToStorage(fileOut.fd)
            syncedFragments = through
            true
        } catch (error: IOException) {
            closed
        }
    }

    private fun flush(next: Double?) {
        if (videoQueue.isEmpty() && audioQueue.isEmpty()) {
            fragmentStart = next
            return
        }
        peakQueuedSamples = maxOf(peakQueuedSamples, videoQueue.size + audioQueue.size)
        sequence += 1
        writeFragment(sequence)
        out.flush()
        if (syncEachFragment) forceToStorage(fileOut.fd)
        flushedFragments = sequence
        videoSamples += videoQueue.size
        audioSamples += audioQueue.size
        audioTicks += audioQueueTicks
        audioQueueTicks = 0
        videoQueue.clear()
        audioQueue.clear()
        fragmentStart = next
    }

    // MARK: - Boxes

    private fun ftyp(): ByteArray = box("ftyp") {
        fourCC("isom")
        u32(0x200)
        listOf("isom", "iso6", "mp41").forEach { fourCC(it) }
    }

    private fun moov(): ByteArray = box("moov") {
        write(fullBox("mvhd", 0, 0) {
            u32(0); u32(0)
            u32(1000)
            u32(0)
            u32(0x00010000)
            u16(0x0100); u16(0); u32(0); u32(0)
            matrix()
            repeat(6) { u32(0) }
            u32(trackCount() + 1)
        })
        video?.let { write(videoTrak(it)) }
        audio?.let { write(audioTrak(it)) }
        write(box("mvex") {
            for (id in 1..trackCount()) {
                write(fullBox("trex", 0, 0) { u32(id); u32(1); u32(0); u32(0); u32(0) })
            }
        })
    }

    private fun trackCount(): Int = (if (video != null) 1 else 0) + (if (audio != null) 1 else 0)
    private fun videoID(): Int = 1
    private fun audioID(): Int = if (video != null) 2 else 1

    private fun videoTrak(track: VideoTrack): ByteArray = box("trak") {
        write(tkhd(videoID(), volume = 0, width = track.width, height = track.height))
        write(box("mdia") {
            write(mdhd(track.timescale))
            write(hdlr("vide", "VideoHandler"))
            write(box("minf") {
                write(fullBox("vmhd", 0, 1) { u16(0); u16(0); u16(0); u16(0) })
                write(dinf())
                write(stbl(videoEntry(track)))
            })
        })
    }

    private fun audioTrak(track: AudioTrack): ByteArray = box("trak") {
        write(tkhd(audioID(), volume = 0x0100, width = 0, height = 0))
        if (track.primingSamples > 0) {
            write(box("edts") {
                write(fullBox("elst", 0, 0) {
                    u32(1)
                    u32(0)
                    u32(track.primingSamples.toLong())
                    u32(0x00010000)
                })
            })
        }
        write(box("mdia") {
            write(mdhd(track.sampleRate))
            write(hdlr("soun", "SoundHandler"))
            write(box("minf") {
                write(fullBox("smhd", 0, 0) { u16(0); u16(0) })
                write(dinf())
                write(stbl(audioEntry(track)))
            })
        })
    }

    private fun tkhd(id: Int, volume: Int, width: Int, height: Int): ByteArray = fullBox("tkhd", 0, 3) {
        u32(0); u32(0)
        u32(id)
        u32(0)
        u32(0)
        u32(0); u32(0)
        u16(0); u16(0)
        u16(volume); u16(0)
        matrix()
        u32(width.toLong() shl 16)
        u32(height.toLong() shl 16)
    }

    private fun mdhd(timescale: Int): ByteArray = fullBox("mdhd", 0, 0) {
        u32(0); u32(0)
        u32(timescale)
        u32(0)
        // "und", packed as three five-bit letters.
        u16(0x55C4)
        u16(0)
    }

    private fun hdlr(type: String, name: String): ByteArray = fullBox("hdlr", 0, 0) {
        u32(0)
        fourCC(type)
        u32(0); u32(0); u32(0)
        write(name.toByteArray(Charsets.US_ASCII))
        write(byteArrayOf(0))
    }

    private fun dinf(): ByteArray = box("dinf") {
        write(fullBox("dref", 0, 0) {
            u32(1)
            write(fullBox("url ", 0, 1) {})
        })
    }

    private fun stbl(entry: ByteArray): ByteArray = box("stbl") {
        write(fullBox("stsd", 0, 0) {
            u32(1)
            write(entry)
        })
        write(fullBox("stts", 0, 0) { u32(0) })
        write(fullBox("stsc", 0, 0) { u32(0) })
        write(fullBox("stsz", 0, 0) { u32(0); u32(0) })
        write(fullBox("stco", 0, 0) { u32(0) })
    }

    private fun videoEntry(track: VideoTrack): ByteArray {
        val (entry, config) = when (track.codec) {
            StreamCodec.HEVC -> "hvc1" to "hvcC"
            StreamCodec.H264 -> "avc1" to "avcC"
        }
        return box(entry) {
            repeat(6) { write(byteArrayOf(0)) }
            u16(1)
            u16(0); u16(0)
            u32(0); u32(0); u32(0)
            u16(track.width)
            u16(track.height)
            u32(0x00480000)
            u32(0x00480000)
            u32(0)
            u16(1)
            write(ByteArray(32))
            u16(0x0018)
            u16(0xFFFF)
            write(box(config) { write(track.decoderConfiguration) })
            if (track.bt709) {
                write(box("colr") {
                    fourCC("nclx")
                    u16(1); u16(1); u16(1)
                    write(byteArrayOf(0))
                })
            }
        }
    }

    private fun audioEntry(track: AudioTrack): ByteArray = box("mp4a") {
        repeat(6) { write(byteArrayOf(0)) }
        u16(1)
        u32(0); u32(0)
        u16(track.channels)
        u16(16)
        u16(0); u16(0)
        u32(track.sampleRate.toLong() shl 16)
        write(fullBox("esds", 0, 0) {
            val specific = descriptor(0x05, track.audioSpecificConfig)
            val decoderConfig = descriptor(
                0x04,
                ByteArrayOutputStream().apply {
                    write(0x40)
                    write(0x15)
                    write(byteArrayOf(0, 0, 0))
                    writeU32(this, track.bitrate.toLong())
                    writeU32(this, track.bitrate.toLong())
                    write(specific)
                }.toByteArray()
            )
            val sl = descriptor(0x06, byteArrayOf(0x02))
            write(descriptor(0x03, ByteArrayOutputStream().apply {
                write(0); write(audioID())
                write(0)
                write(decoderConfig)
                write(sl)
            }.toByteArray()))
        })
    }

    private fun descriptor(tag: Int, body: ByteArray): ByteArray = ByteArrayOutputStream().apply {
        write(tag)
        // Four-byte length, as most muxers write it, so a long config cannot overflow one byte.
        write(0x80 or ((body.size ushr 21) and 0x7F))
        write(0x80 or ((body.size ushr 14) and 0x7F))
        write(0x80 or ((body.size ushr 7) and 0x7F))
        write(body.size and 0x7F)
        write(body)
    }.toByteArray()

    /**
     * One `moof` and its `mdat`, the samples streamed to the file one by one rather than copied into
     * one payload first.
     */
    private fun writeFragment(sequence: Int) {
        // The moof's size decides the data offsets inside it, and the offsets do not change its size,
        // so it is built once to measure and once to keep.
        val draft = moof(sequence, 0)
        val moof = moof(sequence, draft.size + 8)
        val payload = videoQueue.sumOf { it.data.size.toLong() } + audioQueue.sumOf { it.data.size.toLong() }
        out.write(moof)
        val header = ByteArrayOutputStream(8)
        writeU32(header, 8L + payload)
        header.write("mdat".toByteArray(Charsets.US_ASCII))
        out.write(header.toByteArray())
        videoQueue.forEach { out.write(it.data) }
        audioQueue.forEach { out.write(it.data) }
    }

    private fun moof(sequence: Int, dataStart: Int): ByteArray = box("moof") {
        write(fullBox("mfhd", 0, 0) { u32(sequence) })
        var offset = dataStart
        if (videoQueue.isNotEmpty()) {
            write(traf(videoID(), videoQueue, offset))
            offset += videoQueue.sumOf { it.data.size }
        }
        if (audioQueue.isNotEmpty()) write(traf(audioID(), audioQueue, offset))
    }

    private fun traf(id: Int, samples: List<Sample>, offset: Int): ByteArray = box("traf") {
        // default-base-is-moof: data offsets count from the start of this moof.
        write(fullBox("tfhd", 0, 0x020000) { u32(id) })
        write(fullBox("tfdt", 1, 0) { u64(samples.first().ticks) })
        write(fullBox("trun", 0, 0x000701) {
            u32(samples.size)
            u32(offset)
            for (sample in samples) {
                u32(sample.duration)
                u32(sample.data.size)
                // Sync: depends on nothing. Otherwise: depends on others, and is not a sync sample.
                u32(if (sample.sync) 0x02000000 else 0x01010000)
            }
        })
    }

    /** Writes a box's body into a buffer, as the box builders here do. */
    private class BoxBody : ByteArrayOutputStream() {
        fun u16(value: Int) {
            write((value ushr 8) and 0xFF)
            write(value and 0xFF)
        }

        fun u32(value: Int) = u32(value.toLong())
        fun u32(value: Long) = writeU32(this, value)
        fun u64(value: Long) {
            u32(value ushr 32)
            u32(value and 0xFFFFFFFFL)
        }

        fun fourCC(code: String) = write(code.toByteArray(Charsets.US_ASCII))

        fun matrix() {
            listOf(0x00010000L, 0, 0, 0, 0x00010000L, 0, 0, 0, 0x40000000L).forEach { u32(it) }
        }
    }

    private fun box(type: String, body: BoxBody.() -> Unit): ByteArray {
        val content = BoxBody().apply(body).toByteArray()
        return ByteArrayOutputStream(content.size + 8).apply {
            writeU32(this, 8L + content.size)
            write(type.toByteArray(Charsets.US_ASCII))
            write(content)
        }.toByteArray()
    }

    private fun fullBox(type: String, version: Int, flags: Int, body: BoxBody.() -> Unit): ByteArray = box(type) {
        write(version)
        write((flags ushr 16) and 0xFF)
        write((flags ushr 8) and 0xFF)
        write(flags and 0xFF)
        body()
    }

    companion object {
        /** An AAC-LC packet's length in samples. */
        const val StreamPacketSamples = 1024L

        /** With a picture track, sound queued for this many fragments' length is cut on its own. */
        const val AUDIO_CUT_FRAGMENTS = 2.0

        private fun writeU32(out: ByteArrayOutputStream, value: Long) {
            out.write(((value ushr 24) and 0xFF).toInt())
            out.write(((value ushr 16) and 0xFF).toInt())
            out.write(((value ushr 8) and 0xFF).toInt())
            out.write((value and 0xFF).toInt())
        }
    }
}
