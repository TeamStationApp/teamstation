package co.gamestation.cameraman.radar

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.content.Context
import android.os.Handler
import android.os.HandlerThread

/**
 * Binds [AndroidRadarRadio] to the platform scanner and GATT client.
 * Scan permission is `BLUETOOTH_SCAN` without `neverForLocation`.
 */
@SuppressLint("MissingPermission")
internal fun systemRadarRadio(context: Context): RadarRadio {
    val manager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    val adapter = manager?.adapter
    val appContext = context.applicationContext
    val devices = HashMap<String, BluetoothDevice>()
    var listener: RadarRadioListener? = null
    var gatt: BluetoothGatt? = null
    var callback: ScanCallback? = null
    val thread = HandlerThread("CameramanRadar")
    val handler: Handler by lazy {
        thread.start()
        Handler(thread.looper)
    }

    fun deliver(name: String?, onName: (String) -> Unit) {
        if (name != null && TAG_NAME.containsMatchIn(name)) onName(name)
    }

    return AndroidRadarRadio(
        startScanFn = { onName ->
            val scanner = adapter?.bluetoothLeScanner ?: return@AndroidRadarRadio
            val next = object : ScanCallback() {
                override fun onScanResult(callbackType: Int, result: ScanResult) {
                    val name = result.device.name ?: result.scanRecord?.deviceName
                    if (name != null) devices[name] = result.device
                    deliver(name, onName)
                }
            }
            callback = next
            scanner.startScan(next)
        },
        stopScanFn = {
            val scanner = adapter?.bluetoothLeScanner
            val current = callback
            if (scanner != null && current != null) scanner.stopScan(current)
            callback = null
        },
        connectFn = { name ->
            val device = devices[name] ?: return@AndroidRadarRadio
            Thread {
                gatt = device.connectGatt(appContext, false, object : BluetoothGattCallback() {
                    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                        if (newState == BluetoothProfile.STATE_CONNECTED) {
                            g.discoverServices()
                        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                            listener?.onDisconnected()
                        }
                    }

                    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                        if (status != BluetoothGatt.GATT_SUCCESS) {
                            listener?.onDisconnected()
                            return
                        }
                        for (service in g.services) {
                            for (characteristic in service.characteristics) {
                                val uuid = characteristic.uuid.toString()
                                if (!RadarProtocol.shouldSubscribe(uuid)) continue
                                if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0) {
                                    enableNotify(g, characteristic)
                                }
                            }
                        }
                        listener?.onConnected()
                    }

                    override fun onCharacteristicChanged(
                        g: BluetoothGatt,
                        characteristic: BluetoothGattCharacteristic,
                        value: ByteArray
                    ) {
                        listener?.onNotification(value)
                    }
                }, BluetoothDevice.TRANSPORT_LE, BluetoothDevice.PHY_LE_1M_MASK, handler)
            }.start()
        },
        disconnectFn = {
            gatt?.close()
            gatt = null
        },
        subscribeFn = { uuid ->
            val current = gatt ?: return@AndroidRadarRadio
            for (service in current.services.orEmpty()) {
                val characteristic = service.getCharacteristic(java.util.UUID.fromString(uuid)) ?: continue
                enableNotify(current, characteristic)
            }
        },
        writeFn = { bytes ->
            val current = gatt ?: return@AndroidRadarRadio 0
            val characteristic = current.services.orEmpty().asSequence()
                .mapNotNull { it.getCharacteristic(java.util.UUID.fromString(COMMAND_WRITE_UUID)) }
                .firstOrNull() ?: return@AndroidRadarRadio 0
            writeStatus(current.writeCharacteristic(
                characteristic,
                bytes,
                BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
            ))
        },
        listenerFn = { listener = it }
    )
}

private val CCCD: java.util.UUID =
    java.util.UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

@SuppressLint("MissingPermission")
private fun enableNotify(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
    gatt.setCharacteristicNotification(characteristic, true)
    val descriptor = characteristic.getDescriptor(CCCD) ?: return
    val value = if (
        characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0 &&
        characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY == 0
    ) {
        BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    } else {
        BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    }
    gatt.writeDescriptor(descriptor, value)
}

/** GATT success is 0 to [Handshake]. Status 201 is the busy retry. Anything else drops the link. */
internal fun writeStatus(code: Int): Int = when (code) {
    BluetoothStatusCodes.SUCCESS -> 0
    BluetoothStatusCodes.ERROR_GATT_WRITE_REQUEST_BUSY -> 201
    else -> code
}
