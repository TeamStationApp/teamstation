package app.teamstation.streamcore.radar

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.UUID

/**
 * [systemRadarRadio] end to end against Robolectric's Bluetooth: a scan finds the radar by name,
 * connect opens a GATT client on it, subscribe and write reach its characteristics, and disconnect
 * closes it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemRadarRadioLinkTest {
    private val context: Context = RuntimeEnvironment.getApplication()
    private val adapter: BluetoothAdapter =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter

    @Test
    fun `scan, connect, subscribe, write and disconnect go through the platform`() {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val radio = systemRadarRadio(context)
        val connected = mutableListOf<String>()
        radio.setListener(object : RadarRadioListener {
            override fun onConnected() {
                connected += "connected"
            }

            override fun onDisconnected() = Unit
            override fun onNotification(value: ByteArray) = Unit
        })

        // Nothing is open yet: a write has nowhere to go and an unknown name connects to nothing.
        assertEquals(0, radio.write(byteArrayOf(1)))
        radio.connect("ADFA0000009")
        radio.subscribe(SPEED_NOTIFY_UUID)

        val names = mutableListOf<String>()
        radio.startScan { names += it }
        val radar = adapter.getRemoteDevice("02:00:00:00:00:01")
        shadowOf(radar).setName("ADFA0000001")
        val other = adapter.getRemoteDevice("02:00:00:00:00:02")
        shadowOf(other).setName("Headphones")
        val scanner = adapter.bluetoothLeScanner
        val callbacks: Set<ScanCallback> = shadowOf(scanner).scanCallbacks
        for (callback in callbacks) {
            @Suppress("DEPRECATION")
            callback.onScanResult(0, ScanResult(radar, null, -50, 0L))
            @Suppress("DEPRECATION")
            callback.onScanResult(0, ScanResult(other, null, -50, 0L))
        }
        assertEquals(listOf("ADFA0000001"), names)
        radio.stopScan()
        assertTrue(shadowOf(scanner).scanCallbacks.isEmpty())

        radio.connect("ADFA0000001")
        val gatt = awaitGatt(radar)
        val command = BluetoothGattCharacteristic(
            UUID.fromString(COMMAND_WRITE_UUID),
            BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            0
        )
        val speed = BluetoothGattCharacteristic(
            UUID.fromString(SPEED_NOTIFY_UUID),
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            0
        )
        speed.addDescriptor(BluetoothGattDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"), 0))
        val service = BluetoothGattService(
            UUID.fromString("6e40ff01-b5a3-f393-e0a9-5461674f6e65"),
            BluetoothGattService.SERVICE_TYPE_PRIMARY
        )
        service.addCharacteristic(command)
        service.addCharacteristic(speed)
        shadowOf(gatt).addDiscoverableService(service)
        gatt.discoverServices()
        assertEquals(listOf("connected"), connected)

        radio.subscribe(SPEED_NOTIFY_UUID)
        assertArrayEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, shadowOf(gatt).latestWrittenBytes)

        assertEquals(0, radio.write(byteArrayOf(5, 6)))
        assertArrayEquals(byteArrayOf(5, 6), shadowOf(gatt).latestWrittenBytes)

        radio.disconnect()
        assertTrue(shadowOf(gatt).isClosed)
        assertEquals(0, radio.write(byteArrayOf(7)))
    }

    @Test
    fun `a write finds no command characteristic on a radar that has none`() {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        val radio = systemRadarRadio(context)
        radio.startScan { }
        val radar = adapter.getRemoteDevice("02:00:00:00:00:03")
        shadowOf(radar).setName("ADFA0000003")
        for (callback in shadowOf(adapter.bluetoothLeScanner).scanCallbacks) {
            @Suppress("DEPRECATION")
            callback.onScanResult(0, ScanResult(radar, null, -50, 0L))
        }
        radio.connect("ADFA0000003")
        awaitGatt(radar).discoverServices()

        assertEquals(0, radio.write(byteArrayOf(1)))
    }

    @Test
    fun `with the adapter off a scan starts nothing`() {
        shadowOf(adapter).setState(BluetoothAdapter.STATE_OFF)
        val radio = systemRadarRadio(context)
        val names = mutableListOf<String>()
        radio.startScan { names += it }
        radio.stopScan()
        assertTrue(names.isEmpty())
    }

    /** `connect` opens the client on its own thread, so the test waits for it to appear. */
    private fun awaitGatt(device: android.bluetooth.BluetoothDevice): BluetoothGatt {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            shadowOf(device).bluetoothGatts.firstOrNull()?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("no GATT client was opened")
    }
}
