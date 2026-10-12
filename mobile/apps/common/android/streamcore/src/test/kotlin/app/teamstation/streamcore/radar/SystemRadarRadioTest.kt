package app.teamstation.streamcore.radar

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowBluetoothGatt
import java.util.UUID

/**
 * The platform GATT calls behind [systemRadarRadio], at Android 11, the library's floor, and at
 * Android 14, past the API 33 change that moved the written value into the call.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemRadarRadioTest {
    private val events = mutableListOf<String>()
    private val listener = object : RadarRadioListener {
        override fun onConnected() {
            events += "connected"
        }

        override fun onDisconnected() {
            events += "disconnected"
        }

        override fun onNotification(value: ByteArray) {
            events += "notify " + value.joinToString(",")
        }
    }
    private val callback = radarGattCallback { listener }

    private fun gatt(gattCallback: BluetoothGattCallback = callback): BluetoothGatt {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val device = manager.adapter.getRemoteDevice("02:00:00:00:00:01")
        return ShadowBluetoothGatt.newInstance(device).also { shadowOf(it).setGattCallback(gattCallback) }
    }

    private fun characteristic(uuid: String, properties: Int, service: Boolean = true): BluetoothGattCharacteristic {
        val characteristic = BluetoothGattCharacteristic(UUID.fromString(uuid), properties, 0)
        characteristic.addDescriptor(BluetoothGattDescriptor(UUID.fromString(CCCD_UUID), 0))
        if (service) {
            BluetoothGattService(UUID.fromString(SERVICE_UUID), BluetoothGattService.SERVICE_TYPE_PRIMARY)
                .addCharacteristic(characteristic)
        }
        return characteristic
    }

    private fun commandCharacteristic(service: Boolean = true) =
        characteristic(COMMAND_WRITE_UUID, BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE, service)

    @Test
    @Config(sdk = [34])
    fun `from Android 13 a command is written through the call that takes the bytes`() {
        val gatt = gatt()
        val command = commandCharacteristic()

        assertEquals(0, writeCommand(gatt, command, byteArrayOf(1, 2, 3)))
        assertArrayEquals(byteArrayOf(1, 2, 3), shadowOf(gatt).latestWrittenBytes)
    }

    @Test
    @Config(sdk = [34])
    fun `from Android 13 a refused write keeps the platform's status`() {
        // No service: the platform refuses the write with GATT failure 257, which drops the link.
        assertEquals(257, writeCommand(gatt(), commandCharacteristic(service = false), byteArrayOf(1)))
    }

    @Test
    @Config(sdk = [30])
    fun `on Android 11 a command rides on the characteristic without a response`() {
        val gatt = gatt()
        val command = commandCharacteristic()

        assertEquals(0, writeCommand(gatt, command, byteArrayOf(4, 5)))
        assertArrayEquals(byteArrayOf(4, 5), shadowOf(gatt).latestWrittenBytes)
        assertEquals(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE, command.writeType)
    }

    @Test
    @Config(sdk = [30])
    fun `on Android 11 a refused write is read as busy and retried`() {
        assertEquals(201, writeCommand(gatt(), commandCharacteristic(service = false), byteArrayOf(1)))
    }

    @Test
    @Config(sdk = [34])
    fun `from Android 13 notifications are enabled through the call that takes the value`() {
        val gatt = gatt()
        enableNotify(gatt, characteristic(SPEED_NOTIFY_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY))

        assertArrayEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, shadowOf(gatt).latestWrittenBytes)
    }

    @Test
    @Config(sdk = [30])
    fun `on Android 11 the enable value rides on the descriptor`() {
        val gatt = gatt()
        val indicating = characteristic(BATTERY_LEVEL_UUID, BluetoothGattCharacteristic.PROPERTY_INDICATE)
        enableNotify(gatt, indicating)

        assertArrayEquals(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE, shadowOf(gatt).latestWrittenBytes)
        @Suppress("DEPRECATION")
        assertArrayEquals(
            BluetoothGattDescriptor.ENABLE_INDICATION_VALUE,
            indicating.getDescriptor(UUID.fromString(CCCD_UUID)).value
        )
    }

    @Test
    @Config(sdk = [30])
    fun `a connection discovers services, subscribes to the radar's and reports connected`() {
        val gatt = gatt()
        val speed = characteristic(SPEED_NOTIFY_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY, service = false)
        val other = characteristic(
            "00000000-0000-1000-8000-00805f9b34fb",
            BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            service = false
        )
        val service = BluetoothGattService(UUID.fromString(SERVICE_UUID), BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(speed)
        service.addCharacteristic(other)
        shadowOf(gatt).addDiscoverableService(service)

        callback.onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)

        assertEquals(listOf("connected"), events)
        assertArrayEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, shadowOf(gatt).latestWrittenBytes)
        @Suppress("DEPRECATION")
        assertEquals(null, other.getDescriptor(UUID.fromString(CCCD_UUID)).value)
    }

    @Test
    @Config(sdk = [34])
    fun `a dropped connection or a failed discovery reports disconnected`() {
        val gatt = gatt()
        callback.onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED)
        callback.onServicesDiscovered(gatt, BluetoothGatt.GATT_FAILURE)
        callback.onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTING)

        assertEquals(listOf("disconnected", "disconnected"), events)
    }

    @Test
    @Config(sdk = [34])
    fun `from Android 13 a notification's value arrives as an argument`() {
        val speed = characteristic(SPEED_NOTIFY_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY)
        callback.onCharacteristicChanged(gatt(), speed, byteArrayOf(7, 8))

        assertEquals(listOf("notify 7,8"), events)
    }

    @Test
    @Config(sdk = [30])
    @Suppress("DEPRECATION")
    fun `on Android 11 a notification's value is read off the characteristic`() {
        val gatt = gatt()
        val speed = characteristic(SPEED_NOTIFY_UUID, BluetoothGattCharacteristic.PROPERTY_NOTIFY)
        callback.onCharacteristicChanged(gatt, speed)
        speed.value = byteArrayOf(9)
        callback.onCharacteristicChanged(gatt, speed)

        assertEquals(listOf("notify 9"), events)
    }

    @Test
    fun `radar permissions are the Bluetooth grants from Android 12 and location alone before`() {
        assertEquals(
            listOf(
                "android.permission.BLUETOOTH_SCAN",
                "android.permission.BLUETOOTH_CONNECT",
                "android.permission.ACCESS_FINE_LOCATION"
            ),
            RadarPermissions.required(31)
        )
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), RadarPermissions.required(30))
    }

    private companion object {
        const val CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"
        const val SERVICE_UUID = "6e40ff01-b5a3-f393-e0a9-5461674f6e65"
    }
}
