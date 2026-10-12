package app.teamstation.streamcore

import app.teamstation.streamcore.core.BatteryStatus
import app.teamstation.streamcore.core.ThermalBadgeLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two overlay pills, ported from the iOS build's suites so both platforms round the same way and
 * turn colour at the same threshold. An operator reading a bench of mixed handsets sees one
 * vocabulary or the port has failed at the thing it was for.
 */
class BatteryStatusTest {

    @Test
    fun `a 0 to 1 level becomes a percentage, and unknown is null`() {
        assertEquals(87, BatteryStatus.fromLevel(0.87, false)?.percent)
        assertEquals(BatteryStatus.of(100, true), BatteryStatus.fromLevel(1.0, true))
        assertEquals(0, BatteryStatus.fromLevel(0.0, false)?.percent)
        // A simulator, and an emulator, report a negative level.
        assertNull(BatteryStatus.fromLevel(-1.0, false))
        assertNull(BatteryStatus.fromLevel(Double.NaN, false))
        assertEquals(100, BatteryStatus.of(140).percent)
        assertEquals(0, BatteryStatus.of(-5).percent)
    }

    @Test
    fun `the raw level is divided by the reported scale, not by 100`() {
        // ACTION_BATTERY_CHANGED's scale is whatever the device says it is; assuming 100 is the
        // difference between a percentage and a number that merely looks like one.
        assertEquals(50, BatteryStatus.fromLevelAndScale(50, 100, false)?.percent)
        assertEquals(50, BatteryStatus.fromLevelAndScale(128, 256, false)?.percent)
        assertNull(BatteryStatus.fromLevelAndScale(-1, 100, false))
        assertNull(BatteryStatus.fromLevelAndScale(50, 0, false))
    }

    @Test
    fun `under twenty per cent is low and turns yellow`() {
        assertFalse(BatteryStatus.of(20).isLow)
        assertTrue(BatteryStatus.of(19).isLow)
        assertEquals(BatteryStatus.of(100).hue, BatteryStatus.of(50).hue)
        assertNotEquals(BatteryStatus.of(20).hue, BatteryStatus.of(19).hue)

        val low = BatteryStatus.of(5).hue
        assertTrue("yellow, not green", low.red > low.blue && low.green > low.blue)
        val full = BatteryStatus.of(80).hue
        assertTrue("green", full.green > full.red)
    }

    @Test
    fun `the label is the percentage`() {
        assertEquals("87%", BatteryStatus.of(87).label)
        assertEquals("100%", BatteryStatus.of(100, isCharging = true).label)
    }
}

class ThermalBadgeLevelTest {

    @Test
    fun `the telemetry word maps to the operator's word`() {
        // The state dump keeps the platform's vocabulary; the pill uses the operator's.
        assertEquals(ThermalBadgeLevel.COOL, ThermalBadgeLevel.fromTelemetryName("nominal"))
        assertEquals(ThermalBadgeLevel.FAIR, ThermalBadgeLevel.fromTelemetryName("fair"))
        assertEquals(ThermalBadgeLevel.WARM, ThermalBadgeLevel.fromTelemetryName("serious"))
        assertEquals(ThermalBadgeLevel.HOT, ThermalBadgeLevel.fromTelemetryName("critical"))
    }

    @Test
    fun `an unrecognised word reads as cool rather than vanishing`() {
        assertEquals(ThermalBadgeLevel.COOL, ThermalBadgeLevel.fromTelemetryName("unknown"))
        assertEquals(ThermalBadgeLevel.COOL, ThermalBadgeLevel.fromTelemetryName(""))
    }

    @Test
    fun `Android's seven thermal statuses collapse to the four the pill shows`() {
        // NONE and LIGHT are cool, MODERATE is fair, SEVERE and CRITICAL are warm, EMERGENCY and
        // SHUTDOWN are hot. Going through the telemetry name keeps that collapse in one place.
        assertEquals(ThermalBadgeLevel.COOL, ThermalBadgeLevel.fromThermalStatus(0))
        assertEquals(ThermalBadgeLevel.COOL, ThermalBadgeLevel.fromThermalStatus(1))
        assertEquals(ThermalBadgeLevel.FAIR, ThermalBadgeLevel.fromThermalStatus(2))
        assertEquals(ThermalBadgeLevel.WARM, ThermalBadgeLevel.fromThermalStatus(3))
        assertEquals(ThermalBadgeLevel.WARM, ThermalBadgeLevel.fromThermalStatus(4))
        assertEquals(ThermalBadgeLevel.HOT, ThermalBadgeLevel.fromThermalStatus(5))
        assertEquals(ThermalBadgeLevel.HOT, ThermalBadgeLevel.fromThermalStatus(6))
    }

    @Test
    fun `labels are the caps the RECORD and STREAM badges use`() {
        assertEquals("COOL", ThermalBadgeLevel.COOL.label)
        assertEquals("HOT", ThermalBadgeLevel.HOT.label)
        // The accessibility value stays lowercase, so a flow asserts on one spelling.
        assertEquals("hot", ThermalBadgeLevel.HOT.rawValue)
    }

    @Test
    fun `only hot shows flames, and only hot travels`() {
        assertTrue(ThermalBadgeLevel.HOT.showsFlames)
        assertFalse(ThermalBadgeLevel.WARM.showsFlames)
        assertEquals(ThermalBadgeLevel.Shimmer.UP, ThermalBadgeLevel.HOT.shimmer)
        for (level in listOf(ThermalBadgeLevel.COOL, ThermalBadgeLevel.FAIR, ThermalBadgeLevel.WARM)) {
            assertEquals(ThermalBadgeLevel.Shimmer.PULSE, level.shimmer)
        }
    }

    @Test
    fun `the cycle shortens as the phone heats up`() {
        // The motion is the signal: a hotter phone should look more urgent from across a field.
        val cycles = ThermalBadgeLevel.entries.map { it.cycleSeconds }
        assertEquals(listOf(3.0, 3.0, 2.0, 1.0), cycles)
    }

    @Test
    fun `each level has its own hue`() {
        assertEquals(4, ThermalBadgeLevel.entries.map { it.hue }.toSet().size)
        // Cool is blue and hot is red, which is the only part of the palette anyone has to guess.
        assertTrue(ThermalBadgeLevel.COOL.hue.blue > ThermalBadgeLevel.COOL.hue.red)
        assertTrue(ThermalBadgeLevel.HOT.hue.red > ThermalBadgeLevel.HOT.hue.blue)
    }
}
