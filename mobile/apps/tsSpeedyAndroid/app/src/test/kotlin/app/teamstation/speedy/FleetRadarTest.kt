package app.teamstation.speedy

import android.Manifest
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.radar.FleetRadar
import app.teamstation.streamcore.radar.RadarConnection
import app.teamstation.streamcore.radar.RadarFleet
import app.teamstation.streamcore.radar.RadarPhase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FleetRadarTest {
    private val radios = mutableListOf<FakeRadarRadio>()
    private val store = MemoryFleetStore()
    private var bluetooth = true
    private var location = true
    private var permissions = true
    private val scope = CoroutineScope(Dispatchers.Unconfined)

    @After
    fun stop() = scope.cancel()

    private fun radar() = FleetRadar(
        RadarFleet(
            store = store,
            newRadio = { FakeRadarRadio().also { radios += it } },
            bluetoothOn = { bluetooth },
            locationOn = { location },
            permissionsGranted = { permissions },
            log = {},
            later = { _, _ -> },
            limit = 1
        ),
        scope
    )

    @Test
    fun `start turns the fleet on once, with nothing paired`() {
        store.enabled = false
        val radar = radar()
        var changes = 0
        radar.onChange = { changes++ }
        radar.start()
        radar.start()
        assertTrue(radar.fleet.enabled.value)
        assertTrue(store.enabled)
        assertEquals("No radar paired", radar.status.text)
        assertFalse(radar.status.isPaired)
        assertTrue(changes > 0)
    }

    @Test
    fun `refresh does nothing before start`() {
        val radar = radar()
        radar.refresh()
        assertTrue(radios.isEmpty())
    }

    @Test
    fun `pairing lists radars in range and a second pairing replaces the first`() {
        val radar = radar()
        radar.start()
        radar.startPairing()
        assertTrue(radar.status.pairing)
        val scanner = radios.single()
        scanner.onName?.invoke("ADFA0000001")
        scanner.onName?.invoke("Headphones")
        assertEquals(listOf("ADFA0000001"), radar.status.nearby)
        radar.pair("ADFA0000001")
        radar.stopPairing()
        assertFalse(radar.status.pairing)
        assertEquals("ADFA0000001", radar.status.serial)
        assertEquals(RadarStatus.Link.SEARCHING, radar.status.link)
        radar.pair("ADFA0000002")
        assertEquals(listOf("ADFA0000002"), store.serials)
        radar.unpair()
        assertNull(radar.status.serial)
        assertTrue(store.serials.isEmpty())
    }

    @Test
    fun `readings reach the model`() {
        val radar = radar()
        val heard = mutableListOf<String>()
        radar.onSpeeds = { pitch, exit -> heard += "$pitch/$exit" }
        radar.start()
        radar.pair("ADFA0000001")
        val link = radios.last()
        link.radioListener?.onNotification(radarSpeedPacket(-2_503))
        link.radioListener?.onNotification(radarSpeedPacket(-2_503, 2_325))
        link.radioListener?.onNotification(byteArrayOf(85))
        assertEquals(listOf("56/0", "56/52"), heard)
        assertEquals(85, radar.status.batteryPercent)
    }

    @Test
    fun `what blocks the radar shows`() {
        bluetooth = false
        val off = radar()
        off.start()
        assertEquals("Bluetooth off", off.status.text)
        bluetooth = true
        permissions = false
        off.refresh()
        assertEquals("Allow Bluetooth", off.status.text)
        permissions = true
        location = false
        off.refresh()
        assertEquals("Turn on Location", off.status.text)
    }

    @Test
    fun `every connection and phase maps`() {
        assertEquals(RadarStatus.Link.OFF, FleetRadar.link(RadarConnection.off))
        assertEquals(RadarStatus.Link.SEARCHING, FleetRadar.link(RadarConnection.scanning))
        assertEquals(RadarStatus.Link.CONNECTING, FleetRadar.link(RadarConnection.connecting))
        assertEquals(RadarStatus.Link.CONNECTED, FleetRadar.link(RadarConnection.connected))
        assertEquals(RadarStatus.Link.BLUETOOTH_OFF, FleetRadar.link(RadarConnection.bluetoothOff))
        assertEquals(RadarStatus.Blocker.BLUETOOTH_OFF, FleetRadar.blocker(RadarPhase.bluetoothOff))
        assertEquals(RadarStatus.Blocker.LOCATION_OFF, FleetRadar.blocker(RadarPhase.locationOff))
        assertEquals(RadarStatus.Blocker.PERMISSION, FleetRadar.blocker(RadarPhase.permission))
        assertNull(FleetRadar.blocker(RadarPhase.connected))
    }

    @Test
    fun `the permissions asked for include coarse location`() {
        assertEquals(
            setOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ),
            FleetRadar.permissions(34).toSet()
        )
    }
}
