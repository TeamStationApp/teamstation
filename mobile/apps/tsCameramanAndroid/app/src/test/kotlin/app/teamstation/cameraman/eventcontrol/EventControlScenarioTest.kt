package app.teamstation.cameraman.eventcontrol

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * scenarios.json, run against [EventControlReceiver]: the receiver's behaviour exactly as every
 * implementation must reproduce it, step by step.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EventControlScenarioTest {
    private val fixture = EventControlFixtures.json("scenarios.json")

    @Test
    fun `every scenario in scenarios json passes`() {
        val scenarios = EventControlFixtures.objects(fixture.getJSONArray("scenarios"))
        assertTrue("${scenarios.size} scenarios", scenarios.size >= 25)
        for (scenario in scenarios) Run(fixture, scenario).run()
    }

    private class Run(private val fixture: JSONObject, private val scenario: JSONObject) {
        private val name = scenario.getString("name")
        private val instances = fixture.getJSONObject("instances")
        private val hosts = fixture.getJSONObject("hosts")
        private val challenges = fixture.getJSONObject("challenges")
        private val assignments = fixture.getJSONObject("assignments")
        private var clock = fixture.getLong("clockStartMs")
        private val nonces = fixture.getJSONArray("nonces").let { array ->
            ArrayDeque((0 until array.length()).map { EventControlFixtures.hex(array.getString(it)) })
        }
        private var applies = 0
        private val events = ArrayList<EventControlReceiverEvent>()
        private lateinit var receiver: EventControlReceiver

        private fun credentials(key: String): EventControlCredentials {
            if (key != "forged") return EventControlFixtures.credentials(key)
            val one = EventControlFixtures.one
            return EventControlCredentials.of(one.issuer, one.userId, one.accountTag, one.keyId, fixture.getString("forgedKey"))
        }

        fun run() = runBlocking {
            val answer = EventControlAckStatus.named(scenario.optString("apply", "applied"))!!
            // One op, or a list run in order.
            val hooks = scenario.optJSONArray("duringApply")
                ?.let { list -> (0 until list.length()).map { list.getJSONObject(it) } }
                ?: listOfNotNull(scenario.optJSONObject("duringApply"))
            receiver = EventControlReceiver(
                instanceId = EventControlInstanceId.of(instances.getString("receiver"))!!,
                credentials = EventControlFixtures.one,
                consent = scenario.optBoolean("consent", true),
                apply = { _, _ ->
                    applies += 1
                    for (hook in hooks) {
                        if (hook.getString("op") == "setConsent") {
                            receiver.setConsent(hook.getBoolean("value"))
                        } else {
                            receiver.setCredentials(if (hook.isNull("key")) null else credentials(hook.getString("key")))
                        }
                    }
                    answer
                },
                now = { clock },
                random = { nonces.removeFirst() },
                timers = null,
                onEvent = { events += it }
            )
            val sent = ArrayList<ByteArray>()
            val replies = ArrayList<ByteArray?>()
            val nonceOf = HashMap<Int, ByteArray>()
            val steps = EventControlFixtures.objects(scenario.getJSONArray("steps"))
            for ((index, step) in steps.withIndex()) {
                val label = "$name step $index"
                val expect = step.optJSONObject("expect") ?: JSONObject()
                if (step.has("op")) {
                    when (step.getString("op")) {
                        "advance" -> {
                            clock += step.getLong("ms")
                            receiver.expireIfDue()
                        }
                        "setConsent" -> receiver.setConsent(step.getBoolean("value"))
                        "setCredentials" -> receiver.setCredentials(
                            if (step.isNull("key")) null else credentials(step.getString("key"))
                        )
                        "restart" -> receiver.restart()
                        "closeConnection" -> receiver.connectionClosed(step.getLong("connection"))
                        else -> error("$label: unknown op")
                    }
                    sent += ByteArray(0)
                    replies += null
                    check(expect, label)
                    continue
                }

                val connection = step.getInt("connection")
                val director = step.getString("director")
                val key = credentials(step.optString("key", "one"))
                var payload = when (step.getString("send")) {
                    "raw" -> EventControlFixtures.hex(step.getString("hex"))
                    "replay" -> sent[step.getInt("fromStep")]
                    else -> {
                        val header = EventControlHeader(
                            sender = EventControlFixtures.hex(instances.getString(director)),
                            requestId = step.optString("requestId", "0").toLong(),
                            accountTag = key.accountTagBytes,
                            keyId = key.keyIdBytes,
                            challenge = EventControlFixtures.hex(challenges.getString(connection.toString())),
                            receiverNonce = if (step.has("nonce")) {
                                EventControlFixtures.hex(step.getString("nonce"))
                            } else {
                                nonceOf[connection] ?: ByteArray(0)
                            }
                        )
                        EventControlCodec.encode(EventControlMessage(header, body(step)), key.keyBytes)
                    }
                }
                if (step.optBoolean("tamper")) {
                    payload = payload.copyOf()
                    payload[payload.size - 1] = (payload[payload.size - 1].toInt() xor 1).toByte()
                }
                sent += payload

                val reply = receiver.handle(payload, connection.toLong(), hosts.getString(director))
                assertTrue(label, reply.replies.size <= 1)
                val answered = reply.replies.firstOrNull()
                replies += answered
                if (expect.has("close")) assertEquals(label, expect.getBoolean("close"), reply.close)
                if (expect.has("sameReplyAs")) {
                    assertArrayEquals(label, replies[expect.getInt("sameReplyAs")], answered)
                }
                if (expect.has("reply")) {
                    if (expect.isNull("reply")) {
                        assertNull(label, answered)
                    } else {
                        val wanted = expect.getJSONObject("reply")
                        assertNotNull(label, answered)
                        val decoded = EventControlCodec.decode(answered!!)
                        val replyKey = credentials(expect.optString("replyKey", "one"))
                        assertTrue("$label MAC", decoded.isAuthentic(replyKey.keyBytes))
                        val header = decoded.message.header
                        val asked = runCatching { EventControlCodec.decode(payload).message.header }.getOrNull()
                        val echoed = if (wanted.has("requestId")) wanted.getString("requestId").toLong() else asked?.requestId ?: 0
                        assertEquals("$label requestId", echoed, header.requestId)
                        if (wanted.optString("status") == "unsupported") {
                            assertArrayEquals(label, ByteArray(16), header.challenge)
                        } else {
                            assertArrayEquals(label, asked!!.challenge, header.challenge)
                        }
                        val expected = wanted.keys().asSequence().filter { it != "requestId" }
                            .associateWith { wanted.get(it).toString() }
                        assertEquals(label, expected, describe(decoded.message.body))
                        if (decoded.message.body is EventControlBody.Announce) nonceOf[connection] = header.receiverNonce
                    }
                }
                check(expect, label)
            }
        }

        private fun body(step: JSONObject): EventControlBody {
            val revision = step.optString("revision", "0").toLong()
            return when (step.getString("send")) {
                "discover" -> EventControlBody.Discover
                "assign" -> {
                    val fields = assignments.getJSONObject(step.getString("assignment"))
                    EventControlBody.Assign(revision, fields.getString("gameId"), fields.getString("title"), fields.getString("startAt"))
                }
                "renew" -> EventControlBody.Renew(revision)
                "release" -> EventControlBody.Release(revision)
                else -> EventControlBody.Ack(EventControlAckStatus.named(step.getString("status"))!!, revision)
            }
        }

        private fun describe(body: EventControlBody): Map<String, String> = when (body) {
            is EventControlBody.Announce -> mapOf(
                "type" to "announce",
                "consent" to body.consent.toString(),
                "lease" to body.lease.wireName,
                "leaseRevision" to body.leaseRevision.toString()
            )
            is EventControlBody.Ack -> mapOf(
                "type" to "ack",
                "status" to body.status.wireName,
                "revision" to body.revision.toString()
            )
            else -> mapOf("type" to body.type.name.lowercase())
        }

        private fun check(expect: JSONObject, label: String) {
            if (expect.has("applies")) assertEquals("$label applies", expect.getInt("applies"), applies)
            if (expect.has("lease")) {
                val held = receiver.overrideState
                if (expect.isNull("lease")) {
                    assertNull("$label lease", held)
                } else {
                    val wanted = expect.getJSONObject("lease")
                    assertNotNull("$label lease", held)
                    val fields = assignments.getJSONObject(wanted.getString("assignment"))
                    assertEquals(label, instances.getString(wanted.getString("owner")), held!!.owner.hex)
                    assertEquals(label, wanted.getString("revision").toLong(), held.revision)
                    assertEquals(label, wanted.getString("ownerHost"), held.ownerHost)
                    assertEquals(
                        label,
                        EventAssignment(fields.getString("gameId"), fields.getString("title"), fields.getString("startAt")),
                        held.assignment
                    )
                }
            }
            if (expect.has("ended")) {
                val ended = events.filterIsInstance<EventControlReceiverEvent.OverrideEnded>().lastOrNull()
                assertEquals("$label ended", expect.getString("ended"), ended?.reason?.wireName)
            }
            if (expect.has("keyMismatch")) {
                val keyId = credentials(expect.getString("keyMismatch")).keyId
                assertTrue("$label keyMismatch", events.contains(EventControlReceiverEvent.KeyMismatch(keyId)))
            }
        }
    }
}
