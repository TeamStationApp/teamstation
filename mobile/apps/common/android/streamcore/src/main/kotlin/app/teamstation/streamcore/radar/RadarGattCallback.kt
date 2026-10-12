package app.teamstation.streamcore.radar

import android.annotation.SuppressLint
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothProfile

/**
 * The GATT client's callback: discovers the radar's services, subscribes to the ones
 * [RadarProtocol] reads, and hands every notification to whichever listener is current.
 */
@SuppressLint("MissingPermission")
internal fun radarGattCallback(listener: () -> RadarRadioListener?): BluetoothGattCallback =
    object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                g.discoverServices()
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                listener()?.onDisconnected()
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            if (status != BluetoothGatt.GATT_SUCCESS) {
                listener()?.onDisconnected()
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
            listener()?.onConnected()
        }

        /** Android 13 on: the value arrives as an argument. */
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            listener()?.onNotification(value)
        }

        /**
         * Android 11 and 12: the value rides on the characteristic. From 13 the platform calls the
         * overload above instead, and since that one does not call through, never this.
         */
        @Deprecated("Replaced by the overload that carries the value, from API 33")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            listener()?.onNotification(characteristic.value ?: return)
        }
    }
