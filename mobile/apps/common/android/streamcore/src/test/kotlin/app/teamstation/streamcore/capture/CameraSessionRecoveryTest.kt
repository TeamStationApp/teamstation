package app.teamstation.streamcore.capture

import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.StreamSettings
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CameraSessionRecoveryTest {
    @Test fun publicReopenForcesRecoveryAfterConfigurationFailureAndLeavesHealthyCaptureAlone() {
        val attempts = CopyOnWriteArrayList<Boolean>()
        val failed = CountDownLatch(1)
        val recovered = CountDownLatch(1)
        val camera = CameraSession(RuntimeEnvironment.getApplication()) { position, recovering, state ->
            assertEquals(CameraPosition.BACK, position)
            attempts.add(recovering)
            if (attempts.size == 1) {
                failed.countDown()
                state.copy(isRunning = false, failure = "could not configure the capture session")
            } else {
                assertNotNull(state.failure)
                recovered.countDown()
                state.copy(isRunning = true, failure = null)
            }
        }
        try {
            camera.configure(CameraPosition.BACK, StreamSettings.default)
            assertTrue(failed.await(5, TimeUnit.SECONDS))
            camera.reopen()
            assertTrue(recovered.await(5, TimeUnit.SECONDS))
            camera.reopen()
        } finally {
            // The release is queued after reopen, so joining also proves the healthy retry was handled.
            camera.release()
            camera.captureThread.join(5_000)
        }
        assertEquals(listOf(false, true), attempts)
        assertFalse(camera.captureThread.isAlive)
    }
}
