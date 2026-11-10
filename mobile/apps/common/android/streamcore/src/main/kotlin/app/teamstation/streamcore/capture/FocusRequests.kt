package app.teamstation.streamcore.capture

import android.hardware.camera2.CameraMetadata
import app.teamstation.streamcore.core.CameraFocus
import app.teamstation.streamcore.core.FocusCommand
import app.teamstation.streamcore.core.FocusPhase

/** Runs on the capture handler. The port submits requests against the existing session. */
internal class FocusRequests(
    private val submit: (mode: Int, trigger: Int, command: FocusCommand?, repeating: Boolean) -> Unit,
    private val changed: (CameraFocus) -> Unit,
    private val failure: (Exception) -> Unit = {}
) {
    var state = CameraFocus()
        private set

    fun reset(supported: Boolean) {
        state = state.reset(supported)
        changed(state)
    }

    /** Auto focus can follow the logical camera across lenses without invalidating commands. */
    fun lensChanged(): Boolean {
        if (state.point == null || state.phase !in listOf(FocusPhase.FOCUSING, FocusPhase.LOCKED, FocusPhase.FAILED)) return false
        reset(state.supported)
        return true
    }

    fun apply(command: FocusCommand) {
        if (command.generation != state.generation || command.token == state.request) return
        state = state.begin(command)
        changed(state)
        if (!state.supported) return
        try {
            // CANCEL carries no new token, so its result cannot finish the new request.
            submit(CameraMetadata.CONTROL_AF_MODE_AUTO, CameraMetadata.CONTROL_AF_TRIGGER_CANCEL, null, false)
            if (command.point != null) {
                submit(CameraMetadata.CONTROL_AF_MODE_AUTO, CameraMetadata.CONTROL_AF_TRIGGER_START, command, false)
                submit(CameraMetadata.CONTROL_AF_MODE_AUTO, CameraMetadata.CONTROL_AF_TRIGGER_IDLE, command, true)
            } else {
                submit(CameraMetadata.CONTROL_AF_MODE_CONTINUOUS_VIDEO, CameraMetadata.CONTROL_AF_TRIGGER_IDLE, command, true)
            }
        } catch (error: Exception) {
            failure(error)
            state = state.copy(phase = FocusPhase.FAILED)
            changed(state)
        }
    }

    /** A valid request that could not be mapped still receives an authoritative response. */
    fun reject(command: FocusCommand) {
        if (command.generation != state.generation || command.token == state.request) return
        state = state.begin(command)
        if (state.supported) state = state.copy(phase = FocusPhase.FAILED)
        changed(state)
    }

    fun result(command: FocusCommand?, afState: Int?) {
        if (command == null) return
        val success = when (afState) {
            CameraMetadata.CONTROL_AF_STATE_FOCUSED_LOCKED -> true
            CameraMetadata.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED -> false
            else -> return
        }
        val next = state.complete(command, success)
        if (next != state) { state = next; changed(state) }
    }

    fun timeout(command: FocusCommand) {
        val next = state.complete(command, false)
        if (next != state) { state = next; changed(state) }
    }
}
