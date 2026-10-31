package app.teamstation.streamcore.phonestream

import android.media.MediaFormat
import app.teamstation.streamcore.bitrate.AdaptiveBitrateController
import app.teamstation.streamcore.bitrate.AdaptiveBitrateLoop
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.record.SteadyWall
import app.teamstation.streamcore.stream.AudioFrame
import app.teamstation.streamcore.stream.MediaCodecStreamEncoder
import app.teamstation.streamcore.stream.StreamSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The parts of the phone engine that are not hardware-bound: the profile, the device's name and
 * capabilities, the capture clocks, the programme tick and the sound bus.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneStreamUnitTest {
    @Test
    fun theProfileIsDirectorsLiveValuesForOnePhone() {
        assertEquals(500, PhoneStreamProfile.streamBitrateLow / 1_000)
        assertEquals(4_000, PhoneStreamProfile.streamBitrateHigh / 1_000)
        assertEquals(2_000, PhoneStreamProfile.streamBitrateStart / 1_000)
        assertEquals(6_000, PhoneStreamProfile.recordingBitrate / 1_000)
        val stream = PhoneStreamProfile.streamSettings
        assertEquals(StreamCodec.HEVC, stream.codec)
        assertEquals(1920 to 1080, stream.width to stream.height)
        assertEquals(30, stream.frameRate)
        assertEquals(2.0, stream.gopSeconds, 0.0)
        assertEquals(2_000_000, stream.openingBitrate)
        val recording = PhoneStreamProfile.recordingSettings
        assertEquals(6_000_000, recording.programme.bitrate)
        assertEquals(recording.programme, recording.takeEncoding.rawCamera)
        assertEquals(3_600.0, recording.resumeDowntimeLimitSeconds, 0.0)
        val encoder = PhoneStreamProfile.recordingEncoderConfig
        assertFalse(encoder.live)
        assertEquals(6_000_000, encoder.bitrate)
        assertEquals(48_000, PhoneStreamProfile.audioSampleRate)
        assertEquals(128_000, PhoneStreamProfile.streamAudioBitrate)
        assertEquals(192_000, PhoneStreamProfile.recordingAudioBitrate)
        assertEquals(0.15, PhoneStreamProfile.pictureDelaySeconds, 0.0)
        assertEquals(8, PhoneStreamProfile.heldPictures)
        assertEquals(1.0, PhoneStreamProfile.recordingMixDelaySeconds, 0.0)
        assertEquals(6.0, PhoneStreamProfile.stallRedialSeconds, 0.0)
        val capture = PhoneStreamProfile.captureSettings(setOf("lens-0"), CameraPosition.FRONT)
        assertEquals(30.0, capture.frameRate, 0.0)
        assertEquals(setOf("lens-0"), capture.disabledLensIDs)
        assertEquals(CameraPosition.FRONT, capture.cameraPosition)
    }

    @Test
    fun aStreamOpensAtItsStartHeldInsideItsRange() {
        assertEquals(4_000_000, StreamSettings().openingBitrate)
        assertEquals(500_000, StreamSettings(bitrateStart = 100_000).openingBitrate)
        assertEquals(4_000_000, StreamSettings(bitrateStart = 9_000_000).openingBitrate)
        val controller = AdaptiveBitrateController(4_000_000, 500_000, start = 2_000_000)
        assertEquals(2_000_000, controller.bitrate)
        assertEquals(2_000_000, controller.status.bitrate)
        controller.reset(4_000_000, 500_000)
        assertEquals(4_000_000, controller.bitrate)
        controller.reset(4_000_000, 500_000, start = 1_000_000)
        assertEquals(1_000_000, controller.status.bitrate)
        val applied = mutableListOf<Int>()
        val done = CountDownLatch(1)
        val loop = AdaptiveBitrateLoop(4_000_000, 500_000, sample = { null }, apply = {
            applied += it
            done.countDown()
        })
        loop.configure(4_000_000, 500_000, start = 2_000_000, enabled = false)
        assertTrue(done.await(2, TimeUnit.SECONDS))
        loop.stop()
        assertEquals(listOf(2_000_000), applied)
    }

    @Test
    fun aRecordingSessionNeitherRepeatsPicturesNorCapsItsRate() {
        val live = MediaCodecStreamEncoder.format(PhoneStreamProfile.recordingEncoderConfig.copy(live = true))
        assertTrue(live.containsKey(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER))
        val recording = MediaCodecStreamEncoder.format(PhoneStreamProfile.recordingEncoderConfig)
        assertFalse(recording.containsKey(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER))
        assertFalse(recording.containsKey(MediaFormat.KEY_MAX_FPS_TO_ENCODER))
        assertEquals(6_000_000, recording.getInteger(MediaFormat.KEY_BIT_RATE))
    }

    @Test
    fun theDeviceModelIsPrefixedWithItsMakerOnce() {
        assertEquals("Google Pixel 10", DeviceModelName.of("Google", "Pixel 10"))
        assertEquals("Samsung SM-S921U", DeviceModelName.of("samsung", "SM-S921U"))
        assertEquals("OnePlus 12", DeviceModelName.of("OnePlus", "OnePlus 12"))
        assertEquals("motorola edge", DeviceModelName.of("motorola", "motorola edge"))
        assertEquals("Pixel 10", DeviceModelName.of(null, "Pixel 10"))
        assertEquals("Google", DeviceModelName.of("Google", ""))
        assertEquals("Android", DeviceModelName.of(null, null))
        assertTrue(DeviceModelName.current.isNotEmpty())
    }

    @Test
    fun aPhoneIsSupportedOnlyWithAnHevcEncoderThatCodes1080p30() {
        val hevc = PhoneStreamCapabilities.Encoder("c2.hevc.encoder", MediaFormat.MIMETYPE_VIDEO_HEVC, codes1080p30 = true)
        val small = hevc.copy(codes1080p30 = false)
        val avc = PhoneStreamCapabilities.Encoder("c2.avc.encoder", MediaFormat.MIMETYPE_VIDEO_AVC, codes1080p30 = true)
        assertTrue(PhoneStreamCapabilities.isSupported(listOf(avc, hevc)))
        assertFalse(PhoneStreamCapabilities.isSupported(listOf(avc, small)))
        assertFalse(PhoneStreamCapabilities.isSupported(emptyList()))
        val current = PhoneStreamCapabilities.current()
        assertEquals(PhoneStreamCapabilities.isSupported(PhoneStreamCapabilities.systemEncoders()), current.supported)
        assertEquals(DeviceModelName.current, current.deviceModel)
    }

    @Test
    fun aRequestNamesTheServersOrigin() {
        assertEquals("http://teamstation.example.test:3000", PhoneStreamRequest.serverURL("http://teamstation.example.test:3000/api/v1/"))
        assertEquals("https://teamstation.example.test", PhoneStreamRequest.serverURL("https://teamstation.example.test/"))
        val request = PhoneStreamRequest("https://teamstation.example.test/api/v1", "token", "00000000-0000-4000-8000-000000000001", "Google Pixel 10")
        assertEquals("https://teamstation.example.test", request.serverURL)
    }

    @Test
    fun captureTimesMapOntoTheSteadyWallClock() {
        // The steady wall clock is the boot clock plus 1,760,000,000 s.
        val steady = SteadyWall(wall = { 1_760_000_100.0 }, uptime = { 100.0 })
        var boot = 100_000_000_000L
        var monotonic = 90_000_000_000L
        val mapping = CaptureClockMapping(steady, { boot }, { monotonic })
        // A REALTIME sensor stamps on the boot clock.
        assertEquals(1_760_000_099.5, mapping.wallForSensor(99_500_000_000L, realtime = true), 1e-6)
        // Otherwise on the monotonic clock, ten seconds behind the boot clock here.
        assertEquals(1_760_000_099.5, mapping.wallForSensor(89_500_000_000L, realtime = false), 1e-6)
        boot += 1
        monotonic += 1
        // AudioRecord says frame 48,000 was captured at 99 s; frame 47,520 was 10 ms before it.
        assertEquals(1_760_000_098.99, mapping.wallForAudio(99_000_000_000L, 48_000, 47_520, 48_000), 1e-6)
        assertEquals(1_760_000_099.01, mapping.wallForAudio(99_000_000_000L, 48_000, 48_480, 48_000), 1e-6)
        assertEquals(1_760_000_100.0, mapping.wallForBoot(100_000_000_000L), 1e-6)
        assertEquals(boot, mapping.bootNow())
    }

    private class FakeRecording : ProgrammeRecordingTarget {
        override var running = true
        val placed = mutableListOf<Pair<Double, Double?>>()
        val repeats = mutableListOf<Boolean>()
        val sound = mutableListOf<AudioFrame>()
        var refuse = false
        override fun place(presentationTime: Double, captureWall: Double?, repeat: Boolean): Double? {
            if (refuse) return null
            placed += presentationTime to captureWall
            repeats += repeat
            return presentationTime
        }

        override fun append(audio: AudioFrame) {
            sound += audio
        }
    }

    private class FakeStream : ProgrammeStreamTarget {
        override var running = true
        var admits = true
        val sound = mutableListOf<AudioFrame>()
        override fun admit(presentationTime: Double): Boolean = admits
        override fun append(audio: AudioFrame) {
            sound += audio
        }
    }

    @Test
    fun oneTickDrivesTheRecordingOnItsGridAndTheStreamAtCaptureTime() {
        val recording = FakeRecording()
        val stream = FakeStream()
        var now = 50.0
        // No picture delay here, and the wall clock at each picture's capture: each tick takes the newest.
        var wall = 0.0
        val programme = PhoneProgramme(
            recording, stream, captureWall = { it / 1e9 + 1_000.0 }, uptime = { now }, wall = { wall }, pictureDelaySeconds = 0.0
        )
        programme.start(wall = 1_000.0)
        // Before the camera's first picture a tick counts but draws nothing.
        assertEquals(PhoneProgramme.TickOutput(), programme.tick(now, null))
        // The same instant again is no tick.
        wall = 1005.0
        assertNull(programme.tick(now, 5_000_000_000))
        now += 1.0 / 30
        wall = 1005.0
        val first = programme.tick(now, 5_000_000_000)!!
        assertEquals(listOf(1L), first.recordingFrames)
        assertEquals(1L, first.streamFrame)
        assertEquals(
            listOf(
                app.teamstation.streamcore.gl.ProgrammeDraw(PhoneProgramme.RECORDING_KEY, PhoneProgramme.nanos(1.0 / 30), 5_000_000_000),
                app.teamstation.streamcore.gl.ProgrammeDraw(PhoneProgramme.STREAM_KEY, 5_000_000_000, 5_000_000_000)
            ),
            first.draws
        )
        assertEquals(1_005.0, recording.placed.last().second!!, 1e-9)
        assertEquals(1_005.0, programme.streamWall(5.0), 1e-9)
        // A late tick: the frames it skipped go to the recording as repeats, with no new capture time,
        // and its own frame repeats the picture with its capture time plus its time on air (none here).
        now += 4.0 / 30
        wall = 1005.0
        val late = programme.tick(now, 5_000_000_000)!!
        assertEquals(listOf(2L, 3L, 4L, 5L), late.recordingFrames)
        assertTrue(recording.placed.takeLast(4).dropLast(1).all { it.second == null })
        assertEquals(1_005.0, recording.placed.last().second!!, 1e-9)
        assertTrue(recording.repeats.takeLast(4).all { it })
        assertFalse(recording.repeats.first())
        // The stream never goes back or repeats a time: the same picture goes a frame on.
        assertEquals(PhoneProgramme.nanos(5.0 + 1.0 / 30), late.draws.last().presentationNanos)
        // A very late tick repeats at most a quarter of a second.
        now += 1.0
        wall = 1006.0
        val stalled = programme.tick(now, 6_000_000_000)!!
        assertEquals(8, stalled.recordingFrames.size)
        assertEquals(1_006.0, recording.placed.last().second!!, 1e-9)
        // Only encoders that are attached are given a picture.
        now += 1.0 / 30
        wall = 1006.1
        val streamOnly = programme.tick(now, 6_100_000_000, setOf(PhoneProgramme.STREAM_KEY))!!
        assertTrue(streamOnly.recordingFrames.isEmpty())
        assertEquals(PhoneProgramme.STREAM_KEY, streamOnly.draws.single().key)
        // A stream that is not taking pictures, or a recording that places none, draws nothing.
        now += 1.0 / 30
        stream.admits = false
        recording.refuse = true
        wall = 1006.2
        assertTrue(programme.tick(now, 6_200_000_000)!!.draws.isEmpty())
        now += 1.0 / 30
        stream.running = false
        recording.running = false
        wall = 1006.3
        assertTrue(programme.tick(now, 6_300_000_000)!!.draws.isEmpty())
        assertEquals(PhoneProgramme.TickOutput(), PhoneProgramme.TickOutput())
        assertEquals(7L, programme.ticks)
        assertEquals(13L, programme.recordingFramesSent)
        assertEquals(4L, programme.streamFramesSent)
        // The renderer's own call reads the host clock.
        now += 1.0 / 30
        recording.running = true
        recording.refuse = false
        wall = 1_007.0
        assertEquals(1, programme.tick(7_000_000_000, PhoneProgramme.allKeys).size)
        assertEquals(30, programme.frameRate)
    }

    /**
     * A part that opens on a picture held since before the last part finished (the camera stopped
     * delivering across it) took it as a repeat with no capture time, and a part's first picture
     * borrows a lag the new part has not measured: it was anchored as of now, a picture delay late.
     */
    @Test
    fun aPartStartedOnAPictureTheLastPartHadCarriesItsCaptureTimePlusItsTimeOnAir() {
        val recording = FakeRecording()
        var now = 0.0
        val programme = PhoneProgramme(
            recording, FakeStream(), captureWall = { it / 1e9 }, uptime = { now }, wall = { 1_000.0 + now }
        )
        programme.start(wall = 1_000.0)
        // Captured at 999, on air at 1,000, and then the camera stops: the picture is held.
        programme.pictureArrived(999_000_000_000)
        for (tick in 0..3) {
            now = tick / 30.0
            programme.tick(null, PhoneProgramme.allKeys)
        }
        assertEquals(999.0, recording.placed.first().second!!, 1e-9)
        // The part finishes, and the next one opens half a second after the picture came on air.
        recording.running = false
        for (tick in 4..14) {
            now = tick / 30.0
            programme.tick(null, PhoneProgramme.allKeys)
        }
        recording.running = true
        recording.placed.clear()
        now = 15 / 30.0
        programme.tick(null, PhoneProgramme.allKeys)
        assertEquals(999.5, recording.placed.single().second ?: Double.NaN, 1e-6)
        assertTrue(recording.repeats.last())
    }

    /**
     * A part that opens after the camera was lost for longer than the recording believes a capture
     * time (ten seconds) gave the held picture's own capture time; the recording threw it out and
     * anchored the picture as of now. Its time on air brings it to when it stands for.
     */
    @Test
    fun aPictureHeldThroughALongCameraLossIsPlacedByItsTimeOnAir() {
        val recording = FakeRecording()
        var now = 0.0
        val programme = PhoneProgramme(
            recording, FakeStream(), captureWall = { it / 1e9 }, uptime = { now }, wall = { 1_000.0 + now }
        )
        programme.start(wall = 1_000.0)
        recording.running = false
        programme.pictureArrived(999_000_000_000)
        for (tick in 0 until 600) {
            now = tick / 30.0
            programme.tick(null, PhoneProgramme.allKeys)
        }
        // Twenty seconds later the camera is back and a part opens, before its first new picture is due.
        recording.running = true
        now = 20.0
        programme.tick(null, PhoneProgramme.allKeys)
        assertEquals(1_019.0, recording.placed.single().second ?: Double.NaN, 1e-6)
    }

    @Test
    fun theSoundBusMovesToWhereTheCaptureTimesSayAndFollowsTheirDrift() {
        val mix = PhoneSoundMix(sampleRate = 1_000, runSeconds = 0.02, capacitySeconds = 4.0, medianBuffers = 5)
        val heard = mutableListOf<AudioFrame>()
        mix.add(PhoneSoundMix.Output(0.0) { heard += it })
        mix.start(100.0)
        // The first buffer's time is 12 ms early: the rest say so, with a few ms of jitter.
        var wall = 100.0
        mix.write(ShortArray(20) { 1 }, wall - 0.012)
        val jitter = listOf(0.002, -0.001, 0.0, 0.003, -0.002, 0.001, 0.0)
        for (each in jitter) {
            wall += 0.02
            mix.write(ShortArray(20) { 1 }, wall + each)
        }
        // Once five buffers agree, the run moves 12 ms in one step, and stays within the dead band.
        assertEquals(0, mix.reanchors)
        assertEquals(12L, mix.steeredFrames)
        assertEquals(0.0, mix.steeringErrorSeconds, 0.004)
        // A microphone clock 0.5 % slow: the capture times run ahead of the count, and the run follows
        // one sample per buffer once they are more than 4 ms ahead.
        val before = mix.steeredFrames
        repeat(200) {
            wall += 0.02 * 1.005
            mix.write(ShortArray(20) { 2 }, wall)
        }
        val drifted = 200 * 0.02 * 0.005 * 1_000
        assertEquals(drifted, (mix.steeredFrames - before).toDouble(), 5.0)
        assertTrue(mix.steeringErrorSeconds <= 0.005)
        // And back: a fast clock pulls the run the other way, overwriting a sample at a time.
        val turned = mix.steeredFrames
        repeat(200) {
            wall += 0.02 * 0.995
            mix.write(ShortArray(20) { 3 }, wall)
        }
        assertTrue(mix.steeredFrames - turned > 10)
        assertTrue(mix.steeringErrorSeconds >= -0.005)
        // Read out, the steered run has no holes: every sample after the first buffer is sound.
        mix.pump(wall + 0.02)
        val samples = heard.flatMap { run -> run.samples.toList() }.dropWhile { it == 0.toShort() }
        assertTrue(samples.isNotEmpty())
        assertTrue(samples.take(samples.size - 40).none { it == 0.toShort() })
        // A new start forgets the steering.
        mix.start(200.0)
        mix.write(ShortArray(20) { 1 }, 200.0)
        mix.write(ShortArray(20) { 1 }, 200.03)
        assertEquals(0, mix.reanchors)
    }

    @Test
    fun anOutputWhoseSinkThrowsDoesNotStarveTheOthers() {
        val mix = PhoneSoundMix(sampleRate = 1_000, runSeconds = 0.02, capacitySeconds = 2.0)
        val recorded = mutableListOf<AudioFrame>()
        mix.add(PhoneSoundMix.Output(0.0) { throw IllegalStateException("stream encoder failed") })
        mix.add(PhoneSoundMix.Output(0.0) { recorded += it })
        mix.start(100.0)
        mix.write(ShortArray(100) { 4 }, 100.0)
        mix.pump(100.1)
        assertEquals(5, recorded.size)
        assertTrue(recorded.all { run -> run.samples.all { it == 4.toShort() } })
    }

    @Test
    fun theSoundBusReadsEachOutputContiguouslyAtItsDelay() {
        val live = mutableListOf<AudioFrame>()
        val recorded = mutableListOf<AudioFrame>()
        // Steps at 50 ms, and a median window too long to steer within this test.
        val mix = PhoneSoundMix(sampleRate = 1_000, runSeconds = 0.02, capacitySeconds = 2.0, stepSeconds = 0.05, medianBuffers = 1_000)
        val liveOutput = PhoneSoundMix.Output(0.1) { live += it }
        val recordingOutput = PhoneSoundMix.Output(1.0) { recorded += it }
        mix.add(liveOutput)
        mix.add(recordingOutput)
        // Nothing before the bus starts.
        mix.write(ShortArray(20) { 1 }, 100.0)
        mix.pump(100.5)
        assertTrue(live.isEmpty())
        mix.start(100.0)
        // Sound captured from 100.0 s, then a buffer 6 ms late that follows on from it.
        mix.write(ShortArray(20) { 1 }, 100.0)
        mix.write(ShortArray(20) { 2 }, 100.026)
        // The live output is 100 ms behind: runs from 99.9 s through 100.04 s.
        mix.pump(100.14)
        assertEquals(listOf(99.9, 99.92, 99.94, 99.96, 99.98, 100.0, 100.02), live.map { Math.round(it.wallClock * 100) / 100.0 })
        val silent = live[4]
        assertEquals(2, silent.channels)
        assertEquals(20, silent.frameCount)
        assertTrue(silent.samples.all { it == 0.toShort() })
        assertTrue(live[5].samples.all { it == 1.toShort() })
        assertTrue(live[6].samples.all { it == 2.toShort() })
        // A buffer far from where the last ended is placed by its capture time, across silence.
        mix.write(ShortArray(20) { 3 }, 100.1)
        assertEquals(1, mix.reanchors)
        mix.pump(100.22)
        assertEquals(11, live.size)
        assertTrue(live.subList(7, 10).all { run -> run.samples.all { it == 0.toShort() } })
        assertTrue(live[10].samples.all { it == 3.toShort() })
        // Muted, the outputs carry on in silence.
        mix.soundEnabled = false
        mix.write(ShortArray(20) { 4 }, 100.12)
        mix.pump(100.24)
        assertEquals(12, live.size)
        assertTrue(live[11].samples.all { it == 0.toShort() })
        mix.soundEnabled = true
        // The recording waits its second; a flush hands over everything up to a moment.
        assertEquals(99.22, recorded.last().wallClock, 1e-9)
        mix.flush(recordingOutput, 100.06)
        assertEquals(99.0, recorded.first().wallClock, 1e-9)
        assertEquals(100.06, recorded.last().wallClock + 0.02, 1e-9)
        assertTrue(recorded.last().samples.all { it == 2.toShort() || it == 0.toShort() })
        // A reader that fell more than the ring behind starts again near now.
        live.clear()
        mix.pump(110.0)
        assertEquals(1, live.size)
        mix.stop()
        mix.pump(111.0)
        mix.flush(recordingOutput, 111.0)
        assertEquals(1, live.size)
        mix.write(ShortArray(0), 111.0)
    }

    @Test
    fun theLensPillAndTheLensRules() {
        val wide = CameraLens("wide", CameraPosition.BACK, "2", 24, 1.0, 1.0)
        val ultra = CameraLens("ultra", CameraPosition.BACK, "3", 13, 0.5, 0.5)
        val front = CameraLens("front", CameraPosition.FRONT, "1", null, 1.0, 1.0)
        val lenses = listOf(wide, ultra, front)
        val state = app.teamstation.streamcore.capture.CameraSession.State(deviceZoom = 1.0)
        assertEquals("24 mm", PhoneStreamEngine.lensLabel(state, lenses))
        assertEquals("1x", PhoneStreamEngine.lensLabel(state, emptyList()))
        // Turning off every back lens leaves them all on; the front's own choice stands.
        assertEquals(emptySet<String>(), PhoneStreamEngine.normalizedLenses(setOf("wide", "ultra"), lenses))
        assertEquals(setOf("ultra"), PhoneStreamEngine.normalizedLenses(setOf("ultra"), lenses))
        assertEquals(setOf("anything"), PhoneStreamEngine.normalizedLenses(setOf("anything"), emptyList()))
    }

    @Test
    fun storageRulesStartAtTenGigabytesAndStopBelowTwo() {
        val rules = PhoneStorageRules.standard
        assertEquals(10_000_000_000L, rules.startFloorBytes)
        assertEquals(2_000_000_000L, rules.stopFloorBytes)
        assertTrue(rules.canStart(10_000_000_000))
        assertFalse(rules.canStart(9_999_999_999))
        assertTrue(rules.mustStop(1_999_999_999))
        assertFalse(rules.mustStop(2_000_000_000))
    }

    @Test
    fun aFlushAtAPartsEndNeverOvertakesRunsAPumpHasTaken() {
        val mix = PhoneSoundMix(sampleRate = 1_000, runSeconds = 0.02, capacitySeconds = 4.0)
        val heard = java.util.concurrent.ConcurrentLinkedQueue<Double>()
        val inSink = CountDownLatch(1)
        val release = CountDownLatch(1)
        val output = PhoneSoundMix.Output(0.1) { frame ->
            heard += frame.wallClock
            // The first run the pump hands over takes its time, as an encoder's can.
            if (heard.size == 1) {
                inSink.countDown()
                release.await(5, TimeUnit.SECONDS)
            }
        }
        mix.add(output)
        mix.start(0.0)
        val pumping = Thread { mix.pump(0.5) }.apply { start() }
        assertTrue(inSink.await(5, TimeUnit.SECONDS))
        // The part ends while the pump is still handing over what it took.
        val flushing = Thread { mix.flush(output, 1.0) }.apply { start() }
        Thread.sleep(100)
        release.countDown()
        pumping.join(5_000)
        flushing.join(5_000)
        val times = heard.toList()
        assertTrue(times.size > 40)
        assertEquals(times.sorted(), times)
        assertEquals(times.distinct(), times)
    }
}
