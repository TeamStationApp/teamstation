package app.teamstation.cameraman.eventcontrol

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.InputStream
import java.io.OutputStream
import java.security.Key
import java.security.KeyStoreSpi
import java.security.Provider
import java.security.ProviderException
import java.security.SecureRandom
import java.security.Security
import java.security.cert.Certificate
import java.security.spec.AlgorithmParameterSpec
import java.util.Collections
import java.util.Date
import java.util.Enumeration
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.KeyGeneratorSpi
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec

/**
 * The control key at rest: sealed with a Keystore key in a preferences file of its own, filed by
 * the account server's canonical origin, never readable in the clear. Robolectric has no Android
 * Keystore, so a stand-in provider of the same name holds the AES key the way the device's would.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlKeyStoreTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()

    @Before
    fun installKeystore() {
        FakeKeys.keys.clear()
        FakeKeys.failGenerate = false
        Security.addProvider(FakeAndroidKeyStore())
    }

    @After
    fun removeKeystore() {
        Security.removeProvider("AndroidKeyStore")
    }

    private fun preferences() = context.getSharedPreferences(EventControlKeyStore.FILE, Context.MODE_PRIVATE)

    @Test
    fun `the Keystore sealer round-trips with one key it makes once and keeps`() {
        val sealer = KeystoreSealer(alias = "test.alias")
        val sealed = sealer.seal("secret record".toByteArray())
        assertEquals("secret record", String(sealer.open(sealed)))
        assertEquals(1, FakeKeys.keys.size)
        val again = sealer.seal("secret record".toByteArray())
        assertNotEquals("a fresh IV each time", sealed.toList(), again.toList())
        assertEquals("secret record", String(KeystoreSealer(alias = "test.alias").open(again)))
        assertEquals(1, FakeKeys.keys.size)
        assertFalse(runCatching { sealer.open(ByteArray(5)) }.isSuccess)
        val tampered = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertFalse(runCatching { sealer.open(tampered) }.isSuccess)
    }

    @Test
    fun `keys are filed by canonical origin, sealed, and removed`() {
        val store = EventControlKeyStore(context)
        val one = EventControlFixtures.one
        store.save(one, "https://App.Example.Test/")
        assertEquals(one, store.credentials("https://app.example.test"))
        assertNull(store.credentials("https://develop9.example.test"))

        val stored = preferences().all
        assertEquals(setOf("key:https://app.example.test"), stored.keys)
        val text = stored.values.single() as String
        assertFalse("the key is not in the clear", text.contains(EventControlFixtures.keyVector("one").getString("key")))
        assertFalse(text.contains(one.issuer))

        // Nothing in the settings file the rest of the app writes and exports.
        assertEquals(emptySet<String>(), context.getSharedPreferences("app.teamstation.cameraman.settings", Context.MODE_PRIVATE).all.keys)

        store.remove("https://app.example.test:443")
        assertNull(store.credentials("https://app.example.test"))
        assertEquals(emptyMap<String, Any>(), preferences().all)
    }

    @Test
    fun `a record that cannot be opened is forgotten, and a server with no origin keeps nothing`() {
        val store = EventControlKeyStore(context)
        preferences().edit().putString("key:https://app.example.test", "AAAA").apply()
        assertNull(store.credentials("https://app.example.test"))
        assertEquals(emptyMap<String, Any>(), preferences().all)

        store.save(EventControlFixtures.one, "not a server")
        assertEquals(emptyMap<String, Any>(), preferences().all)
        assertNull(store.credentials("not a server"))
        store.remove("not a server")
    }

    @Test
    fun `a Keystore key that went away reads as no key`() {
        val store = EventControlKeyStore(context)
        store.save(EventControlFixtures.one, "https://app.example.test")
        FakeKeys.keys.clear()
        assertNull(store.credentials("https://app.example.test"))
    }

    @Test
    fun `a Keystore that cannot make its key fails the save without throwing, and the old record goes`() {
        val store = EventControlKeyStore(context)
        assertTrue(store.save(EventControlFixtures.one, "https://app.example.test"))
        FakeKeys.keys.clear()
        FakeKeys.failGenerate = true
        assertFalse(store.save(EventControlFixtures.one, "https://app.example.test"))
        assertEquals(emptyMap<String, Any>(), preferences().all)
        assertEquals(emptyMap<String, SecretKey>(), FakeKeys.keys)

        FakeKeys.failGenerate = false
        assertTrue(store.save(EventControlFixtures.one, "https://app.example.test"))
        assertEquals(EventControlFixtures.one, store.credentials("https://app.example.test"))
    }

    @Test
    fun `a damaged Keystore key fails the save, is dropped, and the next save makes a new one`() {
        val store = EventControlKeyStore(context)
        assertTrue(store.save(EventControlFixtures.one, "https://app.example.test"))
        // A key the cipher refuses: what a damaged alias looks like to the sealer.
        FakeKeys.keys[ALIAS] = SecretKeySpec(ByteArray(5), "AES")
        assertFalse(store.save(EventControlFixtures.credentials("two"), "https://app.example.test"))
        assertFalse("the alias is reset", FakeKeys.keys.containsKey(ALIAS))
        assertEquals(emptyMap<String, Any>(), preferences().all)

        assertTrue(store.save(EventControlFixtures.credentials("two"), "https://app.example.test"))
        assertEquals(EventControlFixtures.credentials("two"), store.credentials("https://app.example.test"))
        assertEquals(setOf(ALIAS), FakeKeys.keys.keys)
    }

    @Test
    fun `a sealer that throws on seal and on reset never throws out of save`() {
        var resets = 0
        val store = EventControlKeyStore(::preferences, object : EventControlSealer {
            override fun seal(plain: ByteArray): ByteArray = throw ProviderException("Keystore operation failed")
            override fun open(sealed: ByteArray): ByteArray = sealed
            override fun reset() {
                resets += 1
                throw IllegalStateException("no Keystore")
            }
        })
        assertFalse(store.save(EventControlFixtures.one, "https://app.example.test"))
        assertEquals(1, resets)
        assertEquals(emptyMap<String, Any>(), preferences().all)
        assertFalse("a server with no origin keeps nothing", store.save(EventControlFixtures.one, "not a server"))
        assertEquals(1, resets)
    }

    private companion object {
        const val ALIAS = "app.teamstation.cameraman.eventcontrol"
    }
}

/** The AES keys the stand-in Keystore holds, by alias. */
object FakeKeys {
    val keys = ConcurrentHashMap<String, SecretKey>()

    /** Key generation fails, as on a device whose Keystore is broken. */
    @Volatile
    var failGenerate = false
}

class FakeAndroidKeyStore : @Suppress("DEPRECATION") Provider("AndroidKeyStore", 1.0, "test stand-in for Android Keystore") {
    init {
        put("KeyStore.AndroidKeyStore", FakeKeyStoreSpi::class.java.name)
        put("KeyGenerator.AES", FakeAesKeyGenerator::class.java.name)
    }
}

class FakeKeyStoreSpi : KeyStoreSpi() {
    override fun engineGetKey(alias: String, password: CharArray?): Key? = FakeKeys.keys[alias]
    override fun engineGetCertificateChain(alias: String?): Array<Certificate>? = null
    override fun engineGetCertificate(alias: String?): Certificate? = null
    override fun engineGetCreationDate(alias: String?): Date? = null
    override fun engineSetKeyEntry(alias: String?, key: Key?, password: CharArray?, chain: Array<out Certificate>?) = Unit
    override fun engineSetKeyEntry(alias: String?, key: ByteArray?, chain: Array<out Certificate>?) = Unit
    override fun engineSetCertificateEntry(alias: String?, cert: Certificate?) = Unit
    override fun engineDeleteEntry(alias: String) {
        FakeKeys.keys.remove(alias)
    }
    override fun engineAliases(): Enumeration<String> = Collections.enumeration(FakeKeys.keys.keys)
    override fun engineContainsAlias(alias: String): Boolean = FakeKeys.keys.containsKey(alias)
    override fun engineSize(): Int = FakeKeys.keys.size
    override fun engineIsKeyEntry(alias: String): Boolean = FakeKeys.keys.containsKey(alias)
    override fun engineIsCertificateEntry(alias: String?): Boolean = false
    override fun engineGetCertificateAlias(cert: Certificate?): String? = null
    override fun engineStore(stream: OutputStream?, password: CharArray?) = Unit
    override fun engineLoad(stream: InputStream?, password: CharArray?) = Unit
}

class FakeAesKeyGenerator : KeyGeneratorSpi() {
    private var alias = ""

    override fun engineInit(random: SecureRandom?) = Unit
    override fun engineInit(params: AlgorithmParameterSpec?, random: SecureRandom?) {
        alias = (params as KeyGenParameterSpec).keystoreAlias
        check(params.keySize == 256)
    }
    override fun engineInit(keysize: Int, random: SecureRandom?) = Unit
    override fun engineGenerateKey(): SecretKey {
        if (FakeKeys.failGenerate) throw ProviderException("Failed to generate key")
        val key = SecretKeySpec(EventControlBytes.random(32), "AES")
        FakeKeys.keys[alias] = key
        return key
    }
}
