package app.teamstation.cameraman.eventcontrol

import org.json.JSONArray
import org.json.JSONObject

/**
 * The shared contract fixtures, from this app's test resources: byte-identical copies of
 * `mobile/apps/common/EventControl/Tests/Fixtures`, which `scripts/checkEventControlContract.cjs`
 * holds to the same SHA-256. Read with the real `org.json`, so only under Robolectric.
 */
internal object EventControlFixtures {
    fun text(name: String): String {
        val stream = EventControlFixtures::class.java.classLoader!!.getResourceAsStream("eventcontrol/$name")
            ?: error("no fixture $name")
        return stream.use { String(it.readBytes(), Charsets.UTF_8) }
    }

    fun json(name: String): JSONObject = JSONObject(text(name))

    fun hex(text: String): ByteArray = EventControlBytes.fromHex(text) ?: error("not hex: $text")

    fun keyVector(name: String): JSONObject {
        val vectors = json("keys.json").getJSONArray("vectors")
        for (index in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(index)
            if (vector.getString("name") == name) return vector
        }
        error("no key named $name")
    }

    fun credentials(name: String): EventControlCredentials {
        val vector = keyVector(name)
        return EventControlCredentials.of(
            issuer = vector.getString("issuer"),
            userId = vector.getString("userId"),
            accountTag = vector.getString("accountTag"),
            keyId = vector.getString("keyId"),
            key = vector.getString("key")
        )
    }

    val one: EventControlCredentials get() = credentials("one")

    fun objects(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }
}
