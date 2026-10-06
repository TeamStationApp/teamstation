package app.teamstation.cameraman

import app.teamstation.cameraman.core.FrameDelivery
import app.teamstation.cameraman.core.FrameDeliveryThrottle
import app.teamstation.cameraman.core.FrameRateSwing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * The test throttle: which captured frames reach the encoder, at what rate and how unevenly. The
 * cases and the numbers are the iOS suite's.
 */
class FrameDeliveryThrottleTest {

    /** SplitMix64, so a run is the same every time. */
    class Seeded(private var state: Long) {
        fun next(): Double {
            state += -0x61c8864680b583ebL
            var z = state
            z = (z xor (z ushr 30)) * -0x40a7b892e31b1a47L
            z = (z xor (z ushr 27)) * -0x6b2fb644ecceee15L
            z = z xor (z ushr 31)
            return (z ushr 11).toDouble() / (1L shl 53).toDouble()
        }
    }

    companion object {
        fun throttle(seed: Long = 7): FrameDeliveryThrottle {
            val random = Seeded(seed)
            return FrameDeliveryThrottle { random.next() }
        }

        /**
         * Capture times of a camera running at [fps] for [seconds], from [start], with a little of
         * the wobble real capture times have.
         */
        fun captureTimes(fps: Double = 60.0, seconds: Double, start: Double = 1000.0): List<Double> {
            val count = (seconds * fps).toInt()
            return (0 until count).map { index ->
                start + index / fps + if (index % 3 == 0) 0.0004 else -0.0003
            }
        }

        fun kept(throttle: FrameDeliveryThrottle, times: List<Double>): List<Double> =
            times.filter { throttle.shouldDeliver(it) }
    }

    @Test
    fun `a 60 fps capture throttled to 24 delivers 24 plus or minus 1 a second, unevenly, at its own capture times`() {
        val throttle = throttle()
        throttle.configure(FrameDelivery(frameRate = 24.0))
        val times = captureTimes(seconds = 60.0)
        val kept = kept(throttle, times)

        assertTrue(times.toSet().containsAll(kept))
        assertEquals(times.first(), kept.first(), 0.0)

        for (window in 0 until 6) {
            val start = times[0] + window * 10
            val count = kept.count { it >= start && it < start + 10 }
            assertTrue("window $window: $count frames", abs(count / 10.0 - 24) <= 1)
        }

        val intervals = kept.zipWithNext { a, b -> b - a }
        val mean = 1.0 / 24
        assertTrue(intervals.all { it >= mean * 0.7 - 1.0 / 60 && it <= mean * 1.3 + 1.0 / 60 })
        assertTrue(intervals.any { it < mean * 0.85 })
        assertTrue(intervals.any { it > mean * 1.15 })
        val average = intervals.average()
        val spread = sqrt(intervals.map { (it - average) * (it - average) }.average())
        assertTrue(spread / average > 0.1)

        val measured = throttle.deliveredFrameRate ?: 0.0
        assertTrue("measured $measured", abs(measured - 24) <= 2)
    }

    @Test
    fun `a swing 24-60-20 follows the ramp up and back down, and restarts at low when configured`() {
        val throttle = throttle(seed = 11)
        val swing = FrameRateSwing(24.0, 60.0, 20.0)
        throttle.configure(FrameDelivery(swing = swing))
        val times = captureTimes(seconds = 40.0)
        val kept = kept(throttle, times)
        val start = times[0]

        var centre = 2.0
        while (centre <= 38.0) {
            val expected = swing.rate(centre)
            if (expected < 50) {
                val count = kept.count { it >= start + centre - 1 && it < start + centre + 1 }
                assertTrue("at $centre s: ${count / 2.0} fps, expected $expected", abs(count / 2.0 - expected) <= 4)
            }
            centre += 2.0
        }
        val top = kept.count { it >= start + 9.5 && it < start + 10.5 }
        assertTrue("at the peak: $top", top >= 52)

        val later = captureTimes(seconds = 2.0, start = times.last() + 1.0 / 60)
        throttle.configure(FrameDelivery(swing = swing))
        val restarted = kept(throttle, later)
        assertTrue("restarted at ${restarted.size / 2.0}", abs(restarted.size / 2.0 - 25) <= 3)
    }

    @Test
    fun `off delivers every frame, and turning a throttle off restores every frame`() {
        val throttle = throttle()
        assertEquals(FrameDelivery.off, throttle.delivery)
        val first = captureTimes(seconds = 2.0)
        assertEquals(first, kept(throttle, first))
        assertTrue(abs((throttle.deliveredFrameRate ?: 0.0) - 60) < 1)

        throttle.configure(FrameDelivery(frameRate = 10.0))
        val second = captureTimes(seconds = 2.0, start = first.last() + 1.0 / 60)
        assertTrue(kept(throttle, second).size < 30)

        throttle.configure(FrameDelivery.off)
        val third = captureTimes(seconds = 2.0, start = second.last() + 1.0 / 60)
        assertEquals(third, kept(throttle, third))
    }

    @Test
    fun `a rate above what the camera captures keeps every frame, with no burst after`() {
        val throttle = throttle()
        throttle.configure(FrameDelivery(frameRate = 120.0))
        val times = captureTimes(fps = 30.0, seconds = 4.0)
        assertEquals(times, kept(throttle, times))
    }

    @Test
    fun `a capture clock that steps back starts the throttle over`() {
        val throttle = throttle()
        throttle.configure(FrameDelivery(frameRate = 2.0))
        assertTrue(throttle.shouldDeliver(500.0))
        assertFalse(throttle.shouldDeliver(500.1))
        assertNull("one frame is no rate", throttle.deliveredFrameRate)
        assertTrue(throttle.shouldDeliver(10.0))
        assertNull("the old session's frames are not counted", throttle.deliveredFrameRate)
        assertFalse(throttle.shouldDeliver(10.0 + 0.1))
    }

    @Test
    fun `two frames at one capture time are no rate`() {
        val throttle = throttle()
        assertTrue(throttle.shouldDeliver(5.0))
        assertTrue(throttle.shouldDeliver(5.0))
        assertNull(throttle.deliveredFrameRate)
    }

    @Test
    fun `the default generator varies intervals too`() {
        val throttle = FrameDeliveryThrottle()
        throttle.configure(FrameDelivery(frameRate = 24.0))
        val kept = kept(throttle, captureTimes(seconds = 10.0))
        assertTrue(abs(kept.size / 10.0 - 24) <= 1.5)
    }

    @Test
    fun `a swing parses low-high-period, prints canonically, and is a triangle starting at low`() {
        val swing = FrameRateSwing.parse(" 24 : 60 : 20 ")
        assertEquals(FrameRateSwing(24.0, 60.0, 20.0), swing)
        assertEquals("24:60:20", swing!!.text)
        assertEquals("29.97:59.94:7.5", FrameRateSwing.parse("29.97:59.94:7.5")?.text)
        assertNotNull("a flat swing is a steady rate", FrameRateSwing.parse("30:30:10"))

        for (bad in listOf(
            "", "24", "24:60", "24:60:20:1", "60:24:20", "0:60:20", "24:300:20", "24:60:0",
            "24:60:-5", "a:b:c", "24:60:Infinity", "x:60:20", "24:x:20"
        )) {
            assertNull(bad, FrameRateSwing.parse(bad))
        }

        assertEquals(24.0, swing.rate(0.0), 1e-9)
        assertEquals(42.0, swing.rate(5.0), 1e-9)
        assertEquals(60.0, swing.rate(10.0), 1e-9)
        assertEquals(42.0, swing.rate(15.0), 1e-9)
        assertEquals(24.0, swing.rate(20.0), 1e-9)
        assertEquals(42.0, swing.rate(25.0), 1e-9)
        assertEquals("before the anchor reads as the previous period", 42.0, swing.rate(-5.0), 1e-9)
    }

    @Test
    fun `a swing wins over a steady rate, and nothing set is off`() {
        assertTrue(FrameDelivery.off.isOff)
        assertNull(FrameDelivery.off.targetRate(3.0))
        assertEquals(24.0, FrameDelivery(frameRate = 24.0).targetRate(3.0)!!, 0.0)
        val both = FrameDelivery(24.0, FrameRateSwing(30.0, 60.0, 10.0))
        assertFalse(both.isOff)
        assertEquals(30.0, both.targetRate(0.0)!!, 0.0)
        assertTrue(FrameDelivery.accepts(1.0))
        assertTrue(FrameDelivery.accepts(240.0))
        assertFalse(FrameDelivery.accepts(0.5))
        assertFalse(FrameDelivery.accepts(Double.NaN))
    }
}
