package app.teamstation.cameraman

import app.teamstation.cameraman.core.CameraParameterSet
import app.teamstation.cameraman.core.CameraParameters
import app.teamstation.cameraman.core.FrameDelivery
import app.teamstation.cameraman.core.FrameRateSwing
import app.teamstation.cameraman.core.FrameRateWander
import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.cameraman.core.InMemorySettingsStore
import app.teamstation.cameraman.core.SeededRandom
import app.teamstation.cameraman.core.WanderSchedule
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.rtsp.RTSPResponder
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The random frame-rate wander on the Pixel (U-T2), draw for draw the iPhone's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FrameRateWanderTest {
    private val wander = FrameRateWander(20.0, 60.0, 2.0, 20.0, 42)
    private val environments = ArrayList<AppEnvironment>()

    @After
    fun tearDown() {
        environments.forEach { it.camera.close() }
    }

    @Test
    fun `SplitMix64 gives the reference sequence, so the Pixel and the iPhone agree`() {
        val random = SeededRandom(1_234_567)
        assertEquals("6457827717110365317", java.lang.Long.toUnsignedString(random.next()))
        assertEquals("3203168211198807973", java.lang.Long.toUnsignedString(random.next()))
        val unit = random.unit()
        assertTrue(unit >= 0 && unit < 1)
    }

    @Test
    fun `the same seed gives the same schedule, another seed another`() {
        val times = (0 until 1_200).map { it * 0.5 }
        val a = WanderSchedule(wander)
        val b = WanderSchedule(wander)
        val c = WanderSchedule(wander.copy(seed = 43))
        val first = times.map { a.rate(it) }
        assertEquals(first, times.map { b.rate(it) })
        assertNotEquals(first, times.map { c.rate(it) })
    }

    @Test
    fun `it starts high, keeps its bounds, and dips about one move in eight`() {
        val schedule = WanderSchedule(wander)
        assertEquals(60.0, schedule.rate(0.0), 0.0)
        schedule.extend(20_000.0)
        for (segment in schedule.segments) {
            val length = segment.end - segment.start
            when {
                segment.isDip -> {
                    assertTrue(segment.from in FrameRateWander.dipRates && segment.from == segment.to)
                    assertTrue(length in FrameRateWander.dipSeconds)
                }
                segment.from == segment.to -> {
                    assertTrue(segment.from in 20.0..60.0)
                    assertTrue(length in 2.0..20.0)
                }
                else -> {
                    assertTrue(segment.to in 20.0..60.0)
                    assertTrue(length in FrameRateWander.rampSeconds)
                }
            }
        }
        val share = schedule.dips.toDouble() / schedule.moves
        assertTrue("${schedule.dips} dips in ${schedule.moves} moves", share > 0.09 && share < 0.16)
        val ramp = schedule.segments.first { it.from != it.to && Math.abs(it.to - it.from) > 10 }
        assertEquals((ramp.from + ramp.to) / 2, schedule.rate((ramp.start + ramp.end) / 2), 1e-9)
        val dip = schedule.segments.indexOfFirst { it.isDip }
        assertEquals(schedule.segments[dip].from, schedule.segments[dip + 1].from, 0.0)
    }

    @Test
    fun `delivered rate follows the wander within 10 percent over steady 2 s windows`() {
        val throttle = FrameDeliveryThrottleTest.throttle()
        throttle.configure(FrameDelivery(24.0, FrameRateSwing(10.0, 12.0, 5.0), wander))
        val schedule = WanderSchedule(wander)
        val times = FrameDeliveryThrottleTest.captureTimes(seconds = 300.0)
        val kept = FrameDeliveryThrottleTest.kept(throttle, times)
        assertTrue(times.containsAll(kept))
        var checked = 0
        var window = 1_002.0
        while (window < 1_298) {
            val count = kept.count { it >= window && it < window + 2 }
            val target = (0 until 200).map { schedule.rate(window - 1_000 + it * 0.01) }.average()
            val ends = (0..2).map { schedule.rate(window - 1_000 + it) }
            if (ends.max() - ends.min() < 0.5) {
                assertTrue("at $window: ${count / 2.0} against $target", Math.abs(count / 2.0 - target) <= maxOf(1.5, target * 0.1))
                checked += 1
            }
            window += 2
        }
        assertTrue(checked > 40)
        assertNotNull(throttle.wanderTarget)
        assertEquals(60.0, FrameDelivery(24.0, wander = wander).targetRate(0.0)!!, 0.0)
        throttle.configure(FrameDelivery.off)
        assertNull(throttle.wanderTarget)
        assertEquals(60, FrameDeliveryThrottleTest.kept(throttle, FrameDeliveryThrottleTest.captureTimes(seconds = 1.0, start = 2_000.0)).size)
    }

    @Test
    fun `it parses with or without a seed and refuses the rest`() {
        assertEquals(wander, FrameRateWander.parse("20:60.0:2:20:42"))
        assertEquals("20:60:2:20:42", wander.text)
        assertEquals("20:60:2:20:7", FrameRateWander.parse("20:60:2:20") { 7L }!!.text)
        assertEquals("18446744073709551615", FrameRateWander.parse("20:60:2:20:18446744073709551615")!!.text.split(":").last())
        assertNotNull(FrameRateWander.parse("20:60:2:20"))
        for (bad in listOf("20:60:2", "60:20:2:20", "20:60:0:5", "20:60:5:2", "20:60:2:20:x", "0.5:60:2:20", "20:60:2:20:1:2", "a:60:2:20")) {
            assertNull(bad, FrameRateWander.parse(bad))
        }
    }

    @Test
    fun `SET test-deliveredFrameRateWander throttles, reads back with its seed, appears in the dump and clears`() {
        val environment = AppEnvironment(
            context = RuntimeEnvironment.getApplication(),
            store = InMemoryIdentityStore(),
            settingsStore = InMemorySettingsStore()
        ).also { environments.add(it) }
        val before = environment.settings.value
        val set = environment.handleParameters(
            RTSPResponder.ParameterRequest(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRateWander: 20:60:2:20:42\r\n")
        )
        assertEquals(200, set.statusCode)
        assertEquals("test.deliveredFrameRateWander: 20:60:2:20:42\r\n", set.body)
        assertEquals(wander, environment.frameThrottle.delivery.wander)
        assertEquals(before, environment.settings.value)
        FrameDeliveryThrottleTest.captureTimes(seconds = 1.0).forEach { environment.frameThrottle.shouldDeliver(it) }
        val json = environment.frameDeliveryJSON()
        assertEquals("20:60:2:20:42", json.getString("wander"))
        assertEquals(60.0, json.getDouble("wanderTarget"), 0.0)

        val bad = environment.handleParameters(
            RTSPResponder.ParameterRequest(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRateWander: 60:20:2:20\r\n")
        )
        assertEquals(400, bad.statusCode)
        val off = environment.handleParameters(
            RTSPResponder.ParameterRequest(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRateWander:\r\n")
        )
        assertEquals(200, off.statusCode)
        assertEquals(FrameDelivery.off, environment.frameThrottle.delivery)

        val encoded = CameraParameters.encode(environment.cameraSnapshot.copy(frameDelivery = FrameDelivery(wander = wander)))
        assertEquals("20:60:2:20:42", encoded["test.deliveredFrameRateWander"])
        val decoded = CameraParameters.decodeSnapshot(CameraParameterSet.decode(encoded.encoded).getOrNull()!!)
        assertEquals(wander, decoded?.frameDelivery?.wander)
    }
}
