package app.teamstation.cameraman

import app.teamstation.cameraman.core.CameraParameterSet
import app.teamstation.cameraman.core.FrameDelivery
import app.teamstation.cameraman.core.FrameRateSwing
import app.teamstation.cameraman.core.InMemoryIdentityStore
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.harness.ControlCommand
import app.teamstation.cameraman.rtsp.RTSPResponder
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The test throttle as the phone runs it: set over the parameter port, reported back, and never a
 * settings change, so the format, the session and the sound stay as they were.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FrameDeliveryEnvironmentTest {
    private val environments = ArrayList<AppEnvironment>()

    private fun environment(): AppEnvironment = AppEnvironment(
        context = RuntimeEnvironment.getApplication(),
        store = InMemoryIdentityStore(),
        settingsStore = InMemorySettingsStore()
    ).also { environments.add(it) }

    @After
    fun tearDown() {
        environments.forEach { it.camera.close() }
    }

    private fun AppEnvironment.parameters(method: RTSPResponder.ParameterRequest.Method, body: String) =
        handleParameters(RTSPResponder.ParameterRequest(method, body))

    @Test
    fun `SET test-deliveredFrameRate throttles without touching settings, and GET and the dump report it`() {
        val environment = environment()
        assertEquals("off at launch", FrameDelivery.off, environment.frameThrottle.delivery)
        val before = environment.settings.value

        val set = environment.parameters(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRate: 24\r\n")
        assertEquals(200, set.statusCode)
        assertEquals("test.deliveredFrameRate: 24\r\n", set.body)
        assertEquals(FrameDelivery(frameRate = 24.0), environment.frameThrottle.delivery)
        assertEquals("format, rate, codec and sound are untouched", before, environment.settings.value)

        val swing = environment.parameters(
            RTSPResponder.ParameterRequest.Method.SET,
            "test.deliveredFrameRate: 0\r\ntest.deliveredFrameRateSwing: 24:60:20\r\n"
        )
        assertEquals(200, swing.statusCode)
        assertEquals(FrameDelivery(swing = FrameRateSwing(24.0, 60.0, 20.0)), environment.frameThrottle.delivery)

        // A second of 60 fps capture, in camera nanoseconds.
        val kept = (0 until 60).count { environment.deliversFrame(5_000_000_000L + it * 16_666_667L) }
        assertTrue("kept $kept", kept in 20..45)

        val get = environment.parameters(
            RTSPResponder.ParameterRequest.Method.GET,
            "test.deliveredFrameRate\r\ntest.deliveredFrameRateSwing\r\ntest.deliveredFrameRate.actual\r\n"
        )
        assertEquals(200, get.statusCode)
        val reply = CameraParameterSet.decode(get.body).getOrNull()!!
        assertEquals("0", reply["test.deliveredFrameRate"])
        assertEquals("24:60:20", reply["test.deliveredFrameRateSwing"])
        val actual = reply["test.deliveredFrameRate.actual"]?.toDoubleOrNull()
        assertNotNull(actual)
        assertTrue("$actual", actual!! > 20 && actual < 45)

        val dump = environment.frameDeliveryJSON()
        assertEquals(0.0, dump.getDouble("frameRate"), 0.0)
        assertEquals("24:60:20", dump.getString("swing"))
        assertFalse(dump.isNull("deliveredFrameRate"))

        val off = environment.parameters(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRateSwing:\r\n")
        assertEquals(200, off.statusCode)
        assertEquals(FrameDelivery.off, environment.frameThrottle.delivery)
        assertEquals(before, environment.settings.value)

        assertEquals(
            458,
            environment.parameters(RTSPResponder.ParameterRequest.Method.SET, "test.deliveredFrameRate.actual: 5\r\n")
                .statusCode
        )
    }

    @Test
    fun `a new launch starts with the throttle off, and a harness reset turns it off`() {
        val first = environment()
        first.frameThrottle.configure(FrameDelivery(frameRate = 12.0))
        val second = environment()
        assertEquals(FrameDelivery.off, second.frameThrottle.delivery)
        val dump = second.frameDeliveryJSON()
        assertEquals(0.0, dump.getDouble("frameRate"), 0.0)
        assertTrue(dump.isNull("swing"))
        assertTrue(dump.isNull("deliveredFrameRate"))

        second.frameThrottle.configure(FrameDelivery(frameRate = 12.0))
        second.handle(ControlCommand.Reset)
        assertEquals(FrameDelivery.off, second.frameThrottle.delivery)
    }
}
