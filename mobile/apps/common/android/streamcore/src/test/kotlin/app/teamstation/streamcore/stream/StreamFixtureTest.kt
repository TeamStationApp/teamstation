package app.teamstation.streamcore.stream

import app.teamstation.streamcore.MediaFixtures
import app.teamstation.streamcore.double
import app.teamstation.streamcore.int
import app.teamstation.streamcore.list
import app.teamstation.streamcore.long
import app.teamstation.streamcore.obj
import app.teamstation.streamcore.rtmp.RTMPClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The stream path's decisions equal TS Director's, value for value: the send budget and what the
 * queue sheds, the encode clock, the counted audio stamps, the stall policy and the redial waits.
 */
class StreamFixtureTest {
    @Test
    fun theSendBudgetAndSheddingEqualDirectors() {
        val fixture = MediaFixtures.json("rtmp-send-budget.json")
        assertEquals(fixture["bufferSeconds"].double(), RTMPClient.sendBufferSeconds, 0.0)
        for (row in fixture["budgets"].list().map { it.obj() }) {
            assertEquals(row["sendBudgetBytes"].int(), RTMPClient.sendBudget(row["bitrate"].int()))
        }
        val cases = fixture["shedding"].list().map { it.obj() }
        assertEquals(6, cases.size)
        for (case in cases) {
            val queue = case["queue"].list().map { it.obj() }.map {
                val kind = it["kind"] as String
                RTMPClient.ShedItem(
                    bytes = it["bytes"].int(),
                    isVideo = kind == "key" || kind == "delta",
                    isKeyframe = kind == "key",
                    isSequenceHeader = kind == "header"
                )
            }
            val dropped = RTMPClient.shedIndices(
                queue,
                queuedBytes = queue.sumOf { it.bytes },
                budget = case["budgetBytes"].int(),
                delayExceeded = case["delayExceeded"] as Boolean
            )
            assertEquals(case["name"] as String, case["dropped"].list().map { it.int() }, dropped)
            // Never a sequence header, and what is left starts on a keyframe.
            assertTrue(dropped.none { queue[it].isSequenceHeader })
            val firstPicture = queue.indices.filter { it !in dropped }.map { queue[it] }
                .firstOrNull { it.isVideo && !it.isSequenceHeader }
            if (dropped.isNotEmpty()) assertTrue(firstPicture?.isKeyframe ?: true)
        }
    }

    @Test
    fun theEncodeClockEqualsDirectors() {
        val fixture = MediaFixtures.json("stream-encode-clock.json")
        val clock = StreamEncodeClock(fixture["frameRate"].int(), fixture["gopSeconds"].double())
        assertEquals(fixture["maxKeyFrameInterval"].int(), clock.maxKeyFrameInterval)
        val base = 800_000_000.0
        for (step in fixture["steps"].list().map { it.obj() }) {
            if (step["requestKeyframe"] as Boolean) clock.requestKeyframe()
            val now = base + step["now"].double()
            val time = clock.nextPresentationTime(MediaTime.zero, now)
            val force = clock.shouldForceKey(time, now)
            if (force) clock.noteKeyframe(time, now)
            assertEquals("pts at ${step["now"]}", step["ptsValue"].long(), time.value)
            assertEquals(step["ptsTimescale"].int(), time.timescale)
            assertEquals("key at ${step["now"]}", step["forceKey"] as Boolean, force)
        }
    }

    @Test
    fun theAudioStampsEqualDirectors() {
        val fixture = MediaFixtures.json("stream-audio-stamps.json")
        assertEquals(fixture["samplesPerPacket"].int(), StreamAudioStamps.samplesPerPacket)
        assertEquals(fixture["sampleRate"].int(), StreamAudioStamps.sampleRate)
        assertEquals(fixture["resetGapSeconds"].double(), StreamAudioStamps.audioGapResetSeconds, 0.0)
        for (run in fixture["runs"].list().map { it.obj() }) {
            val epoch = StreamAudioStamps.audioEpochMilliseconds(
                run["inputWall"].double(),
                run["startWall"].double(),
                run["primingSamples"].int()
            )
            assertEquals(run["epochMilliseconds"].double(), epoch, 0.0)
            val stamps = StreamAudioStamps.audioTimestamps(run["count"].int(), run["fromPacket"].int(), epoch)
            assertEquals(run["stamps"].list().map { it?.long() }, stamps)
        }
        val never = fixture["neverBackwards"].obj()
        val proposed = never["proposed"].list().map { it?.long() }
        assertEquals(
            never["sent"].list().map { it?.long() },
            StreamAudioStamps.monotonicAudioStamps(proposed, never["after"].long())
        )
        assertEquals(proposed.filterNotNull().distinct().size, StreamAudioStamps.monotonicAudioStamps(proposed, null).count { it != null } + 1)
        assertFalse(StreamAudioStamps.audioBreaks(null, 10.0))
        assertFalse(StreamAudioStamps.audioBreaks(10.0, 10.005))
        assertTrue(StreamAudioStamps.audioBreaks(10.0, 10.02))
    }

    @Test
    fun theStallPolicyEqualsDirectors() {
        val fixture = MediaFixtures.json("stream-stall-policy.json")
        val policy = StreamStallPolicy(fixture["gopSeconds"].double(), fixture["resetCooldown"].double())
        for (case in fixture["cases"].list().map { it.obj() }) {
            val action = policy.action(
                now = case["now"].double(),
                lastKeyframeWall = case["lastKeyframeWall"].double(),
                lastCallbackWall = case["lastCallbackWall"].double(),
                pendingEncodes = case["pendingEncodes"].int(),
                hasLastFrame = case["hasLastFrame"] as Boolean,
                lastResetWall = case["lastResetWall"].double(),
                startedWall = case["startedWall"].double(),
                lastOutputWall = case["lastOutputWall"].double()
            )
            val named = when (action) {
                StreamStallAction.NONE -> "none"
                StreamStallAction.ENCODE_IDLE_IDR -> "encodeIdleIDR"
                StreamStallAction.RESET_SESSION -> "resetSession"
            }
            assertEquals(case["name"] as String, case["action"], named)
        }
    }

    @Test
    fun theRedialWaitsEqualDirectors() {
        val fixture = MediaFixtures.json("reconnect-backoff.json")
        assertEquals(fixture["firstRetrySeconds"].double(), StreamRetrySchedule.firstRetrySeconds, 0.0)
        assertEquals(fixture["longestRetrySeconds"].double(), StreamRetrySchedule.longestRetrySeconds, 0.0)
        assertEquals(fixture["liveResetSeconds"].double(), StreamRetrySchedule.liveResetSeconds, 0.0)
        val schedule = StreamRetrySchedule()
        for (event in fixture["events"].list().map { it.obj() }) {
            when (event["event"]) {
                "start" -> schedule.started()
                "drop" -> assertEquals(
                    "drop at ${event["at"]}",
                    event["waits"].double(),
                    schedule.dropped(event["liveFor"]?.double()),
                    0.0
                )
            }
        }
    }

    @Test
    fun thePacerHoldsTheStreamRate() {
        val pacer = StreamFramePacer(30)
        val admitted = (0 until 120).count { pacer.admit(it / 60.0 + (if (it % 2 == 0) 0.002 else -0.002)) }
        assertEquals(60, admitted)
        pacer.reset()
        assertTrue(pacer.admit(100.0))
        assertFalse(pacer.admit(100.01))
        // After a stall the cadence starts again rather than admitting a burst.
        assertTrue(pacer.admit(105.0))
        assertFalse(pacer.admit(105.01))
    }

    @Test
    fun theClockTellsKeyframeAge() {
        val clock = StreamEncodeClock(0, 0.0)
        assertEquals(1, clock.frameRate)
        assertEquals(0.1, clock.gopSeconds, 0.0)
        assertEquals(0.0, clock.keyframeAgeSeconds(10.0), 0.0)
        assertEquals(MediaTime.zero, clock.timeNow(10.0))
        clock.nextPresentationTime(MediaTime.zero, 10.0)
        assertEquals(2.0, clock.keyframeAgeSeconds(12.0), 0.0)
        assertEquals(2000L, clock.timeNow(12.0).value)
        clock.noteKeyframe(clock.lastTime, 11.0)
        assertEquals(1.0, clock.keyframeAgeSeconds(12.0), 0.0)
        assertTrue(clock.shouldForceKey(clock.lastTime, 11.5))
        clock.reset()
        assertTrue(clock.awaitingKeyframe)
        assertEquals(0.0, clock.startWall, 0.0)
    }

    @Test
    fun mediaTimeAddsOnACommonScale() {
        val sum = MediaTime(1, 30) + MediaTime(1, 10)
        assertEquals(MediaTime(4, 30), sum)
        assertEquals(MediaTime(-2, 30), MediaTime(1, 30) - MediaTime(1, 10))
        assertEquals(MediaTime.negativeInfinity, MediaTime.negativeInfinity + MediaTime(1, 30))
        assertEquals(MediaTime.negativeInfinity, MediaTime(1, 30) - MediaTime.negativeInfinity)
        assertTrue(MediaTime.negativeInfinity < MediaTime(0, 1))
        assertTrue(MediaTime(0, 1) > MediaTime.negativeInfinity)
        assertEquals(0, MediaTime.negativeInfinity.compareTo(MediaTime.negativeInfinity))
        assertEquals(Double.NEGATIVE_INFINITY, MediaTime.negativeInfinity.seconds, 0.0)
        assertEquals(3.0, 2.5.roundedHalfAwayFromZero(), 0.0)
        assertEquals(-3.0, (-2.5).roundedHalfAwayFromZero(), 0.0)
        assertEquals(0.0, 0.49999999999999994.roundedHalfAwayFromZero(), 0.0)
    }

    @Test
    fun anEncoderCallingBackWithNoPicturesIsRebuilt() {
        val policy = StreamStallPolicy()
        // Callbacks fresh but never a picture, three GOPs in.
        assertEquals(
            StreamStallAction.RESET_SESSION,
            policy.action(now = 100.0, lastKeyframeWall = 0.0, lastCallbackWall = 99.9, pendingEncodes = 1, hasLastFrame = false, lastResetWall = 0.0, startedWall = 94.0)
        )
        assertEquals(
            StreamStallAction.NONE,
            policy.action(now = 100.0, lastKeyframeWall = 99.0, lastCallbackWall = 99.9, pendingEncodes = 1, hasLastFrame = true, lastResetWall = 0.0)
        )
        assertEquals(10.0, StreamStallPolicy(gopSeconds = 0.0, resetCooldown = -1.0).gopSeconds * 100, 0.0)
    }

    @Test
    fun telemetryThatIsNotKeptTakesEveryCount() {
        val none: MediaTelemetry = MediaTelemetry.None
        none.recordEncodeSessionChange(1)
        none.recordStreamKeyframe(0.0)
        none.recordStreamKeyframeAge(0.0)
        none.recordStreamPendingEncodes(0)
        none.recordStreamEncodeCallbackAge(0.0)
        none.recordProgramFrameAge(0.0)
        none.recordStreamIdleKeyframe()
        none.recordStreamEncoderReset()
        none.recordEncodeFailure(0)
        none.recordProgramFinish("finish")
        none.recordError("error")
        none.recordRecordingError("recording")
        val kept = none as BasicMediaTelemetry
        assertEquals(listOf("finish", "error", "recording"), listOf(kept.lastProgramFinish, kept.lastError, kept.lastRecordingError))
        assertNull(app.teamstation.streamcore.rtmp.TransportBacklog.unsentBytes(java.io.FileDescriptor()))
    }
}
