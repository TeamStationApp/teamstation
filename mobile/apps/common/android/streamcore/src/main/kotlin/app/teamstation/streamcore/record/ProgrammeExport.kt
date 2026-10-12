package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.StreamCodec
import java.io.File
import java.util.Locale

/**
 * A take's programme master as one file. A port of TS Director's `ProgrammeExport`.
 *
 * An unbroken take, one part whose anchors agree and whose pictures cover the window, is copied as
 * it is. Anything that makes its timeline doubtful (a second part, a resume, anchors that disagree, a
 * part that does not reach one end of the window or does not read to its end) has it rebuilt. TS
 * Director rebuilds by re-encoding; here every part's coded samples are placed by its own wall start
 * in a new [FragmentedMp4Writer] file, nothing re-encoded: across a hole the last picture is held as
 * one sample lasting the gap, and the sound is filled with coded silence ([SilentAac]).
 */
object ProgrammeExport {
    /** Why a master has to be rebuilt. */
    sealed class Break {
        abstract val description: String

        /** More than one part on disk. */
        data class Parts(val count: Int) : Break() {
            override val description get() = "$count programme parts"
        }

        /** The take was picked up again after the app stopped. */
        data class Resumed(val count: Int) : Break() {
            override val description get() = "resumed $count time${if (count == 1) "" else "s"}"
        }

        /** The anchors name a part after the first. */
        data class Continuation(val part: Int) : Break() {
            override val description get() = "anchors for part $part"
        }

        data object Unanchored : Break() {
            override val description get() = "no anchors"
        }

        data class AnchorsDisagree(val seconds: Double) : Break() {
            override val description get() = "anchors disagree by %.3f s".format(Locale.US, seconds)
        }

        data object Unreadable : Break() {
            override val description get() = "part does not read to its end"
        }

        data class StartsLate(val seconds: Double) : Break() {
            override val description get() = "part starts %.3f s late".format(Locale.US, seconds)
        }

        data class EndsEarly(val seconds: Double) : Break() {
            override val description get() = "part ends %.3f s early".format(Locale.US, seconds)
        }
    }

    sealed class Plan {
        /** Copy the one part as it is, its own timeline starting at [partStart]. */
        data class Copy(val partStart: Double) : Plan()

        /** Rebuild the master from its parts, for [reason]. */
        data class Reencode(val reason: Break) : Plan()

        /** How TS Director's fixtures name the plan. */
        val description: String
            get() = when (this) {
                is Copy -> "copy from %.6f".format(Locale.US, partStart)
                is Reencode -> "reencode: ${reason.description}"
            }
    }

    /** What reading the one part's pictures found, on its own timeline, in seconds. */
    data class PartReading(
        val firstPicture: Double,
        val lastPictureEnd: Double,
        val declaredEnd: Double,
        val completed: Boolean
    )

    /** Copy only when everything TS Director checks holds, in its order. Pure. */
    fun plan(
        partCount: Int,
        resumeCount: Int,
        anchors: List<RecordingCatalog.ProgramAnchor>,
        reading: PartReading?,
        windowStart: Double,
        windowEnd: Double?,
        frameRate: Int
    ): Plan {
        if (partCount != 1) return Plan.Reencode(Break.Parts(partCount))
        if (resumeCount != 0) return Plan.Reencode(Break.Resumed(resumeCount))
        anchors.map { it.part }.filter { it != 1 }.maxOrNull()?.let { return Plan.Reencode(Break.Continuation(it)) }
        val implied = anchors.map { it.partStartWall }
        val (start, agreeing) = RecordingCatalog.partStart(implied) ?: return Plan.Reencode(Break.Unanchored)
        val frame = 1.0 / maxOf(1, frameRate)
        if (agreeing * 2 <= implied.size) {
            return Plan.Reencode(Break.AnchorsDisagree((implied.maxOrNull() ?: start) - (implied.minOrNull() ?: start)))
        }
        if (reading == null || !reading.completed || reading.declaredEnd - reading.lastPictureEnd > frame) {
            return Plan.Reencode(Break.Unreadable)
        }
        val late = (start + reading.firstPicture) - windowStart
        if (late > frame) return Plan.Reencode(Break.StartsLate(late))
        if (windowEnd != null) {
            val early = windowEnd - (start + reading.lastPictureEnd)
            if (early > frame) return Plan.Reencode(Break.EndsEarly(early))
        }
        return Plan.Copy(start)
    }

    /**
     * Reads every picture sample of [file] without decoding any. Null when the file will not open or
     * has no picture track. A fragmented file declares no length of its own, so its declared end is
     * where its last complete fragment's pictures end, and a cut-off fragment reads as not completed.
     */
    fun read(file: File): PartReading? {
        val reader = FragmentedMp4Reader.read(file) ?: return null
        val video = reader.video ?: return null
        val first = video.firstSeconds ?: return PartReading(0.0, 0.0, 0.0, false)
        val end = video.endSeconds ?: first
        return PartReading(first, end, end, reader.complete)
    }

    /** What an export did. */
    data class Result(val plan: Plan, val file: File)

    /**
     * Writes the take's programme to [output]: [parts] are its files in part order, [anchors] its
     * anchors, the window the take's start and end on the wall clock. [silentPacket] is one AAC packet
     * of silence for the holes ([SilentAac.packet]).
     */
    fun export(
        parts: List<File>,
        anchors: List<RecordingCatalog.ProgramAnchor>,
        resumeCount: Int,
        windowStart: Double,
        windowEnd: Double?,
        frameRate: Int,
        silentPacket: ByteArray,
        output: File
    ): Result {
        val existing = parts.filter { it.isFile && it.length() > 0 }
        val plan = plan(
            partCount = existing.size,
            resumeCount = resumeCount,
            anchors = anchors,
            reading = existing.singleOrNull()?.let(::read),
            windowStart = windowStart,
            windowEnd = windowEnd,
            frameRate = frameRate
        )
        output.parentFile?.mkdirs()
        if (plan is Plan.Copy) {
            existing.single().copyTo(output, overwrite = true)
            return Result(plan, output)
        }
        val starts = RecordingCatalog.partStarts(anchors)
        val placed = existing.mapIndexedNotNull { index, file ->
            val part = partNumber(file) ?: (index + 1)
            val start = starts[part] ?: return@mapIndexedNotNull null
            start to file
        }.sortedBy { it.first }
        place(placed, windowStart, windowEnd, silentPacket, output)
        return Result(plan, output)
    }

    /** A part's number from its file name: `program-…-N.mp4` is part N, and no suffix is part 1. */
    fun partNumber(file: File): Int? {
        val stem = file.nameWithoutExtension
        val suffix = Regex("""^program-\d{8}-\d{6}(?:-(\d+))?$""").find(stem) ?: return null
        return suffix.groupValues[1].toIntOrNull() ?: 1
    }

    /**
     * Lays every part's samples at its wall start, counted from the output's head: [windowStart], or
     * the first part's start when that is earlier. A phone's first part opens on a picture captured a
     * picture delay before Record, so it starts before the take; counted from the window, its pictures
     * went before 0 while its sound was cut at 0, and a reader that ignores the edit list (the
     * server's remux) found the two starting apart. From the earlier head both tracks start together,
     * as a copied part's do. A picture lasts until the next one, so across a hole the last picture
     * before it is held as one sample; the sound is contiguous, with [silentPacket]s across every hole
     * and out to the end. The last picture and the sound both run to [windowEnd], or to where the last
     * part ends.
     */
    fun place(parts: List<Pair<Double, File>>, windowStart: Double, windowEnd: Double?, silentPacket: ByteArray, output: File) {
        val readings = parts.map { (start, file) -> Triple(start, file, FragmentedMp4Reader.read(file)) }
        val readers = readings.mapNotNull { (start, _, reader) -> reader?.let { start to it } }
        require(readers.isNotEmpty()) {
            "no readable programme part: " + readings.joinToString { (_, file, _) -> "${file.name} is not an MP4 with tracks" }
        }
        val sourceVideo = readers.firstNotNullOfOrNull { it.second.video?.takeIf { track -> track.configuration != null } }
        val sourceAudio = readers.firstNotNullOfOrNull { it.second.audio?.takeIf { track -> track.configuration != null } }
        // Priming is not sound: the first part's is skipped with the edit list, as in the part itself.
        val priming = sourceAudio?.mediaTime ?: 0L
        val writer = FragmentedMp4Writer(
            output,
            sourceVideo?.let {
                FragmentedMp4Writer.VideoTrack(
                    codec = if (it.sampleEntry == "avc1") StreamCodec.H264 else StreamCodec.HEVC,
                    width = it.width,
                    height = it.height,
                    decoderConfiguration = it.configuration!!
                )
            },
            sourceAudio?.let {
                FragmentedMp4Writer.AudioTrack(
                    it.configuration!!,
                    sampleRate = it.timescale,
                    channels = maxOf(1, it.channels),
                    primingSamples = priming.toInt()
                )
            }
        )
        val packet = FragmentedMp4Writer.StreamPacketSamples.toDouble() / (sourceAudio?.timescale ?: 48_000)
        val head = minOf(windowStart, readers.minOf { it.first })
        var lastPicture = Double.NEGATIVE_INFINITY
        // Where the sound written so far ends, on the output's timeline, priming included.
        var soundEnd = -(sourceAudio?.let { priming.toDouble() / it.timescale } ?: 0.0)
        var pictureEnd = 0.0
        var end = 0.0
        for ((start, reader) in readers) {
            val offset = start - head
            // One sample in memory at a time, read from the part as it is written out.
            reader.samples().use { source ->
                reader.video?.let { track ->
                    for (sample in track.samples) {
                        val at = offset + sample.ticks.toDouble() / track.timescale
                        if (at <= lastPicture) continue
                        if (writer.writeVideo(source.read(sample), at, sample.sync)) lastPicture = at
                        pictureEnd = maxOf(pictureEnd, at + sample.duration.toDouble() / track.timescale)
                    }
                }
                reader.audio?.let { track ->
                    var at = offset - track.mediaTime.toDouble() / track.timescale
                    while (soundEnd + packet / 2 < at) {
                        writer.writeAudio(silentPacket)
                        soundEnd += packet
                    }
                    for (sample in track.samples) {
                        // A packet the sound has already passed (parts that overlap) is left out.
                        if (at >= soundEnd - packet / 2) {
                            writer.writeAudio(source.read(sample))
                            soundEnd += packet
                        }
                        at += sample.duration.toDouble() / track.timescale
                    }
                    end = maxOf(end, soundEnd)
                }
            }
        }
        // The window's end when the take has one; otherwise wherever the last part's media ends.
        val finalEnd = windowEnd?.let { it - head } ?: maxOf(pictureEnd, end)
        if (sourceAudio != null) {
            while (soundEnd + packet / 2 < finalEnd) {
                writer.writeAudio(silentPacket)
                soundEnd += packet
            }
        }
        writer.finish(if (lastPicture.isFinite()) maxOf(1e-3, maxOf(finalEnd, pictureEnd) - lastPicture) else null)
    }
}
