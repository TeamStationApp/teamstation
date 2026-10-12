package app.teamstation.streamcore.phonestream

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import app.teamstation.streamcore.core.BatteryStatus
import app.teamstation.streamcore.core.ThermalBadgeLevel

/** The phone's battery and heat, for the overlay's pills. */
interface PhoneDeviceStatusReading {
    /** Null when the system does not know. */
    fun battery(): BatteryStatus?
    fun thermal(): ThermalBadgeLevel
}

/**
 * `ACTION_BATTERY_CHANGED`'s level and plug state, and `PowerManager`'s thermal status collapsed to
 * Cameraman's four levels.
 */
class SystemDeviceStatus(context: Context) : PhoneDeviceStatusReading {
    private val context = context.applicationContext

    override fun battery(): BatteryStatus? {
        // A sticky broadcast: registering with no receiver reads the last one without listening.
        val intent: Intent = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return null
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return BatteryStatus.fromLevelAndScale(
            intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1),
            intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1),
            charging
        )
    }

    override fun thermal(): ThermalBadgeLevel {
        val power = context.getSystemService(PowerManager::class.java) ?: return ThermalBadgeLevel.COOL
        return ThermalBadgeLevel.fromThermalStatus(power.currentThermalStatus)
    }
}
