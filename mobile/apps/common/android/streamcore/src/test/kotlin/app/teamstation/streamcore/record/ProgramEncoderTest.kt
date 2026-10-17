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
import java.util.concurrent.Executor

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

    private fun encoder(settings: EncodeSettings = EncodeSettings(), syncExecutor: Executor = Executor(Runnable::run)) =
        ProgramEncoder(
            telemetry, settings, folder.root, clock = { wall }, uptime = { host }, audioEncoderFactory = { CountingAac() }, syncExecutor = syncExecutor
        ).apply {
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
        // Every fragment was forced to storage, outside the lock the pictures and sound are written under.
        assertFalse(encoder.writerHasPendingSyncForTesting)
        val reader = FragmentedMp4Reader.read(file)!!
        assertEquals(300, reader.video!!.samples.size)
        // The last picture is held out to the take's end on the wall clock, counted from where the
        // part's timeline starts: its first picture was captured a twentieth of a second before it was
        // placed, a frame after the take started, so the take ends 10.517 s into the part. The hold
        // runs to the grid frame at or after that, and the sound with it.
        assertEquals(10.5 + 1.0 / 30, reader.video!!.endSeconds!!, 1e-6)
        assertEquals(10.5 + 1.0 / 30, reader.audio!!.endSeconds!!, 0.03)
        val check = checks.single()
        assertEquals(1, check.part)
        assertFalse(check.isShort)
        assertEquals(reader.audio!!.samples.size, check.samples)
        assertTrue(check.detail, check.detail.startsWith("target 10.517"))
        assertNotNull(telemetry.lastProgramFinish)
        assertNull(encoder.finish())
    }

    @Test
    fun repeatsOnTheProgrammeGridLeaveTheSoundOriginToFreshPictures() {
        val encoder = encoder()
        encoder.start(wall)
        // Two seconds of a 30 fps grid, each fresh picture captured 0.15 s before its tick, and a
        // repeat after every fresh picture handed over 20 ms late, which would imply a later origin.
        val start = wall
        for (frame in 0 until 60) {
            val fresh = frame % 2 == 0
            if (!fresh) {
                host += 0.02
                wall += 0.02
            }
            encoder.append(frame.toDouble() / 30, captureWall = if (fresh) wall - 0.15 else null, onClockGrid = true)
            host += 1.0 / 30 - if (fresh) 0.0 else 0.02
            wall += 1.0 / 30 - if (fresh) 0.0 else 0.02
        }
        assertEquals(start - 0.15, encoder.soundOriginForTesting!!, 1e-6)
        encoder.finish()
    }

    @Test
    fun repeatsThatCarryTheirHeldCaptureTimeStillLeaveTheSoundOriginToFreshPictures() {
        val encoder = encoder()
        encoder.start(wall)
        // As above, but each repeat carries a capture time that would imply an origin 0.1 s later.
        val start = wall
        for (frame in 0 until 60) {
            val fresh = frame % 2 == 0
            val capture = if (fresh) wall - 0.15 else wall - 0.05
            encoder.append(frame.toDouble() / 30, captureWall = capture, onClockGrid = true, repeat = !fresh)
            host += 1.0 / 30
            wall += 1.0 / 30
        }
        assertEquals(start - 0.15, encoder.soundOriginForTesting!!, 1e-6)
        encoder.finish()
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
        // Before the origin is settled, sound is held rather than written.
        encoder.append(presentationTime = host, captureWall = wall)
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = wall))
        assertTrue(sink.runs.isEmpty())
        repeat(50) {
            wall += 1.0 / 30
            host += 1.0 / 30
            encoder.append(presentationTime = host, captureWall = wall)
        }
        // The held run goes at the head of the track. Sound for 0.1 s into the part: silence up to it
        // first, then the run.
        val origin = 1_000.0
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + 0.1))
        assertEquals(listOf(960, 1024, 1024, 1024, 1024, 960), sink.runs)
        val end = encoder.writtenSoundEndForTesting
        assertEquals(4 * 1024.0 / 48_000 + 0.04, end, 1e-9)
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
        assertEquals(3, encoder.acceptedSoundCountForTesting)
        // A sink that is not ready holds the queue, which is bounded.
        sink.ready = false
        repeat(ProgramEncoder.maximumPendingAudio + 3) {
            encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = origin + 1.0 + it * 0.02))
        }
        assertTrue(telemetry.errors.any { it.contains("sound queue overflowed") })
        encoder.soundSinkOverride = null
    }

    /** Twenty milliseconds of the mix: a quiet tone, or silence. */
    private fun run(wall: Double, loud: Boolean = true) =
        AudioFrame(ShortArray(960 * 2) { if (loud) 800 else 0 }, wallClock = wall)

    /**
     * A phone's recording mix waits one second against an opening sampled for one and a half, so the
     * start of its part reaches the encoder before the origin is known. Dropped, it left the first half
     * second or more of every phone take coded silence; held, the track starts with it. TS Director's
     * `soundBeforeTheOriginIsHeld`.
     */
    @Test
    fun soundBeforeTheOriginIsHeldAndPlacedWhenItSettles() {
        val encoder = encoder()
        val sink = GateSink()
        encoder.soundSinkOverride = sink
        // Captured five seconds ago, so each picture's age reads as its content lag and the part's
        // origin is `origin` exactly.
        val origin = wall - 5
        encoder.start(origin)
        fun pictures(range: IntRange) {
            for (index in range) encoder.append(index.toDouble() / 30, captureWall = origin + index.toDouble() / 30, onClockGrid = true)
        }
        fun sound(range: IntRange) {
            for (index in range) encoder.append(run(origin + index * 0.02))
        }

        // A third of a second of picture, then the part's first second of sound, all before the origin
        // has had its 1.5 s: none of it can be placed yet, and none of it is written.
        pictures(0 until 10)
        sound(0 until 50)
        assertTrue(encoder.soundDiagnosticsForTesting.origin < 0)
        assertTrue(sink.runs.isEmpty())
        // The opening settles, and the held second goes in at the head of the track, ahead of what
        // follows.
        pictures(10 until 60)
        sound(50 until 100)

        val d = encoder.soundDiagnosticsForTesting
        assertEquals(origin, d.origin, 1e-6)
        assertEquals(100, d.offered)
        assertEquals(50, d.unseeded)
        assertEquals(0, d.beforePart)
        assertEquals("chunks of silence ahead of the sound", 0, d.silence)
        assertEquals(0.0, d.first, 1e-6)
        assertEquals(List(100) { 960 }, sink.runs)
        assertEquals(100, encoder.acceptedSoundCountForTesting)
        assertEquals(2.0, encoder.writtenSoundEndForTesting, 1e-9)
        encoder.soundSinkOverride = null
        encoder.finish()
    }

    /**
     * TS Director's mix waits far longer than the opening, so what reaches it that early was captured
     * before the part began: held, it is still left out once the origin says so.
     */
    @Test
    fun heldSoundThatBelongsBeforeThePartIsLeftOut() {
        val encoder = encoder()
        val sink = GateSink()
        encoder.soundSinkOverride = sink
        val origin = wall - 5
        encoder.start(origin)
        encoder.append(0.0, captureWall = origin, onClockGrid = true)
        // Captured four seconds before the part began.
        for (index in 0 until 50) encoder.append(run(origin - 4 + index * 0.02))
        for (index in 1 until 60) encoder.append(index.toDouble() / 30, captureWall = origin + index.toDouble() / 30, onClockGrid = true)
        val d = encoder.soundDiagnosticsForTesting
        assertEquals(50, d.unseeded)
        assertEquals(50, d.beforePart)
        assertEquals(-1.0, d.first, 0.0)
        assertEquals(0, encoder.acceptedSoundCountForTesting)
        encoder.drainAudio(limit = 8)
        assertTrue(sink.runs.isEmpty())
        encoder.soundSinkOverride = null
        encoder.finish()
    }

    /** One AAC packet per 1024 samples of mix, saying whether any of them was sound. */
    private class MarkingAac : StreamAudioEncoding {
        override val audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
        override val primingSamples = 0
        private val pending = mutableListOf<Short>()

        override fun encode(samples: ShortArray): List<ByteArray> {
            pending += samples.asList()
            val out = mutableListOf<ByteArray>()
            while (pending.size >= 1024 * 2) {
                val packet = pending.subList(0, 1024 * 2)
                out += byteArrayOf(0x21, if (packet.any { it.toInt() != 0 }) 1 else 0)
                packet.clear()
            }
            return out
        }

        override fun finish(): List<ByteArray> = if (pending.isEmpty()) emptyList() else listOf(byteArrayOf(0x21, 0)).also { pending.clear() }

        override fun reset() = pending.clear()

        override fun close() = Unit
    }

    /**
     * Q10 on the phone's own timing: pictures a picture delay (0.15 s) old when the programme places
     * them, the recording's mix handing each run over a second after it was captured, and the room's
     * sound from before Record. The first sound in the file sits within one AAC packet of where its
     * capture puts it, the head of the part, and the track has no silent packet after it.
     */
    @Test
    fun aPhoneTakeHasTheRoomsSoundFromItsFirstPacket() {
        val encoder = ProgramEncoder(telemetry, EncodeSettings(), folder.root, clock = { wall }, uptime = { host }, audioEncoderFactory = { MarkingAac() })
        val record = wall
        encoder.start(record)
        // The mix has been running since the screen opened, two seconds before Record.
        var mixWall = record - 2.0
        var origin: Double? = null
        var firstCaptured: Double? = null
        for (index in 0 until 4 * 30) {
            wall += 1.0 / 30
            host += 1.0 / 30
            val slot = encoder.append(presentationTime = host, captureWall = wall - 0.15)
            if (slot != null) encoder.appendEncoded(frame(slot, key = index % 60 == 0))
            if (origin == null) origin = wall - 0.15
            while (mixWall + 0.02 <= wall - 1.0) {
                encoder.append(run(mixWall))
                if (firstCaptured == null && mixWall >= origin) firstCaptured = mixWall
                mixWall += 0.02
            }
        }
        // The opening's sound came while the origin was being sampled.
        assertTrue(encoder.soundDiagnosticsForTesting.unseeded > 0)
        val file = encoder.finish(until = wall)!!
        val packet = 1024.0 / 48_000
        val audio = FragmentedMp4Reader.read(file)!!.audio!!
        val marks = FragmentedMp4Reader.read(file)!!.samples().use { source -> audio.samples.map { source.read(it)[1].toInt() } }
        val heard = marks.indexOf(1)
        assertTrue("no sound in the file", heard >= 0)
        val firstHeard = heard * packet
        val placed = firstCaptured!! - origin!!
        assertEquals("first heard at $firstHeard s, captured for $placed s", placed, firstHeard, packet)
        assertTrue("first heard at $firstHeard s", firstHeard < 0.05)
        // From there on the room is never silent until the sound the mix had not yet handed over.
        val heardUntil = marks.lastIndexOf(1)
        assertTrue(marks.subList(heard, heardUntil + 1).all { it == 1 })
        assertTrue("sound ends at ${(heardUntil + 1) * packet} s", (heardUntil + 1) * packet > 4.0 - 1.0 - 0.15 - packet)
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
        // The part began at its first picture, captured a twentieth of a second before it was placed
        // 15 s and a frame into the take, and runs to 20 s on the wall clock.
        val target = 20.0 - (1_015.0 + 1.0 / 30 - 0.05 - 1_000.0)
        assertTrue(reader.video!!.endSeconds!! >= target - 1e-6)
        assertEquals(target, reader.video!!.endSeconds!!, 1.0 / 30)
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

    /** An AAC encoder that, like MediaCodec, says its configuration and priming only once it has made a packet. */
    private class LateReportingAac : StreamAudioEncoding {
        private val counting = CountingAac()
        override var audioSpecificConfig = byteArrayOf(0x11, 0x90.toByte())
            private set
        override var primingSamples = 2048
            private set

        override fun encode(samples: ShortArray): List<ByteArray> = counting.encode(samples).also { report(it) }
        override fun finish(): List<ByteArray> = counting.finish().also { report(it) }
        private fun report(packets: List<ByteArray>) {
            if (packets.isEmpty()) return
            audioSpecificConfig = byteArrayOf(0x12, 0x10)
            primingSamples = 1024
        }

        override fun reset() = counting.reset()
        override fun close() = Unit
    }

    @Test
    fun thePartsSoundTrackSaysWhatTheEncoderReportsOnceItHasMadeSound() {
        val encoder = ProgramEncoder(telemetry, EncodeSettings(), folder.root, clock = { wall }, uptime = { host }, audioEncoderFactory = { LateReportingAac() })
        encoder.start(wall)
        record(encoder, 2.0)
        val file = encoder.finish(until = wall)!!
        val audio = FragmentedMp4Reader.read(file)!!.audio!!
        assertEquals(listOf<Byte>(0x12, 0x10), audio.configuration!!.toList())
        assertEquals(1024L, audio.mediaTime)
    }

    @Test
    fun aPartWhoseFileCannotBeOpenedSaysSoOnceAndFinishesClean() {
        val encoder = encoder()
        val failures = mutableListOf<String>()
        encoder.onWriterFailure = { failures += it }
        encoder.start(wall)
        // Something else took the part's name: its file cannot be opened for writing.
        val file = encoder.outputFile!!
        file.delete()
        file.mkdirs()
        record(encoder, 2.0)
        assertEquals(1, failures.size)
        assertTrue(failures.single(), failures.single().startsWith("program writer failed"))
        assertEquals(0L, encoder.frameCount)
        assertEquals(file, encoder.finish(until = wall))
        assertFalse(encoder.running)
        assertEquals(1, failures.size)
    }

    @Test
    fun aPartThatStopsTakingWritesKeepsWhatItWroteAndFinishes() {
        val encoder = encoder()
        val failures = mutableListOf<String>()
        encoder.onWriterFailure = { failures += it }
        encoder.start(wall)
        record(encoder, 4.0)
        val written = encoder.frameCount
        // The storage refuses: the next write throws, as a full disk's would.
        encoder.soundSinkOverride = object : SoundSink {
            override val isReadyForMoreSound = true
            override fun appendSound(samples: ShortArray): Boolean = throw java.io.IOException("No space left on device")
            override fun finishSound() = Unit
        }
        record(encoder, 2.0)
        assertEquals(listOf("program writer failed: No space left on device"), failures)
        // Nothing more went into the part once it failed: the picture before the refused sound is the last.
        assertEquals(written + 1, encoder.frameCount)
        encoder.soundSinkOverride = null
        val file = encoder.finish(until = wall)!!
        val reader = FragmentedMp4Reader.read(file)!!
        assertTrue(reader.complete)
        assertEquals(3.0, reader.video!!.endSeconds!!, 1e-6)
        assertTrue(telemetry.errors.any { it.startsWith("program writer failed") })
    }

    @Test
    fun aSoundCodecThatThrowsEndsThePartAndItsFinishStillCloses() {
        val encoder = encoder()
        val failures = mutableListOf<String>()
        encoder.onWriterFailure = { failures += it }
        encoder.start(wall)
        record(encoder, 4.0)
        // The AAC codec dies as the part finishes: its encode throws a runtime error, not an I/O one.
        encoder.soundSinkOverride = object : SoundSink {
            override val isReadyForMoreSound = true
            override fun appendSound(samples: ShortArray): Boolean = throw IllegalStateException("codec released")
            override fun finishSound() = Unit
        }
        encoder.append(AudioFrame(ShortArray(960 * 2), wallClock = wall - 0.05))
        val file = encoder.finish(until = wall + 1.0)!!
        assertFalse(encoder.running)
        assertEquals(listOf("program writer failed: codec released"), failures)
        assertTrue(FragmentedMp4Reader.read(file)!!.video!!.samples.isNotEmpty())
        // The next part opens: nothing was left running.
        encoder.soundSinkOverride = null
        encoder.start(wall)
        assertTrue(encoder.running)
        encoder.finish()
    }

    @Test
    fun aStartWhileAPartIsRunningIsRefused() {
        val encoder = encoder()
        encoder.start(wall)
        val first = encoder.outputFile
        try {
            encoder.start(wall + 60)
            org.junit.Assert.fail("a second start was taken")
        } catch (error: IllegalStateException) {
            assertEquals("program writer is already running", error.message)
        }
        assertEquals(first, encoder.outputFile)
        encoder.finish()
    }

    @Test
    fun aPartWhoseFragmentsCannotBeForcedToStorageStops() {
        val encoder = encoder()
        val failures = mutableListOf<String>()
        encoder.onWriterFailure = { failures += it }
        encoder.forceToStorage = { throw java.io.SyncFailedException("sync failed") }
        encoder.start(wall)
        record(encoder, 4.0)
        assertTrue(failures.single(), failures.single().startsWith("program writer failed"))
        val written = encoder.frameCount
        record(encoder, 1.0)
        // Nothing more goes into a part whose fragments are not reaching storage.
        assertEquals(written, encoder.frameCount)
        encoder.finish(until = wall)
        assertFalse(encoder.running)
        assertEquals(1, failures.size)
    }

    @Test
    fun fragmentsAreForcedToStorageOnTheirOwnThreadAndCountOnlyOnceForced() {
        val queued = mutableListOf<Runnable>()
        val forcedOn = mutableListOf<Thread>()
        val encoder = encoder(syncExecutor = { queued += it })
        encoder.forceToStorage = { forcedOn += Thread.currentThread() }
        encoder.start(wall)
        record(encoder, 7.0)
        // Two fragments went to the file. Neither was forced on the thread that wrote it (the codec's
        // output or the phone's sound), and neither counts as written until it is.
        assertTrue(forcedOn.isEmpty())
        assertTrue(encoder.writerHasPendingSyncForTesting)
        // One force waits, however many fragments came meanwhile.
        assertEquals(1, queued.size)
        val worker = Thread { queued.removeAt(0).run() }
        worker.start()
        worker.join()
        assertEquals(listOf(worker), forcedOn)
        assertFalse(encoder.writerHasPendingSyncForTesting)
        record(encoder, 3.5)
        assertEquals(1, queued.size)
        // The finish forces the file itself; a force still waiting for a finished part does nothing.
        encoder.finish(until = wall)
        assertEquals(2, forcedOn.size)
        queued.removeAt(0).run()
        assertEquals(2, forcedOn.size)
    }
}
