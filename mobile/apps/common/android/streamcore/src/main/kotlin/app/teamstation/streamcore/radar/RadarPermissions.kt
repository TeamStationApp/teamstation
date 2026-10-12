package app.teamstation.streamcore.radar

import android.Manifest
import android.annotation.SuppressLint
import android.os.Build

/**
 * The runtime permissions scanning for and connecting to a radar needs on this release.
 *
 * Android 12 split Bluetooth into its own runtime grants, `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`;
 * on Android 11 Bluetooth is an install-time grant and only location is asked for. Location stays
 * on both, because the scan is not declared `neverForLocation`.
 */
object RadarPermissions {
    // The two Bluetooth names are API 31 constants, returned only from 31 on.
    @SuppressLint("InlinedApi")
    fun required(sdkInt: Int = Build.VERSION.SDK_INT): List<String> =
        if (sdkInt >= Build.VERSION_CODES.S) {
            listOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        } else {
            listOf(Manifest.permission.ACCESS_FINE_LOCATION)
        }
}
