package app.teamstation.streamcore.phonestream

import app.teamstation.streamcore.stream.AudioFrame
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class ProgrammePictureQueueTest {
    private val period = 1.0 / 30

    /** A camera at [fps] from wall [start], each picture arriving [lag] plus up to [jitter] after capture. */
    private data class Arrival(val nanos: Long, val capture: Double, val arrives: Double)

    private fun camera(fps: Double, seconds: Double, lag: Double, jitter: Double, seed: Int = 1): List<Arrival> {
        val random = Random(seed)
        return (0 until (seconds * fps).toInt()).map { index ->
            val capture = 100.0 + index / fps
            Arrival(((capture) * 1e9).toLong(), capture, capture + lag + random.nextDouble() * jitter)
        }
    }

    /** Runs the queue on a 30 fps grid; answers each tick's wall time and the capture it chose. */
    private fun run(arrivals: List<Arrival>, delay: Double, seconds: Double): List<Pair<Double, Double?>> {
        val queue = ProgrammePictureQueue(delay)
        val pending = arrivals.sortedBy { it.arrives }.toMutableList()
        return (0 until (seconds * 30).toInt()).map { tick ->
            val now = 100.0 + tick * period
            while (pending.isNotEmpty() && pending.first().arrives <= now) {
                val next = pending.removeAt(0)
                queue.add(next.nanos, next.capture)
            }
            now to queue.pick(now, period)?.captureWall
        }
    }

    @Test
    fun aTwentyFiveFpsCameraOnTheThirtyFpsGridIsPlacedByCaptureTimeNotArrival() {
        val delay = PhoneStreamProfile.pictureDelaySeconds
        // Poor light: 25 fps, delivered 40 to 120 ms after capture with scheduling jitter.
        val quick = run(camera(25.0, 6.0, lag = 0.04, jitter = 0.02), delay, 6.0)
        val slow = run(camera(25.0, 6.0, lag = 0.09, jitter = 0.03, seed = 7), delay, 6.0)
        // How late the delivery is does not move a single picture.
        assertEquals(quick, slow)
        val shown = quick.filter { it.second != null }
        // Every tick after the first picture's moment shows something.
        assertTrue(shown.size >= quick.size - (delay / period).toInt() - 2)
        for ((now, capture) in shown) {
            // The newest picture whose moment has come: within one camera frame of now less the delay.
            val age = now - delay - capture!!
            assertTrue("age $age", age >= -ProgrammePictureQueue.toleranceSeconds && age < 0.04 + 1e-9)
        }
        // Each picture is shown once or twice in a row: one tick in six repeats, none skipped.
        val runs = shown.map { it.second }.zipWithNext().count { (a, b) -> a == b }
        assertEquals(shown.size / 6.0, runs.toDouble(), 2.0)
        // Against a sound timeline laid by capture time, a picture's offset (capture less where its
        // tick sits) stays inside one camera frame, centred, for the whole take.
        val offsets = shown.map { (now, capture) -> capture!! - now }
        val spread = offsets.max() - offsets.min()
        assertTrue("spread $spread", spread < 0.04 + 1e-9)
        val firstHalf = offsets.take(offsets.size / 2).average()
        val secondHalf = offsets.drop(offsets.size / 2).average()
        assertEquals(firstHalf, secondHalf, 0.004)
    }

    @Test
    fun thirtyFpsShowsEachPictureOnce() {
        val shown = run(camera(30.0, 3.0, lag = 0.05, jitter = 0.01), 0.15, 3.0).mapNotNull { it.second }
        assertEquals(shown.size, shown.toSet().size)
    }

    @Test
    fun aPictureArrivingAfterItsMomentIsDroppedAndTheLastIsShownAgain() {
        val queue = ProgrammePictureQueue(0.1)
        assertNull(queue.pick(10.0, period))
        queue.add(1L, 10.0)
        // Not due yet: nothing on air.
        assertNull(queue.pick(10.05, period))
        assertEquals(setOf(1L), queue.wanted)
        val first = queue.pick(10.1, period)!!
        assertEquals(1L, first.captureNanos)
        assertEquals(0, queue.count)
        // Nothing newer is due: the same picture again.
        assertEquals(first, queue.pick(10.1 + period, period))
        assertEquals(first, queue.pick(10.2, period))
        // A picture whose moment passed more than a tick before the last tick is dropped.
        queue.add(2L, 10.01)
        assertEquals(1L, queue.pick(10.2 + period, period)!!.captureNanos)
        assertEquals(1L, queue.latePictures)
        // One older than what is on air is refused outright, and a repeat is ignored.
        queue.add(0L, 9.9)
        assertEquals(2L, queue.latePictures)
        queue.add(3L, 10.1)
        queue.add(3L, 10.1)
        queue.add(4L, 10.11)
        assertEquals(2, queue.count)
        // Two due on one tick: the newer is shown and the older counted as skipped.
        assertEquals(4L, queue.pick(10.25, period)!!.captureNanos)
        assertEquals(1L, queue.skippedPictures)
        assertEquals(setOf(4L), queue.wanted)
        queue.reset()
        assertNull(queue.current)
        assertEquals(0.0, ProgrammePictureQueue(-1.0).delaySeconds, 0.0)
    }

    @Test
    fun picturesOutOfOrderAreQueuedByCaptureAndTheQueueIsBoundedByTime() {
        val queue = ProgrammePictureQueue(0.1)
        queue.add(2L, 10.04)
        queue.add(1L, 10.0)
        assertEquals(1L, queue.pick(10.1, period)!!.captureNanos)
        assertEquals(2L, queue.pick(10.14, period)!!.captureNanos)
        // Older than the newest less the delay and the spare: let go.
        queue.add(3L, 10.2)
        queue.add(4L, 11.0)
        assertEquals(setOf(2L, 4L), queue.wanted)
        repeat(ProgrammePictureQueue.maximumQueued + 5) { queue.add(100L + it, 11.0 + it * 1e-4) }
        assertEquals(ProgrammePictureQueue.maximumQueued, queue.count)
    }

    private class Recording : ProgrammeRecordingTarget {
        override var running = true
        val placed = mutableListOf<Pair<Double, Double?>>()
        override fun place(presentationTime: Double, captureWall: Double?): Double {
            placed += presentationTime to captureWall
            return presentationTime
        }

        override fun append(audio: AudioFrame) = Unit
    }

    private class Stream : ProgrammeStreamTarget {
        override var running = true
        override fun admit(presentationTime: Double) = true
        override fun append(audio: AudioFrame) = Unit
    }

    @Test
    fun ticksOnWholeMillisecondsAndHeldUpTicksDrawEachPictureInItsOwnSlot() {
        val recording = Recording()
        var now = 0.0
        val programme = PhoneProgramme(recording, Stream(), captureWall = { it / 1e9 }, uptime = { now }, wall = { 100.0 + now })
        programme.start(wall = 100.0)
        // A 30 fps camera captured 8 ms before each frame's time, each picture arriving 60 ms later.
        val captures = (0 until 140).map { 100.0 + it / 30.0 - 0.008 }
        var next = 0
        var newest: Long? = null
        for (tick in 0 until 120) {
            // The renderer's handler fires on whole milliseconds, some a fraction early, and every
            // fifth tick is held up 12 ms behind an encoder.
            now = Math.round(tick * 1000.0 / 30) / 1000.0 + if (tick % 5 == 4) 0.012 else 0.0
            while (next < captures.size && captures[next] + 0.06 <= 100.0 + now) {
                newest = (captures[next] * 1e9).toLong()
                programme.pictureArrived(newest)
                next += 1
            }
            programme.tick(newest, PhoneProgramme.allKeys)
        }
        // Every slot has its own fresh picture: none repeated, none skipped.
        assertTrue(recording.placed.size > 100)
        assertTrue(recording.placed.all { it.second != null })
        assertEquals(0L, programme.skippedPictures)
        // Each captured the picture delay, and under one frame, before its slot's time.
        for ((slot, capture) in recording.placed) {
            val age = 100.0 + slot - PhoneStreamProfile.pictureDelaySeconds - capture!!
            assertTrue("age $age", age >= 0 && age < 1.0 / 30)
        }
    }

    @Test
    fun thePhoneProgrammeDrawsTheHeldPictureWhoseMomentHasComeIntoBothEncoders() {
        val recording = Recording()
        var now = 0.0
        val programme = PhoneProgramme(
            recording,
            Stream(),
            captureWall = { it / 1e9 },
            uptime = { now },
            wall = { 100.0 + now }
        )
        assertEquals(PhoneStreamProfile.heldPictures, programme.heldPictures)
        assertEquals(PhoneStreamProfile.pictureDelaySeconds, programme.pictureDelaySeconds, 0.0)
        programme.start(wall = 100.0)
        val arrivals = camera(25.0, 4.0, lag = 0.06, jitter = 0.03).sortedBy { it.arrives }.toMutableList()
        var newest: Long? = null
        val drawn = mutableListOf<Pair<Double, Long?>>()
        for (tick in 0 until 120) {
            now = tick * period
            while (arrivals.isNotEmpty() && arrivals.first().arrives <= 100.0 + now) {
                val next = arrivals.removeAt(0)
                newest = next.nanos
                val wanted = programme.pictureArrived(next.nanos)
                assertTrue(wanted.size <= programme.heldPictures)
            }
            val draws = programme.tick(newest, PhoneProgramme.allKeys)
            if (draws.isNotEmpty()) {
                // The recording and the stream draw the same held picture.
                assertEquals(1, draws.mapNotNull { it.captureNanos }.toSet().size)
                drawn += now to draws.first().captureNanos
            }
        }
        // Nothing is drawn until the first picture's moment, then every tick draws.
        assertTrue(drawn.first().first >= PhoneStreamProfile.pictureDelaySeconds - period)
        for ((at, nanos) in drawn) {
            val age = 100.0 + at - PhoneStreamProfile.pictureDelaySeconds - nanos!! / 1e9
            assertTrue("age $age", age >= -0.002 && age < 0.04 + 1e-6)
        }
        // A fresh picture gives the recording its capture time, a repeat gives none.
        val fresh = recording.placed.filter { it.second != null }
        assertEquals(fresh.size, fresh.map { it.second }.toSet().size)
        assertTrue(recording.placed.size > fresh.size)
        assertEquals(0L, programme.latePictures)
        assertEquals(0L, programme.skippedPictures)
        // A start forgets what was queued.
        programme.start(wall = 200.0)
        now += period
        assertTrue(programme.tick(null, PhoneProgramme.allKeys).isEmpty())
    }
}
