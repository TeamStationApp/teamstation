package app.teamstation.streamcore.radar

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanResult
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID

/**
 * The I4 cases on Android: a fleet of [systemRadarRadio]s over Robolectric's Bluetooth. Every
 * radio registers its own scan callback, so an advertisement reaches each link and the fleet's
 * picker the way the platform delivers it, and a connect opens a real shadow GATT client.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RadarFleetTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val adapter: BluetoothAdapter =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private val pending = ArrayDeque<() -> Unit>()
    private val radios = mutableListOf<RadarRadio>()
    private var bluetooth = true
    private var location = true
    private var permissions = true

    @Before
    fun bluetoothOn() {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
    }

    @Test
    fun `two radars pair and one unpairs`() {
        val store = MemoryFleetStore()
        val fleet = fleet(store)
        fleet.start()
        assertTrue(fleet.pair("ADFA0000001"))
        assertTrue(fleet.pair("ADFA0000002"))
        assertFalse("the same radar twice", fleet.pair("adfa0000001"))
        assertFalse(fleet.pair("Headphones"))
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), fleet.serials)
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), store.serials)
        assertEquals(
            listOf(RadarConnection.scanning, RadarConnection.scanning),
            fleet.devices.value.map { it.connection }
        )
        assertEquals(2, scanCallbacks())

        val first = connect(fleet, "ADFA0000001", "02:00:00:00:00:01")
        fleet.unpair("ADFA0000001")
        assertEquals(listOf("ADFA0000002"), fleet.devices.value.map { it.serial })
        assertEquals(listOf("ADFA0000002"), store.serials)
        assertTrue(shadowOf(first).isClosed)
        assertEquals(1, scanCallbacks())
        fleet.unpair("ADFA0000009")
        assertEquals(listOf("ADFA0000002"), fleet.serials)
    }

    @Test
    fun `each radar has its own connection and battery`() {
        val fleet = fleet(MemoryFleetStore())
        fleet.start()
        fleet.pair("ADFA0000001")
        fleet.pair("ADFA0000002")

        // The advertisement reaches both links; only the one paired to it connects.
        val radar = advertise("ADFA0000001", "02:00:00:00:00:01")
        assertEquals(
            listOf(RadarConnection.connecting, RadarConnection.scanning),
            fleet.devices.value.map { it.connection }
        )
        val gatt = bringUp(radar)
        assertEquals(RadarConnection.connected, fleet.devices.value[0].connection)
        notify(gatt, byteArrayOf(85))
        assertEquals(
            listOf(
                RadarDeviceState("ADFA0000001", RadarConnection.connected, batteryPercent = 85),
                RadarDeviceState("ADFA0000002", RadarConnection.scanning)
            ),
            fleet.devices.value
        )

        // A drop waits out the backoff, then looks for the serial again.
        shadowOf(gatt).gattCallback.onConnectionStateChange(gatt, 0, BluetoothProfile.STATE_DISCONNECTED)
        assertEquals(RadarConnection.connecting, fleet.devices.value[0].connection)
        while (pending.isNotEmpty()) pending.removeFirst().invoke()
        assertEquals(RadarConnection.scanning, fleet.devices.value[0].connection)
        assertEquals(85, fleet.devices.value[0].batteryPercent)

        // Bluetooth, location and the permission each make the radio unavailable.
        bluetooth = false
        fleet.refresh()
        assertEquals(
            listOf(RadarConnection.bluetoothOff, RadarConnection.bluetoothOff),
            fleet.devices.value.map { it.connection }
        )
        bluetooth = true
        permissions = false
        fleet.refresh()
        assertEquals(RadarConnection.bluetoothOff, fleet.devices.value[1].connection)
        assertEquals(RadarPhase.permission, fleet.cameramanState.value.phase)
    }

    @Test
    fun `a reading updates only its own radar`() {
        val fleet = fleet(MemoryFleetStore())
        val heard = mutableListOf<String>()
        fleet.onSpeeds = { serial, pitch, exit -> heard += "$serial $pitch/$exit" }
        fleet.start()
        fleet.pair("ADFA0000001")
        fleet.pair("ADFA0000002")
        val one = connect(fleet, "ADFA0000001", "02:00:00:00:00:01")
        val two = connect(fleet, "ADFA0000002", "02:00:00:00:00:02")

        val before = System.currentTimeMillis()
        notify(one, speedPacket(signedCms = -3_219))
        val first = fleet.devices.value[0]
        assertEquals(72, first.pitchMph)
        assertNull(first.exitMph)
        assertTrue(first.readingAt!! >= before)
        assertNull(fleet.devices.value[1].pitchMph)
        assertNull(fleet.devices.value[1].readingAt)

        notify(two, speedPacket(signedCms = 3_934))
        assertEquals(88, fleet.devices.value[1].exitMph)
        assertNull(fleet.devices.value[0].exitMph)
        assertEquals(listOf("ADFA0000001 72/0", "ADFA0000002 0/88"), heard)
    }

    @Test
    fun `scan lists only radars that are not paired`() {
        val fleet = fleet(MemoryFleetStore())
        fleet.start()
        fleet.pair("ADFA0000001")
        fleet.scan()
        assertTrue(fleet.scanning.value)
        assertEquals(2, scanCallbacks())
        advertise("ADFA0000002", "02:00:00:00:00:02")
        advertise("ADFA0000002", "02:00:00:00:00:02")
        advertise("Headphones", "02:00:00:00:00:05")
        advertise("ADFA0000003", "02:00:00:00:00:03")
        assertEquals(listOf("ADFA0000002", "ADFA0000003"), fleet.nearby.value)
        advertise("ADFA0000001", "02:00:00:00:00:01")
        assertEquals(listOf("ADFA0000002", "ADFA0000003"), fleet.nearby.value)
        assertEquals(listOf("ADFA0000002", "ADFA0000003"), fleet.cameramanState.value.pickerNames)

        // Pairing one takes it off the list; the scan keeps going until stopped.
        fleet.pair("ADFA0000002")
        assertEquals(listOf("ADFA0000003"), fleet.nearby.value)
        fleet.stopScan()
        assertFalse(fleet.scanning.value)
        assertTrue(fleet.nearby.value.isEmpty())
        fleet.stopScan()
        assertFalse(fleet.cameramanState.value.pickerOpen)
    }

    @Test
    fun `disabling stops every session and the scan`() {
        val store = MemoryFleetStore()
        val fleet = fleet(store)
        fleet.start()
        fleet.pair("ADFA0000001")
        fleet.pair("ADFA0000002")
        val gatt = connect(fleet, "ADFA0000001", "02:00:00:00:00:01")
        fleet.scan()
        assertEquals(2, scanCallbacks())

        fleet.setEnabled(false)
        assertEquals(
            listOf(RadarConnection.off, RadarConnection.off),
            fleet.devices.value.map { it.connection }
        )
        assertTrue(shadowOf(gatt).isClosed)
        assertEquals(0, scanCallbacks())
        assertFalse(store.enabled)
        assertFalse(fleet.enabled.value)
        assertTrue("the picker stays open, quiet", fleet.cameramanState.value.pickerOpen)

        fleet.setEnabled(true)
        assertEquals(
            listOf(RadarConnection.scanning, RadarConnection.scanning),
            fleet.devices.value.map { it.connection }
        )
        assertEquals(3, scanCallbacks())
    }

    @Test
    fun `pairings persist across a restart`() {
        val store = PreferencesRadarFleetStore(context, "test.fleet", "serials", "enabled", enabledByDefault = true)
        val fleet = fleet(store)
        fleet.start()
        fleet.pair("ADFA0000001")
        fleet.pair("ADFA0000002")

        val again = fleet(PreferencesRadarFleetStore(context, "test.fleet", "serials", "enabled", enabledByDefault = true))
        again.start()
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), again.serials)
        assertEquals(
            listOf(RadarConnection.scanning, RadarConnection.scanning),
            again.devices.value.map { it.connection }
        )
    }

    @Test
    fun `a full fleet drops its oldest pairing`() {
        val store = MemoryFleetStore(listOf("ADFA0000001", "ADFA0000002", "ADFA0000003"))
        val fleet = fleet(store, limit = 2)
        fleet.start()
        assertEquals(listOf("ADFA0000001", "ADFA0000002"), fleet.serials)
        fleet.pair("ADFA0000004")
        assertEquals(listOf("ADFA0000002", "ADFA0000004"), fleet.serials)
        assertEquals(listOf("ADFA0000002", "ADFA0000004"), store.serials)
        assertEquals(1, fleet(MemoryFleetStore(), limit = 0).limit)
    }

    @Test
    fun `with a limit of one Cameraman's keys are read and written as before`() {
        val preferences = context.getSharedPreferences(PreferencesRadarFleetStore.CAMERAMAN_FILE, 0)
        preferences.edit().putString("serial", "ADFA0000001").putBoolean("enabled", false).commit()
        val fleet = fleet(PreferencesRadarFleetStore.cameraman(context), limit = 1)
        fleet.start()
        assertEquals(listOf("ADFA0000001"), fleet.serials)
        assertFalse(fleet.enabled.value)
        assertEquals("Off", fleet.cameramanState.value.statusText)

        fleet.setEnabled(true)
        assertTrue(preferences.getBoolean("enabled", false))
        fleet.pair("ADFA0000002")
        assertEquals(listOf("ADFA0000002"), fleet.serials)
        assertEquals("ADFA0000002", preferences.getString("serial", null))
        fleet.unpair("ADFA0000002")
        assertFalse(preferences.contains("serial"))
    }

    @Test
    fun `Cameraman's state is the one link's, or what the switch and Bluetooth say without one`() {
        val fleet = fleet(MemoryFleetStore(enabled = false), limit = 1)
        fleet.start()
        assertEquals(RadarUiState(enabled = false, statusText = "Off"), fleet.cameramanState.value)
        fleet.scan()
        assertTrue(fleet.cameramanState.value.pickerOpen)
        assertEquals("a picker while off does not scan", 0, scanCallbacks())
        fleet.setEnabled(true)
        assertEquals(1, scanCallbacks())
        assertEquals(RadarUiState(pickerOpen = true), fleet.cameramanState.value)
        bluetooth = false
        fleet.refresh()
        assertEquals(RadarPhase.bluetoothOff, fleet.cameramanState.value.phase)
        assertEquals(0, scanCallbacks())
        bluetooth = true
        location = false
        fleet.refresh()
        assertEquals(RadarPhase.locationOff, fleet.cameramanState.value.phase)
        location = true
        permissions = false
        fleet.refresh()
        assertEquals(RadarPhase.permission, fleet.cameramanState.value.phase)
        permissions = true
        fleet.stopScan()

        fleet.pair("ADFA0000001")
        assertEquals("ADFA0000001", fleet.cameramanState.value.serial)
        assertEquals(RadarPhase.connecting, fleet.cameramanState.value.phase)
        fleet.setStep(2)
        assertEquals(2, fleet.cameramanState.value.connectingStep)
        val gatt = connect(fleet, "ADFA0000001", "02:00:00:00:00:01")
        notify(gatt, byteArrayOf(19))
        notify(gatt, speedPacket(signedCms = -1_878))
        assertEquals("⚡19% 42/–", fleet.cameramanState.value.readoutText)
    }

    @Test
    fun `uiTest commands show, feed and unpair the one radar`() {
        val heard = mutableListOf<String>()
        val fleet = fleet(MemoryFleetStore(), limit = 1)
        fleet.onSpeeds = { serial, pitch, exit -> heard += "$serial $pitch/$exit" }
        fleet.start()

        // With nothing shown or paired, a feed still reaches the scoreboard.
        fleet.feed(RadarCommand.Feed(50, 0, 1_000_000))
        fleet.feed(RadarCommand.Feed(0, 0, 1_000_000))
        assertEquals(listOf(" 50/0"), heard)

        fleet.show(RadarCommand.Show("ADFA0000001", RadarPhase.connected, 0))
        assertEquals(0, scanCallbacks())
        assertTrue(fleet.devices.value.isEmpty())
        assertTrue(fleet.serials.isEmpty())
        fleet.feed(RadarCommand.Feed(50, 60, 1_000_000))
        assertEquals("50/60", fleet.cameramanState.value.speedsText)
        assertTrue(fleet.cameramanState.value.linkSuppressed)
        assertEquals(listOf(" 50/0", "ADFA0000001 50/60"), heard)

        // A shown radar is paired for real when chosen.
        assertTrue(fleet.pair("ADFA0000001"))
        assertFalse(fleet.cameramanState.value.linkSuppressed)
        fleet.show(RadarCommand.Show("ADFA0000002", RadarPhase.idle, 0))
        assertEquals("ADFA0000002", fleet.cameramanState.value.serial)
        assertEquals(RadarConnection.off, fleet.devices.value[0].connection)

        fleet.unpairAll()
        assertNull(fleet.cameramanState.value.serial)
        assertTrue(fleet.serials.isEmpty())
        fleet.show(RadarCommand.Show("ADFA0000003", RadarPhase.connected, 0))
        fleet.unpairAll()
        assertNull(fleet.cameramanState.value.serial)
    }

    @Test
    fun `a released radio stops its scan, closes its client and drops its listener`() {
        val radio = systemRadarRadio(context)
        radio.startScan { }
        val radar = advertise("ADFA0000001", "02:00:00:00:00:01")
        radio.connect("ADFA0000001")
        val gatt = awaitGatt(radar)
        radio.release()
        assertEquals(0, scanCallbacks())
        assertTrue(shadowOf(gatt).isClosed)
        assertEquals(0, radio.write(byteArrayOf(1)))
    }

    private fun fleet(store: RadarFleetStore, limit: Int = Int.MAX_VALUE) = RadarFleet(
        store = store,
        newRadio = { systemRadarRadio(context).also { radios += it } },
        bluetoothOn = { bluetooth },
        locationOn = { location },
        permissionsGranted = { permissions },
        log = {},
        later = { _, block -> pending.add(block) },
        limit = limit
    )

    private fun scanCallbacks(): Int = shadowOf(adapter.bluetoothLeScanner).scanCallbacks.size

    /** A TAG One in range: every registered scan callback hears it. */
    private fun advertise(name: String, address: String): BluetoothDevice {
        val device = adapter.getRemoteDevice(address)
        shadowOf(device).setName(name)
        for (callback in shadowOf(adapter.bluetoothLeScanner).scanCallbacks.toList()) {
            @Suppress("DEPRECATION")
            callback.onScanResult(0, ScanResult(device, null, -50, 0L))
        }
        return device
    }

    /** The radar's services appear and the link comes up. */
    private fun bringUp(device: BluetoothDevice): BluetoothGatt {
        val gatt = awaitGatt(device)
        val service = BluetoothGattService(
            UUID.fromString("6e40ff01-b5a3-f393-e0a9-5461674f6e65"),
            BluetoothGattService.SERVICE_TYPE_PRIMARY
        )
        service.addCharacteristic(
            BluetoothGattCharacteristic(
                UUID.fromString(COMMAND_WRITE_UUID),
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                0
            )
        )
        val speed = BluetoothGattCharacteristic(
            UUID.fromString(SPEED_NOTIFY_UUID),
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0
        )
        speed.addDescriptor(BluetoothGattDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"), 0))
        service.addCharacteristic(speed)
        shadowOf(gatt).addDiscoverableService(service)
        gatt.discoverServices()
        return gatt
    }

    private fun connect(fleet: RadarFleet, serial: String, address: String): BluetoothGatt {
        val gatt = bringUp(advertise(serial, address))
        assertEquals(
            RadarConnection.connected,
            fleet.devices.value.first { it.serial == serial }.connection
        )
        return gatt
    }

    private fun notify(gatt: BluetoothGatt, value: ByteArray) {
        val characteristic = gatt.services.first().getCharacteristic(UUID.fromString(SPEED_NOTIFY_UUID))
        shadowOf(gatt).gattCallback.onCharacteristicChanged(gatt, characteristic, value)
    }

    /** `connect` opens the client on its own thread, so the test waits for it to appear. */
    private fun awaitGatt(device: BluetoothDevice): BluetoothGatt {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            shadowOf(device).bluetoothGatts.lastOrNull()?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("no GATT client was opened")
    }

    /** A speed packet the way the TAG One sends it; a negative primary speed is a pitch. */
    private fun speedPacket(signedCms: Int, extraCms: Int = 0): ByteArray {
        val body = byteArrayOf(
            0x13, 0, 0, 0, 0, 0, 0,
            (signedCms shr 8).toByte(), signedCms.toByte(),
            (extraCms shr 8).toByte(), extraCms.toByte(),
            0
        )
        return byteArrayOf(0x80.toByte(), body.size.toByte()) + body
    }

    private class MemoryFleetStore(
        var serials: List<String> = emptyList(),
        var enabled: Boolean = true
    ) : RadarFleetStore {
        override fun readSerials(): List<String> = serials
        override fun writeSerials(serials: List<String>) {
            this.serials = serials
        }
        override fun readEnabled(): Boolean = enabled
        override fun writeEnabled(enabled: Boolean) {
            this.enabled = enabled
        }
    }
}
