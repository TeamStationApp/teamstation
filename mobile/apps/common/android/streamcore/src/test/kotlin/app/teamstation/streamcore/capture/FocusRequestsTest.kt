package app.teamstation.streamcore.capture

import android.hardware.camera2.CameraMetadata.*
import app.teamstation.streamcore.core.FocusCommand
import app.teamstation.streamcore.core.FocusPhase
import app.teamstation.streamcore.core.FocusPoint
import org.junit.Assert.*
import org.junit.Test

class FocusRequestsTest {
    data class Request(val mode: Int, val trigger: Int, val command: FocusCommand?, val repeating: Boolean)

    @Test fun aThrowingStartCannotLeakItsTriggerIntoTheNextRepeatingRequest() {
        var builderMode = CONTROL_AF_MODE_CONTINUOUS_VIDEO
        var builderTrigger = CONTROL_AF_TRIGGER_IDLE
        val submitted = mutableListOf<Request>()
        val focus = FocusRequests({ mode, trigger, command, repeating ->
            builderMode = mode
            submitWithIdleTrigger(trigger, { builderTrigger = it }) {
                submitted.add(Request(builderMode, builderTrigger, command, repeating))
                if (trigger == CONTROL_AF_TRIGGER_START) error("session reconfigured")
            }
        }, {})
        focus.reset(true)
        val command = FocusCommand.create(focus.state.generation, "tap", FocusPoint.create(.2, .8))!!
        focus.apply(command)
        assertEquals(listOf(CONTROL_AF_TRIGGER_CANCEL, CONTROL_AF_TRIGGER_START), submitted.map { it.trigger })
        assertEquals(FocusPhase.FAILED, focus.state.phase)
        // Zoom/settings can reuse the shared builder immediately after the failed submit.
        assertEquals(CONTROL_AF_MODE_AUTO, builderMode)
        assertEquals(CONTROL_AF_TRIGGER_IDLE, builderTrigger)
        try {
            submitWithIdleTrigger(CONTROL_AF_TRIGGER_CANCEL, { builderTrigger = it }) { error("closed") }
        } catch (_: IllegalStateException) { }
        assertEquals(CONTROL_AF_TRIGGER_IDLE, builderTrigger)
    }

    @Test fun unmappableRequestsAreAcknowledgedAsFailedWithoutSubmittingToHardware() {
        val focus = FocusRequests({ _, _, _, _ -> error("must not submit") }, {})
        focus.reset(true)
        val command = FocusCommand.create(focus.state.generation, "tap", FocusPoint.create(.2, .8))!!
        focus.reject(command)
        assertEquals("tap", focus.state.request)
        assertEquals(FocusPhase.FAILED, focus.state.phase)
        focus.reset(true)
        val generation = focus.state.generation
        focus.reject(command)
        assertEquals(generation, focus.state.generation)
        assertEquals(FocusPhase.RESET, focus.state.phase)
    }

    @Test fun automaticLensSwitchKeepsAutoGenerationButInvalidatesHeldPoint() {
        var submissions = 0
        val focus = FocusRequests({ _, _, _, _ -> submissions++ }, {})
        focus.reset(true)
        val auto = FocusCommand.create(focus.state.generation, "auto", null)!!
        focus.apply(auto)
        val generation = focus.state.generation
        val before = submissions
        assertFalse(focus.lensChanged())
        assertEquals(generation, focus.state.generation)
        assertEquals(FocusPhase.AUTO, focus.state.phase)
        assertEquals(before, submissions)
        val tap = FocusCommand.create(generation, "tap", FocusPoint.create(.2, .7))!!
        focus.apply(tap)
        focus.result(tap, CONTROL_AF_STATE_FOCUSED_LOCKED)
        assertTrue(focus.lensChanged())
        assertNotEquals(generation, focus.state.generation)
        assertEquals(FocusPhase.RESET, focus.state.phase)
        assertFalse(focus.lensChanged())
    }

    @Test fun scansOnceHoldsAndExplicitlyRestoresContinuous() {
        val requests = mutableListOf<Request>()
        val focus = FocusRequests({ m, t, c, r -> requests.add(Request(m, t, c, r)) }, {})
        focus.reset(true)
        val command = FocusCommand.create(focus.state.generation, "tap", FocusPoint.create(.2, .8))!!
        focus.apply(command)
        assertEquals(listOf(CONTROL_AF_TRIGGER_CANCEL, CONTROL_AF_TRIGGER_START, CONTROL_AF_TRIGGER_IDLE), requests.map { it.trigger })
        assertEquals(listOf(false, false, true), requests.map { it.repeating })
        assertNull(requests[0].command)
        assertEquals(FocusPhase.FOCUSING, focus.state.phase)
        focus.result(null, CONTROL_AF_STATE_FOCUSED_LOCKED)
        focus.result(command, CONTROL_AF_STATE_ACTIVE_SCAN)
        assertEquals(FocusPhase.FOCUSING, focus.state.phase)
        focus.result(command, CONTROL_AF_STATE_FOCUSED_LOCKED)
        assertEquals(FocusPhase.LOCKED, focus.state.phase)
        focus.timeout(command)
        focus.apply(command)
        assertEquals(3, requests.size)
        assertEquals(FocusPhase.LOCKED, focus.state.phase)
        val auto = FocusCommand.create(focus.state.generation, "auto", null)!!
        focus.apply(auto)
        assertEquals(CONTROL_AF_MODE_CONTINUOUS_VIDEO, requests.last().mode)
        assertEquals(CONTROL_AF_TRIGGER_IDLE, requests.last().trigger)
        assertEquals(FocusPhase.AUTO, focus.state.phase)
        focus.result(command, CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)
        assertEquals(FocusPhase.AUTO, focus.state.phase)
    }

    @Test fun newerRequestsGenerationFailuresAndUnsupportedStayAuthoritative() {
        var count = 0
        val focus = FocusRequests({ _, _, _, _ -> count++ }, {})
        focus.reset(true)
        val first = FocusCommand.create(focus.state.generation, "one", FocusPoint.create(.1,.1))!!
        val second = FocusCommand.create(focus.state.generation, "two", FocusPoint.create(.9,.9))!!
        focus.apply(first)
        focus.apply(second)
        focus.result(first, CONTROL_AF_STATE_FOCUSED_LOCKED)
        assertEquals(FocusPhase.FOCUSING, focus.state.phase)
        focus.result(second, CONTROL_AF_STATE_NOT_FOCUSED_LOCKED)
        assertEquals(FocusPhase.FAILED, focus.state.phase)
        focus.reset(true)
        focus.apply(first)
        assertEquals(6, count)
        val timeout = FocusCommand.create(focus.state.generation, "timeout", first.point)!!
        focus.apply(timeout)
        focus.timeout(timeout)
        assertEquals(FocusPhase.FAILED, focus.state.phase)
        focus.reset(false)
        focus.apply(FocusCommand.create(focus.state.generation, "unsupported", first.point)!!)
        assertEquals(FocusPhase.UNSUPPORTED, focus.state.phase)
        assertEquals(9, count)
        val broken = FocusRequests({ _, _, _, _ -> error("camera closed") }, {})
        broken.reset(true)
        broken.apply(FocusCommand.create(broken.state.generation, "error", null)!!)
        assertEquals(FocusPhase.FAILED, broken.state.phase)
    }
}
