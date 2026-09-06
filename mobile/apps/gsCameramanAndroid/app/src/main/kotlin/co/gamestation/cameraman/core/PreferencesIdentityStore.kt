package co.gamestation.cameraman.core

import android.content.Context

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
        // process killed before an async flush would come back as a different camera.
        preferences.edit().putString(key, value).commit()
    }
}
