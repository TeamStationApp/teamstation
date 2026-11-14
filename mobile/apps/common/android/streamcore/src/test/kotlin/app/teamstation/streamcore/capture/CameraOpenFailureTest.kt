package app.teamstation.streamcore.capture

import android.hardware.camera2.CameraDevice
import android.hardware.camera2.FocusTestCameraDevice
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CameraOpenFailureTest {
    @Test fun currentOpenFailuresPublishBeforeOnOpenedButSupersededCallbacksDoNot() {
        val camera = CameraSession(RuntimeEnvironment.getApplication())
        val states = mutableListOf<CameraSession.State>()
        camera.onStateChange = { states.add(it) }
        try {
            val old = camera.beginCameraOpen()
            val current = camera.beginCameraOpen()
            val stale = FocusTestCameraDevice()
            old.onError(stale, CameraDevice.StateCallback.ERROR_CAMERA_IN_USE)
            old.onDisconnected(stale)
            old.onOpened(stale)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(stale.closed)
            assertTrue(states.isEmpty())

            val failed = FocusTestCameraDevice()
            current.onError(failed, CameraDevice.StateCallback.ERROR_CAMERA_IN_USE)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(failed.closed)
            assertFalse(states.last().isRunning)
            assertNotNull(states.last().failure)
            assertFalse(states.last().focus.supported)

            val disconnected = FocusTestCameraDevice()
            camera.beginCameraOpen().onDisconnected(disconnected)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(disconnected.closed)
            assertTrue(states.last().isInterrupted)
            assertEquals("videoInUse", states.last().interruptionReason)
            assertFalse(states.last().isRunning)
        } finally {
            camera.release()
            camera.captureThread.join(5_000)
        }
        assertFalse(camera.captureThread.isAlive)
    }
}
