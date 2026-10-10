package app.teamstation.cameraman.eventcontrol

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Seals and opens small records. The device's implementation keeps its key in Android Keystore. */
internal interface EventControlSealer {
    fun seal(plain: ByteArray): ByteArray
    fun open(sealed: ByteArray): ByteArray

    /** Drops the sealing key, so the next [seal] makes a new one. */
    fun reset() {}
}

/**
 * AES-256-GCM with a key generated inside Android Keystore that never leaves it. The sealed form
 * is the 12-byte IV followed by the ciphertext and tag.
 */
internal class KeystoreSealer(
    private val alias: String = "app.teamstation.cameraman.eventcontrol",
    private val provider: String = "AndroidKeyStore"
) : EventControlSealer {
    override fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return cipher.iv + cipher.doFinal(plain)
    }

    override fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, IV_BYTES))
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    override fun reset() {
        KeyStore.getInstance(provider).apply { load(null) }.deleteEntry(alias)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(provider).apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, provider)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}

/**
 * This device's control key, one per account server, sealed with [EventControlSealer] in a
 * preferences file of its own: never in the settings store, an export, a log or the wire.
 */
internal class EventControlKeyStore(
    private val preferences: () -> SharedPreferences,
    private val sealer: EventControlSealer = KeystoreSealer()
) {
    constructor(context: Context) : this({
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
    })

    /** The key filed under [server]'s canonical origin, or null when none is kept or it cannot be opened. */
    fun credentials(server: String): EventControlCredentials? {
        val name = entry(server) ?: return null
        val sealed = preferences().getString(name, null) ?: return null
        return runCatching {
            EventControlCredentials.decode(String(sealer.open(Base64.decode(sealed, Base64.NO_WRAP)), Charsets.UTF_8))
        }.getOrElse {
            // Sealed by a Keystore key that no longer exists, or damaged: forget it and fetch again.
            preferences().edit().remove(name).apply()
            null
        }
    }

    /**
     * Seals and files [credentials] under [server]; false when it could not be kept. Never throws:
     * a Keystore that cannot make, load or use its key loses this server's old record and its own
     * key, so the next save starts from a new one, and the caller keeps the key in memory.
     */
    fun save(credentials: EventControlCredentials, server: String): Boolean {
        val name = entry(server) ?: return false
        return try {
            val sealed = sealer.seal(credentials.toJson().toByteArray(Charsets.UTF_8))
            preferences().edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
            true
        } catch (error: Exception) {
            runCatching { preferences().edit().remove(name).apply() }
            runCatching { sealer.reset() }
            false
        }
    }

    /** Sign-out, an account change, a rejected session. */
    fun remove(server: String) {
        val name = entry(server) ?: return
        preferences().edit().remove(name).apply()
    }

    private fun entry(server: String): String? =
        EventControlCredentials.canonicalOrigin(server)?.let { "key:$it" }

    companion object {
        const val FILE = "app.teamstation.cameraman.eventcontrol"
    }
}
