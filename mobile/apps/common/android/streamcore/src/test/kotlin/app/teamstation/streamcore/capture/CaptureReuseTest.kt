package app.teamstation.streamcore.capture

import org.junit.Assert.*
import org.junit.Test

class CaptureReuseTest {
    @Test fun configureFailureAndRecoveryCannotReuseAStaleDevice() {
        assertTrue(canReuseCapture(false, null, true, true, true, true))
        // Configure failure can retain the device but has no valid session or builder.
        assertFalse(canReuseCapture(false, "configure failed", false, true, false, false))
        // Recovery always reopens, even if callbacks have left apparently healthy fields.
        assertFalse(canReuseCapture(true, null, true, true, true, true))
        assertFalse(canReuseCapture(false, "could not start capture", true, true, true, true))
        assertFalse(canReuseCapture(false, null, false, true, true, true))
        assertFalse(canReuseCapture(false, null, true, false, true, true))
        assertFalse(canReuseCapture(false, null, true, true, false, true))
        assertFalse(canReuseCapture(false, null, true, true, true, false))
    }
}
