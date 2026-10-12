package app.teamstation.streamcore.record

import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.BasicMediaTelemetry
import app.teamstation.streamcore.stream.StreamAudioEncoding
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** One AAC packet per 1024 samples of mix, holding its index; what is left over comes out at the end. */
class CountingAac : StreamAudioEncoding {
    override val audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
    override val primingSamples = 0
    private var samples = 0
    var packets = 0
        private set

    override fun encode(samples: ShortArray): List<ByteArray> {
        this.samples += samples.size / 2
        val out = mutableListOf<ByteArray>()
        while (this.samples >= 1024) {
            this.samples -= 1024
            out += byteArrayOf(0x21, (packets and 0xFF).toByte())
            packets += 1
        }
        return out
    }

    override fun finish(): List<ByteArray> = if (samples > 0) {
        samples = 0
        packets += 1
        listOf(byteArrayOf(0x21, 0x7F))
    } else {
        emptyList()
    }

    override fun reset() {
        samples = 0
        packets = 0
    }

    override fun close() = Unit
}

/**
 * [ProgramEncoder] driven the way a host drives it: a picture is placed with [ProgramEncoder.append]
 * and its coded form handed back with [ProgramEncoder.appendEncoded], on clocks the test moves.
 */
class ProgramEncoderTest {
    @get:Rule
    val folder = TemporaryFolder()

    private var wall = 1_000.0
    private var host = 50.0
    private val telemetry = object : BasicMediaTelemetry() {
        val errors = mutableListOf<String>()
        override fun recordError(message: String) {
            super.recordError(message)
            errors += message
        }
    }
    private val anchors = mutableListOf<RecordingCatalog.ProgramAnchor>()
    private val checks = mutableListOf<ProgramSoundCheck>()

    private fun encoder(settings: EncodeSettings = EncodeSettings()) =
        ProgramEncoder(telemetry, settings, folder.root, clock = { wall }, uptime = { host }, audioEncoderFactory = { CountingAac() }).apply {
            setAnchorSink { recording, part, seconds, at -> anchors += RecordingCatalog.ProgramAnchor(part, seconds, at).also { assertEquals(7L, recording) } }
            setSoundCheckSink { _, check -> checks += check }
            setAnchorRecording(7)
        }

    private val parameterSets = listOf(FragmentedMp4WriterTest.vps, FragmentedMp4WriterTest.sps, FragmentedMp4WriterTest.pps)

    private fun frame(at: Double, key: Boolean) = EncodedVideoFrame(
        nalUnits = listOf(if (key) byteArrayOf(0x26, 0x01, 1) else byteArrayOf(0x02, 0x01, 2)),
        parameterSets = if (key) parameterSets else emptyList(),
        isKeyframe = key,
        presentationTime = at
    )

    /**
     * [seconds] of the programme at 30 fps with the mix beside it, both a twentieth of a second old
     * when they arrive. Answers how many pictures were placed.
     */
    private fun record(encoder: ProgramEncoder, seconds: Double, jitter: (Int) -> Double = { 0.0 }): Int {
        var placed = 0
        val frames = (seconds * 30).toInt()
        var mixWall = wall - 0.05
        for (index in 0 until frames) {
            wall += 1.0 / 30
            host += 1.0 / 30
            val slot = encoder.append(presentationTime = host + jitter(index), captureWall = wall - 0.05)
            if (slot != null) {
                placed += 1
                encoder.appendEncoded(frame(slot, key = placed % 60 == 1))
            }
            while (mixWall + 0.02 <= wall - 0.05) {
                encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = mixWall))
                mixWall += 0.02
            }
        }
        return placed
    }

    @Test
    fun aTakeIsPlacedOnTheGridAnchoredAndFilledToItsEnd() {
        val encoder = encoder()
        encoder.start(wall)
        val file = encoder.outputFile!!
        assertTrue(file.name.matches(Regex("""program-\d{8}-\d{6}\.mp4""")))
        assertTrue(encoder.running)
        // A capture clock jittering by a few milliseconds never moves a picture off its slot.
        val placed = record(encoder, 10.0) { index -> listOf(0.0, 0.004, -0.004)[index % 3] }
        assertEquals(300, placed)
        assertEquals(300L, encoder.frameCount)
        assertEquals(listOf(0.0, 3.0, 6.0, 9.0), anchors.map { it.programSeconds })
        assertTrue(anchors.all { it.part == 1 })
        // Content wall: when the picture was captured, a twentieth of a second before it was placed.
        assertEquals(1_000.0 + 1.0 / 30 - 0.05, anchors[0].wall, 1e-9)

        assertEquals(file, encoder.finish(until = 1_000.0 + 10.5))
        assertFalse(encoder.running)
        val reader = FragmentedMp4Reader.read(file)!!
        assertEquals(300, reader.video!!.samples.size)
        // The last picture is held out to the take's end, and the sound runs to it.
        assertEquals(10.5, reader.video!!.endSeconds!!, 1e-6)
        assertEquals(10.5, reader.audio!!.endSeconds!!, 0.03)
        val check = checks.single()
        assertEquals(1, check.part)
        assertFalse(check.isShort)
        assertEquals(reader.audio!!.samples.size, check.samples)
        assertTrue(check.detail, check.detail.startsWith("target 10.500"))
        assertNotNull(telemetry.lastProgramFinish)
        assertNull(encoder.finish())
    }

    @Test
    fun aSecondPictureInOneSlotIsLeftOutAndAFastSourceFollowsRealTime() {
        val encoder = encoder()
        encoder.start(wall)
        assertEquals(0.0, encoder.append(presentationTime = 10.0)!!, 0.0)
        assertNull(encoder.append(presentationTime = 10.01))
        host += 1.0 / 30
        assertEquals(1.0 / 30, encoder.append(presentationTime = 10.0 + 1.0 / 30)!!, 1e-9)
        // A source running ten frames ahead is pulled back to real time's slot.
        host += 1.0 / 30
        assertEquals(2.0 / 30, encoder.append(presentationTime = 10.0 + 12.0 / 30)!!, 1e-9)
        // The programme clock's own frames take the slot their number names, late ones included.
        host += 0.5
        assertEquals(3.0 / 30, encoder.append(presentationTime = 10.0 + 13.0 / 30, onClockGrid = true)!!, 1e-9)
        // Pictures before the first keyframe with parameter sets cannot open the file.
        encoder.appendEncoded(frame(0.0, key = false))
        encoder.appendEncoded(EncodedVideoFrame(emptyList(), isKeyframe = true, presentationTime = 0.0))
        encoder.appendEncoded(frame(0.0, key = true).copy(parameterSets = emptyList()))
        assertEquals(0L, encoder.frameCount)
        encoder.configure(EncodeSettings(frameRate = 60))
        encoder.finish()
        assertNull(encoder.append(1.0))
        encoder.appendEncoded(frame(0.0, key = true))
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = wall))
    }

    /** A sink the test can make refuse. */
    private class GateSink : SoundSink {
        var ready = true
        var accept = true
        val runs = mutableListOf<Int>()
        override val isReadyForMoreSound get() = ready
        override fun appendSound(samples: ShortArray): Boolean {
            if (accept) runs += samples.size / 2
            return accept
        }
        override fun finishSound() = Unit
    }

    @Test
    fun soundIsLaidContiguouslyFromWhereTheTrackHasGot() {
        val encoder = encoder()
        val sink = GateSink()
        encoder.soundSinkOverride = sink
        encoder.start(wall)
        // Before the origin is settled, sound has nowhere to go.
        encoder.append(presentationTime = host, captureWall = wall)
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = wall))
        assertTrue(sink.runs.isEmpty())
        repeat(50) {
            wall += 1.0 / 30
            host += 1.0 / 30
            encoder.append(presentationTime = host, captureWall = wall)
        }
        // Sound for 0.1 s into the part: silence up to it first, then the run.
        val origin = 1_000.0
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + 0.1))
        assertEquals(listOf(1024, 1024, 1024, 1024, 1024, 960), sink.runs)
        val end = encoder.writtenSoundEndForTesting
        assertEquals(5 * 1024.0 / 48_000 + 0.02, end, 1e-9)
        // Sound for a moment the track has passed is dropped.
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + 0.0))
        assertEquals(1, encoder.audioBehindTrackForTesting)
        // A refusal costs latency, never position.
        sink.accept = false
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + end))
        assertEquals(end, encoder.writtenSoundEndForTesting, 0.0)
        sink.accept = true
        encoder.drainAudio(limit = 4)
        assertEquals(end + 0.02, encoder.writtenSoundEndForTesting, 1e-9)
        assertEquals(2, encoder.acceptedSoundCountForTesting)
        // A sink that is not ready holds the queue, which is bounded.
        sink.ready = false
        repeat(ProgramEncoder.maximumPendingAudio + 3) {
            encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + 1.0 + it * 0.02))
        }
        assertTrue(telemetry.errors.any { it.contains("sound queue overflowed") })
        encoder.soundSinkOverride = null
    }

    @Test
    fun aResumedPartIsTimedFromItsFirstPictureAndNeverReplacesAFile() {
        val first = encoder()
        first.start(wall)
        record(first, 3.0)
        first.finish(until = wall)
        val stem = first.outputFile!!.nameWithoutExtension
        // A part 2 that a crash left with no anchors is stepped over.
        File(folder.root, "$stem-2.mp4").writeBytes(byteArrayOf(1))
        anchors.clear()

        wall += 10.0
        val resumed = encoder()
        resumed.resume(startedAt = 1_000.0, nextPart = 2, wall = wall)
        assertEquals("$stem-3.mp4", resumed.outputFile!!.name)
        assertTrue(runCatching { resumed.resume(1_000.0, 2, wall) }.isFailure)
        // The cameras come back two seconds after the resume.
        wall += 2.0
        host += 2.0
        record(resumed, 4.0)
        assertTrue(anchors.all { it.part == 3 })
        val file = resumed.finish(until = 1_000.0 + 20.0)!!
        val reader = FragmentedMp4Reader.read(file)!!
        // The part began at its first picture, 15 s and a frame into the take, and runs to 20 s.
        assertEquals(20.0 - (1_015.0 + 1.0 / 30 - 1_000.0), reader.video!!.endSeconds!!, 1e-3)
        assertEquals(3, checks.last().part)
    }

    @Test
    fun anH264MasterAndATakeWithNoPicture() {
        val encoder = encoder(EncodeSettings(codec = StreamCodec.H264, width = 640, height = 360))
        encoder.start(wall)
        val slot = encoder.append(presentationTime = host)!!
        encoder.appendEncoded(EncodedVideoFrame(listOf(byteArrayOf(0x65, 1)), listOf(byteArrayOf(0x67, 0x42, 0, 0x1F), byteArrayOf(0x68, 1)), true, slot))
        assertEquals(1L, encoder.frameCount)
        encoder.finish(until = wall + 2)
        assertEquals("avc1", FragmentedMp4Reader.read(encoder.outputFile!!)!!.video!!.sampleEntry)

        // No picture ever came: the part has no file content, and no anchor named a take to check.
        val before = checks.size
        val empty = encoder()
        empty.start(wall)
        assertEquals(0L, empty.finish(until = wall + 5)!!.length())
        assertEquals(before, checks.size)
    }

    @Test
    fun aKilledPartKeepsEveryFragmentItWrote() {
        val encoder = encoder()
        encoder.start(wall)
        record(encoder, 10.0)
        encoder.abandonForTesting()
        val reader = FragmentedMp4Reader.read(encoder.outputFile!!)!!
        assertTrue(reader.complete)
        assertEquals(3, reader.fragments)
        assertEquals(9.0, reader.video!!.endSeconds!!, 1e-6)
        assertNull(encoder.finish())
    }
}
