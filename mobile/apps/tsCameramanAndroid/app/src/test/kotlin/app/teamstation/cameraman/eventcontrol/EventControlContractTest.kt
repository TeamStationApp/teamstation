package app.teamstation.cameraman.eventcontrol

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream
import java.io.EOFException
import java.io.InputStream
import java.security.MessageDigest

/**
 * The shared vectors, byte for byte: the same keys, frames, rejections and assignments the Swift
 * package and the Node reference run.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlContractTest {
    private fun lp(vararg parts: String): ByteArray =
        EventControlBytes.lengthPrefixed(parts.map { EventControlBytes.utf8(it) })

    @Test
    fun `keys json derives every key, key ID and account tag from its secret`() {
        val vectors = EventControlFixtures.objects(EventControlFixtures.json("keys.json").getJSONArray("vectors"))
        assertEquals(5, vectors.size)
        for (vector in vectors) {
            val name = vector.getString("name")
            val secret = EventControlBytes.utf8(vector.getString("secret"))
            val key = EventControlBytes.hmac(
                secret,
                lp("device-event-control:v2", vector.getString("issuer"), vector.getString("userId"))
            )
            assertEquals(name, vector.getString("key"), EventControlBytes.hex(key))
            val keyId = MessageDigest.getInstance("SHA-256")
                .digest(lp("device-event-control:v2:keyid") + EventControlBytes.lengthPrefixed(listOf(secret)))
            assertEquals(name, vector.getString("keyId"), EventControlBytes.hex(keyId).substring(0, 16))
            val tag = EventControlBytes.hmac(key, lp("device-event-control:v2:account-tag"))
            assertEquals(name, vector.getString("accountTag"), EventControlBytes.hex(tag).substring(0, 32))

            // The server contract requires a canonical string identity.
            val reply = JSONObject(vector.toString()).apply {
                remove("name")
                remove("secret")
                put("version", 2)
            }
            val read = EventControlCredentials.decode(reply.toString())
            assertEquals(vector.getString("userId"), read.userId)
            assertEquals(vector.getString("issuer"), read.issuer)
            assertArrayEquals(key, read.keyBytes)
            val numeric = JSONObject(reply.toString()).put("userId", 1001)
            try {
                EventControlCredentials.decode(numeric.toString())
                fail("numeric identity accepted")
            } catch (_: EventControlCredentialsException) {}
        }
        val one = EventControlFixtures.credentials("one")
        assertTrue(one.isSameAccount(EventControlFixtures.credentials("one")))
        assertFalse(one.isSameAccount(EventControlFixtures.credentials("two")))
        assertFalse(one.isSameAccount(EventControlFixtures.credentials("oneOtherServer")))
        assertFalse(one.isSameAccount(EventControlFixtures.credentials("oneRotated")))
        assertEquals(EventControlFixtures.keyVector("two").getString("keyId"), EventControlFixtures.credentials("two").keyId)
    }

    @Test
    fun `frames json encodes to exactly its payload and frame, and decodes back`() {
        val vectors = EventControlFixtures.objects(EventControlFixtures.json("frames.json").getJSONArray("vectors"))
        assertTrue(vectors.size >= 14)
        for (vector in vectors) {
            val name = vector.getString("name")
            val key = EventControlFixtures.credentials(vector.getString("key"))
            val message = message(vector.getJSONObject("message"), key)
            val payload = EventControlCodec.encode(message, key.keyBytes)
            assertEquals(name, vector.getString("payload"), EventControlBytes.hex(payload))
            assertEquals(name, vector.getString("frame"), EventControlBytes.hex(EventControlCodec.frame(payload)))

            val decoded = EventControlCodec.decode(EventControlFixtures.hex(vector.getString("payload")))
            assertTrue(name, decoded.isAuthentic(key.keyBytes))
            assertEquals(name, describe(vector.getJSONObject("message")), describe(decoded.message))
            assertArrayEquals(name, key.accountTagBytes, decoded.message.header.accountTag)
            assertArrayEquals(name, key.keyIdBytes, decoded.message.header.keyId)
            val read = EventControlCodec.readPayload(ByteArrayInputStream(EventControlFixtures.hex(vector.getString("frame"))))
            assertArrayEquals(name, payload, read)
        }
    }

    @Test
    fun `rejections json is refused with the named error and field`() {
        val fixture = EventControlFixtures.json("rejections.json")
        val refused = EventControlFixtures.objects(fixture.getJSONArray("decode"))
        assertTrue(refused.size >= 18)
        for (vector in refused) {
            val name = vector.getString("name")
            try {
                EventControlCodec.decode(EventControlFixtures.hex(vector.getString("payload")))
                fail("$name decoded")
            } catch (error: EventControlCodecException) {
                assertEquals(name, vector.getString("error"), error.error.wireName)
                assertEquals(name, if (vector.has("index")) vector.getInt("index") else null, error.index)
            }
        }
        for (vector in EventControlFixtures.objects(fixture.getJSONArray("unauthentic"))) {
            val decoded = EventControlCodec.decode(EventControlFixtures.hex(vector.getString("payload")))
            val key = EventControlFixtures.credentials(vector.getString("key"))
            assertFalse(vector.getString("name"), decoded.isAuthentic(key.keyBytes))
        }
        for (vector in EventControlFixtures.objects(fixture.getJSONArray("prefixes"))) {
            val name = vector.getString("name")
            val prefix = EventControlFixtures.hex(vector.getString("prefix"))
            if (vector.has("length")) {
                assertEquals(name, vector.getInt("length"), EventControlCodec.payloadLength(prefix))
                continue
            }
            // Refused from the prefix alone: the stream offers no payload bytes and none are read.
            val stream = CountingStream(prefix)
            try {
                EventControlCodec.readPayload(stream)
                fail("$name read")
            } catch (error: EventControlCodecException) {
                assertEquals(name, vector.getString("error"), error.error.wireName)
            }
            assertEquals(name, 4, stream.consumed)
        }
    }

    @Test
    fun `assignments json builds and validates every vector`() {
        val fixture = EventControlFixtures.json("assignments.json")
        val build = EventControlFixtures.objects(fixture.getJSONArray("build"))
        assertTrue(build.size >= 10)
        for (vector in build) {
            val name = vector.getString("name")
            val input = vector.getJSONObject("input")
            val result = runCatching {
                EventAssignment.build(input.getString("gameId"), input.getString("title"), input.getLong("startAtMs"))
            }
            if (vector.has("error")) {
                val error = result.exceptionOrNull() as? EventAssignmentException
                assertEquals(name, vector.getString("error"), error?.problem?.wireName)
            } else {
                val expected = vector.getJSONObject("expected")
                assertEquals(
                    name,
                    EventAssignment(expected.getString("gameId"), expected.getString("title"), expected.getString("startAt")),
                    result.getOrThrow()
                )
            }
        }
        val wire = EventControlFixtures.objects(fixture.getJSONArray("wire"))
        assertTrue(wire.size >= 15)
        for (vector in wire) {
            val name = vector.getString("name")
            val result = runCatching {
                EventAssignment.fromWire(vector.getString("gameId"), vector.getString("title"), vector.getString("startAt"))
            }
            if (vector.isNull("error")) {
                assertEquals(name, vector.getString("gameId"), result.getOrThrow().gameId)
            } else {
                val error = result.exceptionOrNull() as? EventAssignmentException
                assertEquals(name, vector.getString("error"), error?.problem?.wireName)
            }
        }
    }

    @Test
    fun `a stream that ends mid-frame or cleanly is told apart`() {
        assertNull(EventControlCodec.readPayload(ByteArrayInputStream(ByteArray(0))))
        try {
            EventControlCodec.readPayload(ByteArrayInputStream(byteArrayOf(0, 0, 0, 5, 1, 1)))
            fail("read a short payload")
        } catch (expected: EOFException) {
        }
        // A prefix that arrives a byte at a time is still read whole.
        val split = object : InputStream() {
            val bytes = byteArrayOf(0, 0, 0, 2, 1, 1)
            var at = 0
            override fun read(): Int = if (at < bytes.size) bytes[at++].toInt() else -1
            override fun read(into: ByteArray, off: Int, len: Int): Int {
                if (at >= bytes.size) return -1
                into[off] = bytes[at++]
                return 1
            }
        }
        assertArrayEquals(byteArrayOf(1, 1), EventControlCodec.readPayload(split))
    }

    @Test
    fun `credentials refuse every malformed field and never print the key`() {
        val good = EventControlFixtures.keyVector("one")
        fun reply(change: JSONObject.() -> Unit): String =
            JSONObject(good.toString()).apply { remove("name"); remove("secret"); put("version", 2); change() }.toString()
        val problems = mapOf(
            "unsupported key version" to reply { put("version", 1) },
            "bad userId" to reply { put("userId", "10a") },
            "bad issuer" to reply { put("issuer", "") },
            "bad accountTag" to reply { put("accountTag", "AB") },
            "bad keyId" to reply { put("keyId", good.getString("keyId").uppercase()) },
            "bad key" to reply { put("key", "00") },
            "not a key reply" to "[]"
        )
        for ((message, text) in problems) {
            try {
                EventControlCredentials.decode(text)
                fail(message)
            } catch (error: EventControlCredentialsException) {
                assertEquals(message, error.message)
            }
        }
        try {
            EventControlCredentials.decode(reply { put("userId", true) })
            fail("a boolean user ID")
        } catch (error: EventControlCredentialsException) {
            assertEquals("bad userId", error.message)
        }
        val one = EventControlFixtures.one
        assertFalse(one.toString().contains(good.getString("key")))
        assertTrue(one.toString().contains("<redacted>"))
        assertEquals(one.hashCode(), EventControlFixtures.credentials("one").hashCode())
        assertFalse(one.equals("one"))
        assertEquals(one, EventControlCredentials.decode(one.toJson()))
        assertEquals("https://app.example.test", EventControlCredentials.canonicalOrigin("HTTPS://App.Example.Test:443/api/"))
        assertEquals("http://192.0.2.5:9100", EventControlCredentials.canonicalOrigin("http://192.0.2.5:9100"))
        assertEquals("http://localhost", EventControlCredentials.canonicalOrigin("http://localhost:80"))
        assertNull(EventControlCredentials.canonicalOrigin("not a url"))
        assertNull(EventControlCredentials.canonicalOrigin("/relative"))
        assertNull(EventControlCredentials.canonicalOrigin("http:// bad"))
    }

    @Test
    fun `instance IDs are sixteen bytes`() {
        val id = EventControlInstanceId.random()
        assertEquals(32, id.hex.length)
        assertEquals(id, EventControlInstanceId.of(id.hex))
        assertEquals(id.hashCode(), EventControlInstanceId.of(id.bytes)!!.hashCode())
        assertEquals(id.hex, id.toString())
        assertNull(EventControlInstanceId.of("00"))
        assertNull(EventControlInstanceId.of("zz"))
        assertFalse(id.equals(id.hex))
        assertNull(EventControlBytes.fromHex("abc"))
    }

    // MARK: - Helpers

    private class CountingStream(private val bytes: ByteArray) : InputStream() {
        var consumed = 0
        override fun read(): Int = if (consumed < bytes.size) bytes[consumed++].toInt() and 0xff else -1
        override fun read(into: ByteArray, off: Int, len: Int): Int {
            if (consumed >= bytes.size) return -1
            val count = minOf(len, bytes.size - consumed)
            bytes.copyInto(into, off, consumed, consumed + count)
            consumed += count
            return count
        }
    }

    private fun message(json: JSONObject, key: EventControlCredentials): EventControlMessage {
        val header = EventControlHeader(
            sender = EventControlFixtures.hex(json.getString("sender")),
            requestId = java.lang.Long.parseUnsignedLong(json.getString("requestId")),
            accountTag = key.accountTagBytes,
            keyId = key.keyIdBytes,
            challenge = EventControlFixtures.hex(json.getString("challenge")),
            receiverNonce = EventControlFixtures.hex(json.getString("receiverNonce"))
        )
        fun u64(name: String) = java.lang.Long.parseUnsignedLong(json.getString(name))
        val body = when (json.getString("type")) {
            "discover" -> EventControlBody.Discover
            "announce" -> EventControlBody.Announce(
                json.getBoolean("consent"),
                EventControlLeaseState.named(json.getString("lease"))!!,
                u64("leaseRevision")
            )
            "assign" -> EventControlBody.Assign(u64("revision"), json.getString("gameId"), json.getString("title"), json.getString("startAt"))
            "ack" -> EventControlBody.Ack(EventControlAckStatus.named(json.getString("status"))!!, u64("revision"))
            "renew" -> EventControlBody.Renew(u64("revision"))
            else -> EventControlBody.Release(u64("revision"))
        }
        return EventControlMessage(header, body)
    }

    /** A message as the fixtures write it: hex for bytes, decimal strings for u64s. */
    private fun describe(json: JSONObject): Map<String, String> =
        json.keys().asSequence().associateWith { json.get(it).toString() }

    private fun describe(message: EventControlMessage): Map<String, String> {
        val header = message.header
        val out = linkedMapOf(
            "sender" to EventControlBytes.hex(header.sender),
            "requestId" to java.lang.Long.toUnsignedString(header.requestId),
            "challenge" to EventControlBytes.hex(header.challenge),
            "receiverNonce" to EventControlBytes.hex(header.receiverNonce),
            "type" to message.body.type.name.lowercase()
        )
        when (val body = message.body) {
            EventControlBody.Discover -> Unit
            is EventControlBody.Announce -> {
                out["consent"] = body.consent.toString()
                out["lease"] = body.lease.wireName
                out["leaseRevision"] = java.lang.Long.toUnsignedString(body.leaseRevision)
            }
            is EventControlBody.Assign -> {
                out["revision"] = java.lang.Long.toUnsignedString(body.revision)
                out["gameId"] = body.gameId
                out["title"] = body.title
                out["startAt"] = body.startAt
            }
            is EventControlBody.Ack -> {
                out["status"] = body.status.wireName
                out["revision"] = java.lang.Long.toUnsignedString(body.revision)
            }
            is EventControlBody.Renew -> out["revision"] = java.lang.Long.toUnsignedString(body.revision)
            is EventControlBody.Release -> out["revision"] = java.lang.Long.toUnsignedString(body.revision)
        }
        return out
    }
}
