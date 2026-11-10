package app.teamstation.streamcore.core

import org.junit.Assert.*
import org.junit.Test

class CameraFocusTest {
    private val point = FocusPoint.create(0.2, 0.8)!!

    @Test fun commandsValidateAndRoundTrip() {
        for (p in listOf(null, point)) {
            val command = FocusCommand.create("camera-1", "tap_1", p)!!
            assertEquals(command, FocusCommand.parse(command.text))
        }
        for (bad in listOf("", "point:a:b:0", "point:a:b:0:1:2", "auto:a:b:1:1", "point:a:b:NaN:1",
            "point:a:b:0:Infinity", "point:a:b:-0.1:1", "point:a:b:0:1.1", "point:a:b:x:0", "point:a:b:0:x",
            "auto::b", "auto:a:", "auto:a:b c", "auto:a:b\n", "auto:é:b", "scan:a:b", "auto:a:" + "x".repeat(65))) {
            assertNull(bad, FocusCommand.parse(bad))
        }
        assertNull(FocusPoint.create(Double.NaN, 0.0))
        assertNull(FocusPoint.create(0.0, Double.NEGATIVE_INFINITY))
    }

    @Test fun newestScanAndGenerationOwnCompletion() {
        var focus = CameraFocus().reset(true, "camera-1")
        val first = FocusCommand.create("camera-1", "one", point)!!
        val next = FocusCommand.create("camera-1", "two", point)!!
        focus = focus.begin(first)
        assertEquals(FocusPhase.FOCUSING, focus.phase)
        assertEquals(focus, focus.begin(first))
        focus = focus.begin(next)
        assertEquals(focus, focus.complete(first, true))
        focus = focus.complete(next, false)
        assertEquals(FocusPhase.FAILED, focus.phase)
        assertEquals(focus, focus.complete(next, true))
        focus = focus.begin(FocusCommand.create("camera-1", "auto", null)!!)
        assertEquals(FocusPhase.AUTO, focus.phase)
        assertNull(focus.point)
        focus = focus.begin(first).complete(first, true)
        assertEquals(FocusPhase.LOCKED, focus.phase)
        focus = focus.reset(true, "camera-2")
        assertEquals(FocusPhase.RESET, focus.phase)
        assertEquals(focus, focus.begin(next))
        assertEquals(focus, focus.complete(first, true))
        focus = focus.reset(false, "camera-1").begin(next)
        assertEquals(FocusPhase.UNSUPPORTED, focus.phase)
        assertTrue(focus.reset(false).generation.isNotEmpty())
        assertTrue(FocusPhase.entries.all { it.label.isNotEmpty() && it.wire.isNotEmpty() })
    }

    @Test fun mapsTheVisiblePicture() {
        fun map(x: Double, y: Double, fill: Boolean = false, mirror: Boolean = false, zoom: Double = 1.0) =
            FocusGeometry.imagePoint(x, y, 200.0, 200.0, 200.0, 100.0, fill, mirror, zoom)
        assertEquals(FocusPoint.create(0.0, 0.0), map(0.0, 50.0))
        assertEquals(FocusPoint.create(1.0, 1.0), map(200.0, 150.0))
        for ((x, y) in listOf(100.0 to 49.0, 100.0 to 151.0, -1.0 to 50.0, 201.0 to 50.0, 0.0 to -1.0, 0.0 to 201.0)) {
            assertNull(map(x, y))
        }
        assertEquals(FocusPoint.create(0.25, 0.0), map(0.0, 0.0, fill = true))
        assertEquals(FocusPoint.create(1.0, 0.0), map(0.0, 50.0, mirror = true))
        assertEquals(FocusPoint.create(0.25, 0.25), map(0.0, 50.0, zoom = 2.0))
        assertNull(map(0.0, 50.0, zoom = 0.0))
        assertNull(map(Double.NaN, 50.0))
        for (index in 0..3) {
            val dimensions = MutableList(4) { 1.0 }.apply { this[index] = 0.0 }
            assertNull(FocusGeometry.imagePoint(0.0, 0.0, dimensions[0], dimensions[1], dimensions[2], dimensions[3]))
        }
        val corner = FocusPoint.create(0.0, 1.0)!!
        assertEquals(corner, FocusGeometry.unrotated(corner, 0, false))
        assertEquals(FocusPoint.create(1.0, 1.0), FocusGeometry.unrotated(corner, 90, false))
        assertEquals(FocusPoint.create(1.0, 0.0), FocusGeometry.unrotated(corner, 180, false))
        assertEquals(FocusPoint.create(0.0, 0.0), FocusGeometry.unrotated(corner, -90, false))
        assertEquals(FocusPoint.create(1.0, 1.0), FocusGeometry.unrotated(corner, 0, true))
        assertNull(FocusGeometry.unrotated(corner, 45, false))
    }
}
