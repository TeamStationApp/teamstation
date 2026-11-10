package app.teamstation.streamcore.capture

import android.hardware.camera2.CameraMetadata

/** A one-shot trigger must never leak into a later repeating request, even when submission throws. */
internal inline fun submitWithIdleTrigger(trigger: Int, setTrigger: (Int) -> Unit, submit: () -> Unit) {
    try {
        setTrigger(trigger)
        submit()
    } finally {
        setTrigger(CameraMetadata.CONTROL_AF_TRIGGER_IDLE)
    }
}
