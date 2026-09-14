package co.gamestation.cameraman.core

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * The Android counterpart of the iOS build's Keychain store.
 *
 * Two of the Keychain's three properties come free here and the third does not, which is worth
 * saying plainly rather than leaving to be discovered on a field:
 *
 * - *Device-only.* `android:allowBackup="false"` in the manifest keeps the identity off Auto Backup
 *   and out of a device-to-device transfer, which is the point of
 *   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: cloning a phone must not make two cameras
 *   claim to be the same one.
 * - *Readable after first unlock.* App storage is credential-encrypted, so the server comes back
 *   after an unattended reboot as soon as the phone is unlocked once — the same window iOS gives.
 * - *Survives uninstall.* It does not. Android clears app storage and every Keystore entry an app
 *   owns on uninstall, and there is no sanctioned store that outlives it. A reinstalled Cameraman
 *   is a new camera to GS Director and has to be re-bound to its tile. Nothing here can fix that;
 *   pretending otherwise would move the surprise to match day.
 *
 * `EncryptedSharedPreferences` would add a Keystore-wrapped layer on top and change none of the
 * above — file-based encryption already covers data at rest — so it is not used.
 */
class PreferencesIdentityStore(
    context: Context,
    fileName: String = "co.gamestation.cameraman.identity"
) : IdentityStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(fileName, Context.MODE_PRIVATE)

    override fun string(key: String): String? = preferences.getString(key, null)

    override fun setString(value: String, key: String) {
        // Committed rather than applied: the identity is written once on first launch, and a
        // process killed before an async flush would come back as a different camera. A commit that
        // fails is logged rather than retried here, because the UUID is derived from [installSeed]:
        // the next launch mints the same one and saves it then.
        if (!preferences.edit().putString(key, value).commit()) {
            Log.e(tag, "could not save $key; the next launch derives the same UUID and saves it again")
        }
    }

    companion object {
        private const val tag = "CameramanIdentity"

        /**
         * Fixed for the life of this install and different on every other one: the app-scoped
         * `ANDROID_ID` (one per signing key, user and handset) and the moment this package was
         * first installed, which an update keeps and a reinstall replaces. Null when either cannot
         * be read, and the provider then draws at random.
         */
        @SuppressLint("HardwareIds") // App-scoped since Android 8, and hashed before it is sent.
        fun installSeed(context: Context): String? {
            val androidID = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
                ?.takeIf { it.isNotBlank() }
                ?: return null
            val installedAt = runCatching {
                context.packageManager
                    .getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(0))
                    .firstInstallTime
            }.getOrNull() ?: return null
            return "${context.packageName}:$androidID:$installedAt"
        }
    }
}
