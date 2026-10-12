package app.teamstation.streamcore.capture

import app.teamstation.streamcore.phonestream.CameraSessionDevice
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** A phone's camera device ends its capture thread when it closes; Cameraman's session only closes the camera. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CameraSessionReleaseTest {
    @Test
    fun closingThePhonesDeviceEndsItsCaptureThread() {
        val device = CameraSessionDevice(RuntimeEnvironment.getApplication())
        val thread = device.session.captureThread
        assertTrue(thread.isAlive)
        device.reopen()
        device.close()
        thread.join(5_000)
        assertFalse(thread.isAlive)
    }

    @Test
    fun closingASessionKeepsItsThreadForTheNextOpen() {
        val session = CameraSession(RuntimeEnvironment.getApplication())
        session.close()
        session.captureThread.join(200)
        assertTrue(session.captureThread.isAlive)
        session.release()
        session.captureThread.join(5_000)
        assertFalse(session.captureThread.isAlive)
    }
}
