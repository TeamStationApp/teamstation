package app.teamstation.cameraman.core

import java.util.Locale
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Persistent storage behind an interface so the identity rules can be tested without Android,
 * which is not available in a JVM unit-test process.
 */
interface IdentityStore {
    fun string(key: String): String?
    fun setString(value: String, key: String)
}

/**
 * The pair of values every camera on the field needs: a machine-owned identifier that never
 * changes, and a human label that can.
 *
 * RFC 3550 already defines exactly this pair, so nothing here is invented. The UUID is carried as
 * the RTCP **CNAME** (§6.5.1) in RFC 7022's long-term persistent form, and the label as SDES
 * **NAME** (§6.5.2), "the real name used to describe the source … in any form desired by the user".
 */
class DeviceIdentity(val uuid: String, rawName: String) {
    val name: String = normalized(rawName, uuid)

    /**
     * RFC 5576 requires the SDP `cname` and the RTCP SDES CNAME to be the same string, so there is
     * deliberately only one source for both.
     */
    val cname: String get() = uuid

    override fun equals(other: Any?): Boolean =
        other is DeviceIdentity && other.uuid == uuid && other.name == name

    override fun hashCode(): Int = uuid.hashCode() * 31 + name.hashCode()

    override fun toString(): String = "DeviceIdentity(uuid=$uuid, name=$name)"

    companion object {
        /**
         * Deliberately *not* the device's own name. `Settings.Global.DEVICE_NAME` needs no
         * permission but is often unset or identical across a rack of the same handset, so three
         * phones on a field would announce the same label. A suffix of the UUID cannot collide.
         */
        fun defaultName(uuid: String): String {
            val compact = uuid.replace("-", "")
            return "Camera " + compact.takeLast(4).uppercase(Locale.US)
        }

        /**
         * RFC 4566 forbids an empty SDP session name, so a cleared field falls back to the default
         * rather than emitting `s=` with nothing after it.
         */
        fun normalized(name: String, uuid: String): String {
            val trimmed = name.trim()
            // CR and LF would terminate the SDP line early and split one field into two. Empty
            // pieces are dropped rather than joined, so a CRLF pair does not leave a double space.
            val sanitised = trimmed
                .split(Regex("\\R"))
                .filter { it.isNotEmpty() }
                .joinToString(" ")
            return sanitised.ifEmpty { defaultName(uuid) }
        }

        fun generatedUUID(): String = UUID.randomUUID().toString().lowercase(Locale.US)

        /**
         * A name-based (version 3) UUID from [seed]. The same seed always gives the same UUID, and
         * the seed itself cannot be read back out of the CNAME it ends up in.
         */
        fun derivedUUID(seed: String): String =
            UUID.nameUUIDFromBytes("app.teamstation.cameraman.identity:$seed".toByteArray(Charsets.UTF_8))
                .toString()
                .lowercase(Locale.US)
    }
}

/**
 * Loads the identity, creating and persisting it on first launch.
 *
 * [installSeed] is fixed for the life of this install and differs on every other install and
 * handset. When there is one, the first UUID is derived from it rather than drawn at random, so an
 * install whose first save never reaches disk mints the same UUID again on the next launch instead
 * of announcing a different camera every time. A UUID once handed out therefore stays, whether or
 * not the save that should have kept it succeeded.
 */
class DeviceIdentityProvider(
    private val store: IdentityStore,
    private val installSeed: String? = null
) {

    fun load(): DeviceIdentity {
        val stored = store.string(uuidKey)
        val uuid = if (stored != null && isWellFormed(stored)) {
            stored
        } else {
            mintedUUID().also { store.setString(it, uuidKey) }
        }
        val name = store.string(nameKey) ?: DeviceIdentity.defaultName(uuid)
        return DeviceIdentity(uuid, name)
    }

    fun save(name: String): DeviceIdentity {
        val identity = load()
        val normalised = DeviceIdentity.normalized(name, identity.uuid)
        store.setString(normalised, nameKey)
        return DeviceIdentity(identity.uuid, normalised)
    }

    private fun mintedUUID(): String =
        installSeed?.takeIf { it.isNotBlank() }?.let { DeviceIdentity.derivedUUID(it) }
            ?: DeviceIdentity.generatedUUID()

    companion object {
        const val uuidKey = "app.teamstation.cameraman.identity.uuid"
        const val nameKey = "app.teamstation.cameraman.identity.name"

        /**
         * A UUID that survived a corrupt or truncated write must be rejected, because a malformed
         * CNAME would make TS Director bind two different phones to one record.
         */
        fun isWellFormed(uuid: String): Boolean {
            if (uuid.length != 36 || uuid != uuid.lowercase(Locale.US)) return false
            // `UUID.fromString` accepts short groups like "1-1-1-1-1", so the round trip rather
            // than the parse is what settles it.
            return runCatching { UUID.fromString(uuid).toString() == uuid }.getOrDefault(false)
        }
    }
}

/** Test storage. Also the fallback when the real store cannot be opened. */
class InMemoryIdentityStore(values: Map<String, String> = emptyMap()) : IdentityStore {
    private val lock = ReentrantLock()
    private val values = values.toMutableMap()

    override fun string(key: String): String? = lock.withLock { values[key] }

    override fun setString(value: String, key: String) {
        lock.withLock { values[key] = value }
    }
}
