package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.encode.NALUnitConversion
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.BasicMediaTelemetry
import app.teamstation.streamcore.stream.StreamAudioEncoding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.util.Locale

/**
 * Scenario E7: the Kotlin recording path end to end on the JVM, run by `scripts/recordingExport.mjs`
 * and skipped everywhere else.
 *
 * A take records 30 s of an HEVC 1920×1080 clip ffmpeg made, with jittered capture times and the mix
 * beside it; the app is killed (what was not yet flushed is lost, as it would be); 10 s later the take
 * is picked up as part 2 and records 30 s more; Stop fills the hold; and the programme is exported.
 * Everything from the grid to the catalog, the fragmented MP4 and the export is the real code, on
 * clocks the test moves. The script checks the export with ffprobe.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingExportTest {
    private val directory = System.getenv("TS_RECORDING_E2E_DIR")?.let(::File)
    private val log = System.getenv("TS_RECORDING_E2E_LOG")?.let(::File)

    private fun note(line: String) {
        println(line)
        log?.appendText("$line\n")
    }

    private class Picture(val units: List<ByteArray>, val keyframe: Boolean)

    private fun pictures(file: File): Pair<List<Picture>, List<ByteArray>> {
        val sets = mutableListOf<ByteArray>()
        val pictures = mutableListOf<Picture>()
        var current = mutableListOf<ByteArray>()
        for (unit in NALUnitConversion.elementaryUnitsFromAnnexB(file.readBytes())) {
            val type = (unit[0].toInt() ushr 1) and 0x3F
            if (type in 32..34 && sets.none { (it[0].toInt() ushr 1) and 0x3F == type }) sets += unit
            if (type >= 32) continue
            if (unit.size > 2 && unit[2].toInt() and 0x80 != 0 && current.isNotEmpty()) {
                pictures += Picture(current, current.any { ((it[0].toInt() ushr 1) and 0x3F) in 16..21 })
                current = mutableListOf()
            }
            current += unit
        }
        pictures += Picture(current, current.any { ((it[0].toInt() ushr 1) and 0x3F) in 16..21 })
        return pictures to sets
    }

    private fun aac(file: File): List<ByteArray> {
        val bytes = file.readBytes()
        val packets = mutableListOf<ByteArray>()
        var at = 0
        while (at + 7 <= bytes.size) {
            val header = if (bytes[at + 1].toInt() and 1 == 0) 9 else 7
            val length = ((bytes[at + 3].toInt() and 0x03) shl 11) or ((bytes[at + 4].toInt() and 0xFF) shl 3) or
                ((bytes[at + 5].toInt() and 0xE0) ushr 5)
            packets += bytes.copyOfRange(at + header, at + length)
            at += length
        }
        return packets
    }

    /** ffmpeg's AAC of a tone, one packet per 1024 samples of mix, in order: the encoder's stand-in. */
    private class Replay(private val packets: List<ByteArray>) : StreamAudioEncoding {
        override val audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
        override val primingSamples = 0
        private var samples = 0
        private var next = 0
        override fun encode(samples: ShortArray): List<ByteArray> {
            this.samples += samples.size / 2
            val out = mutableListOf<ByteArray>()
            while (this.samples >= 1024) {
                this.samples -= 1024
                out += packets[next % packets.size]
                next += 1
            }
            return out
        }
        override fun reset() {
            samples = 0
            next = 0
        }
        override fun close() = Unit
    }

    @Test
    fun aTakeWithAHoleAndAResumeExportsToItsWallLength() {
        assumeTrue("TS_RECORDING_E2E_DIR holds the clip scripts/recordingExport.mjs makes", directory?.isDirectory == true)
        val dir = directory!!
        val (clip, sets) = pictures(File(dir, "fixture.h265"))
        val tone = aac(File(dir, "fixture.aac"))
        val silent = SilentAac.packet(Replay(aac(File(dir, "silence.aac"))))!!
        note("clip: ${clip.size} pictures, ${clip.count { it.keyframe }} keyframes, ${tone.size} AAC packets; silent packet ${silent.size} bytes")

        val takeStart = 1_760_000_000.0
        var wall = takeStart
        var host = 5_000.0
        val work = File(dir, "take").apply { deleteRecursively(); mkdirs() }
        val catalog = RecordingCatalog(File(work, "index.sqlite"))
        val settings = RecordingSettings(EncodeSettings())
        fun session() = RecordingSession(
            catalog,
            ProgramEncoder(BasicMediaTelemetry(), settings.programme, File(work, "programme"), { wall }, { host }, { Replay(tone) }),
            clock = { wall }
        )

        /** [seconds] at 30 fps, capture times jittered by up to 4 ms, the mix 60 ms behind. */
        fun record(session: RecordingSession, seconds: Int) {
            val encoder = session.encoder
            var index = 0
            var mix = wall - 0.06
            var placed = 0
            var waitingForKey = true
            repeat(seconds * 30) { frame ->
                wall += 1.0 / 30
                host += 1.0 / 30
                val jitter = listOf(0.0, 0.004, -0.003, 0.002)[frame % 4]
                val slot = encoder.append(presentationTime = host + jitter, captureWall = wall - 0.03 + jitter)
                if (slot != null) {
                    val picture = clip[index % clip.size]
                    index += 1
                    if (!(waitingForKey && !picture.keyframe)) {
                        waitingForKey = false
                        encoder.appendEncoded(EncodedVideoFrame(picture.units, if (picture.keyframe) sets else emptyList(), picture.keyframe, slot))
                        placed += 1
                    }
                }
                while (mix + 0.02 <= wall - 0.06) {
                    encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = mix))
                    mix += 0.02
                }
            }
            note("  recorded $seconds s: $placed pictures placed, wall now %.3f".format(Locale.US, wall - takeStart))
        }

        // Part 1, then a kill 30 s in: nothing finishes, and what was not flushed is lost.
        val first = session()
        val id = first.open(wall, settings)
        first.startProgramme(wall, settings)
        first.beginLiveSession(recording = id) { true }
        record(first, 30)
        first.beatLiveSession(isLive = true)
        first.encoder.abandonForTesting()
        first.stopHeartbeat()
        val partOne = first.encoder.outputFile!!
        FragmentedMp4Reader.read(partOne)!!.let {
            note("killed at 30.000 s: part 1 keeps ${it.fragments} fragments, pictures to %.3f s, sound to %.3f s".format(Locale.US, it.video!!.endSeconds, it.audio!!.endSeconds))
        }

        // Ten seconds away, then the take comes back as part 2 and records 30 s more.
        wall += 10
        host += 10
        val plan = LiveSessionResume.plan(catalog, now = wall)!!
        note("relaunch: ${plan.banner(LiveSessionResume.defaultLimitSeconds)}")
        val take = (plan.outcome as LiveSessionResume.Outcome.Resume).recording!!
        val second = session()
        second.resume(take, wall, settings)
        record(second, 30)
        second.detachAnchors()
        val stop = wall
        second.finishProgramme(until = stop)
        second.close(endedAt = stop)
        val row = catalog.recording(id)!!
        note("stopped at %.3f s: parts ${row.programFilenames}, resumed ${row.resumeCount} time(s)".format(Locale.US, stop - takeStart))
        for (check in row.soundChecks) note("  part ${check.part} sound check: picture %.3f s, sound %.3f s, ${check.samples} packets".format(Locale.US, check.pictureSeconds, check.soundSeconds))
        val starts = catalog.programPartStarts(id)
        for ((part, start) in starts.toSortedMap()) note("  part $part starts at %.3f s on the take's wall clock".format(Locale.US, start - takeStart))

        val output = File(dir, "kotlin-recording-export.mp4")
        val result = ProgrammeExport.export(
            parts = row.programFilenames.map { File(work, "programme/$it") },
            anchors = catalog.programAnchors(id),
            resumeCount = row.resumeCount,
            windowStart = takeStart,
            windowEnd = stop,
            frameRate = 30,
            silentPacket = silent,
            output = output
        )
        catalog.close()
        note("export: ${result.plan.description} -> ${output.name}")
        val reader = FragmentedMp4Reader.read(output)!!
        val video = reader.video!!
        val audio = reader.audio!!
        val held = video.samples.maxByOrNull { it.duration }!!
        note(
            "export spans: video %.3f..%.3f s (%d pictures), audio %.3f..%.3f s (%d packets); longest picture %.3f s at %.3f s"
                .format(
                    Locale.US, video.firstSeconds, video.endSeconds, video.samples.size, audio.firstSeconds, audio.endSeconds,
                    audio.samples.size, held.duration / 90_000.0, held.ticks / 90_000.0
                )
        )
        File(dir, "silent.aac.raw").writeBytes(silent)
        val wallLength = stop - takeStart
        assertEquals(70.0, wallLength, 1e-3)
        assertEquals(0.0, video.firstSeconds!!, 1.0 / 30)
        assertEquals(wallLength, video.endSeconds!!, 1.0 / 30)
        assertEquals(0.0, audio.firstSeconds!!, 1.0 / 30)
        assertEquals(wallLength, audio.endSeconds!!, 1.0 / 30)
        assertTrue("the hole is one held picture", held.duration / 90_000.0 > 10.0)
        val holeStart = held.ticks / 90_000.0 + 1.0 / 30
        val holeEnd = (held.ticks + held.duration) / 90_000.0
        val inHole = audio.samples.filter { it.ticks / 48_000.0 in (holeStart + 0.05)..(holeEnd - 0.05) }
        assertTrue(inHole.isNotEmpty() && inHole.all { reader.read(it).contentEquals(silent) })
        note("hole: %.3f..%.3f s held as one picture, %d silent AAC packets".format(Locale.US, holeStart, holeEnd, inHole.size))
    }
}
