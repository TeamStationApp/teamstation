package app.teamstation.cameraman

import app.teamstation.cameraman.core.*
import app.teamstation.streamcore.core.*
import org.junit.Assert.*
import org.junit.Test

class FocusParametersTest {
    @Test fun wireRoundTripAndCompatibility() {
        val command = FocusCommand.create("generation", "tap", FocusPoint.create(0.2, 0.8))!!
        val focus = CameraFocus().reset(true, "generation").begin(command).complete(command, true)
        val snapshot = CameraParametersTest.snapshot().copy(focus = focus)
        val encoded = CameraParameters.encode(snapshot)
        assertEquals(focus, CameraParameters.decodeSnapshot(encoded)?.focus)
        val write = CameraParameters.parseSet("focus.command: ${command.text}", snapshot).getOrNull()!!
        assertEquals(command, write.focus)
        assertFalse(write.isEmpty)
        assertFalse(write.touchesSettings)
        assertEquals(command.text, CameraParameters.echo(write, snapshot)["focus.command"])
        for (body in listOf("focus.state: locked", "focus.command: point:old:tap:0:1", "focus.command: nonsense",
            "focus.command: ${command.text}\nptz.zoom: 1", "focus.command: ${command.text}\nfocus.command: ${command.text}")) {
            assertNotNull(body, CameraParameters.parseSet(body, snapshot).errorOrNull())
        }
        assertNotNull(CameraParameters.parseSet("focus.command: ${command.text}", snapshot.copy(focus = focus.copy(supported = false))).errorOrNull())
        val failedAuto = snapshot.copy(focus = focus.copy(point = null, phase = FocusPhase.FAILED))
        assertEquals(failedAuto.focus, CameraParameters.decodeSnapshot(CameraParameters.encode(failedAuto))?.focus)
        val old = CameraParameterSet()
        encoded.pairs.filter { !it.first.startsWith("focus.") }.forEach { old.set(it.first, it.second) }
        assertEquals(CameraFocus(), CameraParameters.decodeSnapshot(old)?.focus)
        old.set("focus.supported", "true")
        assertEquals(CameraFocus(), CameraParameters.decodeSnapshot(old)?.focus)
        for ((key, value) in listOf("focus.state" to "mystery", "focus.generation" to "", "focus.rotation" to "45",
            "focus.mirrored" to "maybe", "focus.x" to "NaN", "focus.request" to "bad token")) {
            val bad = CameraParameterSet()
            encoded.pairs.forEach { bad.set(it.first, it.second) }
            bad.set(key, value)
            assertEquals(key, CameraFocus(), CameraParameters.decodeSnapshot(bad)?.focus)
        }
        assertEquals("locked", CameraParameters.respondToGet("focus.state", snapshot).getOrNull()?.get("focus.state"))
    }
}
