package app.teamstation.cameraman

import app.teamstation.cameraman.core.CameraParameterSet
import app.teamstation.cameraman.core.CameraParameters
import app.teamstation.cameraman.core.FrameDelivery
import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.cameraman.core.Struggle
import app.teamstation.cameraman.core.StruggleInjector
import app.teamstation.cameraman.core.WindowSchedule
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.rtsp.RTSPResponder
import app.teamstation.cameraman.rtsp.SendDelayLine
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.Collections
import kotlin.math.abs

/** The struggling-phone injection on the Pixel (U-T3), draw for draw the iPhone's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StruggleInjectorTest {
    private val struggle = Struggle(0.3, 0.2, 0.4, 42)
    private val environments = ArrayList<AppEnvironment>()

    @After
    fun tearDown() {
        environments.forEach { it.camera.close() }
    }

    private fun keptSound(injector: StruggleInjector, seconds: Double, start: Double = 500.0): List<Double> =
        (0 until (seconds / 0.02).toInt()).map { start + it * 0.02 }.filter { injector.keepsSound(it, 0.02) }

    @Test
    fun `it parses mic-hold-slow and an optional seed, and picks one when none is given`() {
        assertEquals(struggle, Struggle.parse("0.3:0.2:0.40:42"))
        assertEquals("0.3:0.2:0.4:42", struggle.text)
        assertEquals("0.1:0:0:9", Struggle.parse(" 0.1 :0:0") { 9 }?.text)
        assertNotNull(Struggle.parse("0.1:0:0"))
        assertEquals("0:0:0:18446744073709551615", Struggle.parse("0:0:0:18446744073709551615")?.text)
        assertTrue(Struggle.parse("0:0:0:1")!!.isOff)
        assertFalse(struggle.isOff)
        for (bad in listOf("0.1:0.1", "0.6:0:0", "0:0.95:0", "0:0:0.99", "-0.1:0:0", "x:0:0", "0:x:0", "0:0:x", "0:0:0:x", "0:0:0:1:2")) {
            assertNull(bad, Struggle.parse(bad))
        }
    }

    @Test
    fun `seed 42 gives the reference windows, the same as the iPhone`() {
        val mic = WindowSchedule(42L xor 0x6D69_6300L, 0.3, StruggleInjector.micBurst)
        mic.extend(1.9)
        val expected = listOf(0.0507550039774627 to 0.14469268888014095, 0.7341667420834092 to 1.1055584468036428, 1.8284648219572681 to 1.9539141295388622)
        expected.forEachIndexed { index, (start, end) ->
            assertEquals(start, mic.windows[index].start, 1e-12)
            assertEquals(end, mic.windows[index].endInclusive, 1e-12)
        }
        val hold = WindowSchedule(42L xor 0x686F_6C64L, 0.2, StruggleInjector.holdLength)
        assertEquals(6.984956325811961..8.186338227362327, hold.windowAt(7.0))
    }

    @Test
    fun `windows take about their level of the time, within their lengths, starting with a gap`() {
        val schedule = WindowSchedule(7, 0.3, 0.3..2.0)
        schedule.extend(20_000.0)
        val covered = schedule.windows.sumOf { it.endInclusive - it.start }
        assertTrue(abs(covered / schedule.windows.last().endInclusive - 0.3) < 0.03)
        assertTrue(schedule.windows.all { (it.endInclusive - it.start) in 0.3..2.0 })
        assertTrue(schedule.windows.zipWithNext().all { (a, b) -> a.endInclusive <= b.start })
        val other = WindowSchedule(8, 0.3, 0.3..2.0)
        val again = WindowSchedule(7, 0.3, 0.3..2.0)
        val times = (0 until 3_000).map { it * 0.1 }
        val first = times.map { again.windowAt(it) }
        assertEquals(first, times.map { schedule.windowAt(it) })
        assertTrue(first != times.map { other.windowAt(it) })
        val none = WindowSchedule(7, 0.0, 0.3..2.0)
        assertNull(none.windowAt(10.0))
        none.extend(100.0)
        assertTrue(none.windows.isEmpty())
    }

    @Test
    fun `mic loss drops about its level of the sound in bursts and reports it`() {
        val injector = StruggleInjector()
        injector.configure(Struggle(0.3, 0.0, 0.0, 42))
        val kept = keptSound(injector, 1_200.0)
        val dropped = 60_000 - kept.size
        assertTrue("$dropped", abs(dropped / 60_000.0 - 0.3) < 0.04)
        assertEquals(dropped * 0.02, injector.summary().droppedSoundSeconds, 1e-6)
        val gaps = kept.zipWithNext { a, b -> b - a }.filter { it > 0.03 }
        assertTrue(gaps.count { it <= StruggleInjector.micBurst.endInclusive + 0.041 } > gaps.size * 0.8)
        assertTrue(gaps.all { it < 2 })
        assertTrue(injector.keepsFrame(1.0))
        assertNull(injector.holdRelease(1.0))
    }

    @Test
    fun `slow windows thin the pictures to one every 50-250 ms`() {
        val injector = StruggleInjector()
        injector.configure(Struggle(0.0, 0.0, 0.4, 5))
        val times = FrameDeliveryThrottleTest.captureTimes(seconds = 600.0)
        val kept = times.filter { injector.keepsFrame(it) }
        val dropped = times.size - kept.size
        assertEquals(dropped.toLong(), injector.summary().droppedFrames)
        val share = dropped.toDouble() / times.size
        assertTrue("$share", share > 0.25 && share < 0.45)
        val spacings = kept.zipWithNext { a, b -> b - a }
        assertTrue(spacings.all { it <= StruggleInjector.slowSpacing.endInclusive + 0.02 })
        assertTrue(spacings.any { it > 0.1 })
        assertTrue(injector.keepsSound(1.0, 1.0))
    }

    @Test
    fun `holds cover about their level of the time and release at their end`() {
        val injector = StruggleInjector()
        injector.configure(Struggle(0.0, 0.2, 0.0, 11))
        val times = (0 until 120_000).map { 100.0 + it * 0.01 }
        val releases = times.map { injector.holdRelease(it) }
        val share = releases.count { it != null }.toDouble() / times.size
        assertTrue("$share", abs(share - 0.2) < 0.04)
        times.zip(releases).forEach { (time, release) ->
            if (release != null) assertTrue(release > time && release - time <= 2)
        }
        val holds = injector.summary().holds
        assertTrue("$holds", holds in 101..299)
        val first = releases.indexOfFirst { it != null }
        assertEquals(releases[first], releases[first + 1])
        injector.configure(null)
        assertNull(injector.struggle)
        assertNull(injector.holdRelease(5.0))
        assertEquals(0, injector.summary().holds)
        injector.configure(Struggle(0.0, 0.0, 0.0, 1))
        assertNull(injector.struggle)
    }

    @Test
    fun `a held delay line keeps the stream in order and releases it in one burst`() {
        val line = SendDelayLine()
        val start = System.nanoTime() / 1_000_000_000.0
        val order = Collections.synchronizedList(ArrayList<Int>())
        line.setHoldRelease { now -> if (now < start + 0.3) start + 0.3 else null }
        line.submit { order.add(1) }
        line.submit { order.add(2) }
        assertEquals(2, line.summary().held)
        assertTrue(order.isEmpty())
        Thread.sleep(400)
        line.submit { order.add(3) }
        Thread.sleep(100)
        assertEquals(listOf(1, 2, 3), order.toList())
        line.setHoldRelease(null)
        line.submit { order.add(4) }
        assertEquals(listOf(1, 2, 3, 4), order.toList())
    }

    @Test
    fun `a send that arrives while a hold's burst is going out waits for the burst`() {
        val line = SendDelayLine()
        val start = System.nanoTime() / 1_000_000_000.0
        val order = Collections.synchronizedList(ArrayList<Int>())
        line.setHoldRelease { now -> if (now < start + 0.2) start + 0.2 else null }
        for (value in 1..3) line.submit { Thread.sleep(50); order.add(value) }
        Thread.sleep(260)
        line.submit { order.add(4) }
        Thread.sleep(300)
        assertEquals(listOf(1, 2, 3, 4), order.toList())
    }

    @Test
    fun `SET test-struggle starts it, reads back, keeps the throttle's clock, appears in the dump and clears`() {
        val environment = AppEnvironment(
            context = RuntimeEnvironment.getApplication(),
            store = InMemoryIdentityStore(),
            settingsStore = InMemorySettingsStore()
        ).also { environments.add(it) }
        val before = environment.settings.value
        fun set(body: String) = environment.handleParameters(
            RTSPResponder.ParameterRequest(RTSPResponder.ParameterRequest.Method.SET, body)
        )
        set("test.deliveredFrameRate: 30\r\n")
        assertTrue(environment.deliversFrame(100_000_000_000))
        val started = set("test.struggle: 0.3:0.2:0.4:42\r\n")
        assertEquals(200, started.statusCode)
        assertEquals("test.struggle: 0.3:0.2:0.4:42\r\n", started.body)
        assertEquals(struggle, environment.struggle.struggle)
        assertEquals(struggle, environment.frameThrottle.delivery.struggle)
        assertEquals(30.0, environment.frameThrottle.delivery.frameRate, 0.0)
        // The throttle kept its clock: a hundredth of a second later is too soon at 30 fps.
        assertFalse(environment.deliversFrame(100_010_000_000))
        assertEquals(before, environment.settings.value)

        val json = environment.frameDeliveryJSON()
        assertEquals("0.3:0.2:0.4:42", json.getString("struggle"))
        assertEquals(0, json.getInt("struggleHolds"))
        assertEquals(0.0, json.getDouble("struggleDroppedSoundSeconds"), 0.0)
        assertEquals(0L, json.getLong("struggleDroppedFrames"))

        val unseeded = set("test.struggle: 0.1:0:0\r\n")
        val seed = environment.struggle.struggle!!.seed
        assertEquals("test.struggle: 0.1:0:0:${java.lang.Long.toUnsignedString(seed)}\r\n", unseeded.body)
        assertEquals(400, set("test.struggle: 0.9:0:0\r\n").statusCode)
        // Changing the rate leaves the struggle running.
        set("test.deliveredFrameRate: 0\r\n")
        assertEquals(seed, environment.struggle.struggle?.seed)
        assertEquals(200, set("test.struggle:\r\n").statusCode)
        assertNull(environment.struggle.struggle)
        assertEquals(FrameDelivery.off, environment.frameThrottle.delivery)

        val encoded = CameraParameters.encode(environment.cameraSnapshot.copy(frameDelivery = FrameDelivery(struggle = struggle)))
        assertEquals("0.3:0.2:0.4:42", encoded["test.struggle"])
        val decoded = CameraParameters.decodeSnapshot(CameraParameterSet.decode(encoded.encoded).getOrNull()!!)
        assertEquals(struggle, decoded?.frameDelivery?.struggle)
    }
}
