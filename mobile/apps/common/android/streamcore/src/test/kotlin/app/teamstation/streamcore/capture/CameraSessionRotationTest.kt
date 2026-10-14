package app.teamstation.streamcore.capture

import org.junit.Assert.assertEquals
import org.junit.Test

/** A portrait display leaves the capture angle the landscape hold had. */
class CameraSessionRotationTest {
    @Test
    fun portraitDisplayLeavesTheLandscapeAngle() {
        val heldRight = CameraSession.captureRotation(90, 90, false)
        val heldLeft = CameraSession.captureRotation(90, 270, false)
        assertEquals(90, heldRight)
        assertEquals(270, heldLeft)
        assertEquals(90, CameraSession.appliedCaptureAngle(heldRight, 90, 0))
        assertEquals(
            90,
            CameraSession.appliedCaptureAngle(
                CameraSession.captureRotation(90, 0, false),
                0,
                heldRight
            )
        )
        assertEquals(270, CameraSession.appliedCaptureAngle(heldLeft, 270, heldRight))
        assertEquals(
            270,
            CameraSession.appliedCaptureAngle(
                CameraSession.captureRotation(90, 180, false),
                180,
                heldLeft
            )
        )
    }
}
