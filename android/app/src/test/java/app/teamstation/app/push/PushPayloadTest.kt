package app.teamstation.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The FCM `payload` field, as `server/push/chatWakes.ts`, `rsvpReminders.ts`
 * and `chatReads.ts` send it.
 */
class PushPayloadTest {
  private val reminder =
      """{"t":"event","u":"u1","title":"Hawks vs Owls","body":"Sam · Starts at 5:30 PM","url":"teamstation://games/g1","tag":"event:g1"}"""
  private val wake =
      """{"t":"chat","u":"u2","c":"c1","seq":7,"dm":true,"from":"Erin","title":null,"url":"teamstation://chat/c1","env":{"seq":7}}"""

  @Test
  fun readsAReminder() {
    assertEquals(
        PushPayload.Reminder(
            "u1", "Hawks vs Owls", "Sam · Starts at 5:30 PM", "teamstation://games/g1", "event:g1"),
        PushPayload.of(mapOf("payload" to reminder)))
  }

  @Test
  fun readsAWakeAndKeepsItWhole() {
    val read = PushPayload.parse(wake)
    assertEquals(
        PushPayload.ChatWake("u2", "c1", 7L, true, "Erin", "teamstation://chat/c1", wake), read)
    assertEquals("u2", read?.user)
    val group = wake.replace("\"dm\":true", "\"dm\":false").replace("\"title\":null", "\"title\":\"Eagles Members\"")
    assertEquals(false, (PushPayload.parse(group) as PushPayload.ChatWake).dm)
    // A wake names the message it is for.
    assertNull(PushPayload.parse(wake.replace("\"seq\":7,", "")))
  }

  @Test
  fun readsARead() {
    val read = """{"t":"read","u":"u2","c":"c1","seq":9}"""
    assertEquals(PushPayload.Read("u2", "c1", 9L), PushPayload.of(mapOf("payload" to read)))
    assertNull(PushPayload.parse(read.replace("\"seq\":9", "\"seq\":\"9\"")))
    assertNull(PushPayload.parse(read.replace(",\"c\":\"c1\"", "")))
  }

  @Test
  fun refusesAnythingElse() {
    assertNull(PushPayload.of(mapOf()))
    assertNull(PushPayload.of(mapOf("other" to reminder)))
    assertNull(PushPayload.parse("not json"))
    assertNull(PushPayload.parse("""{"t":"other","u":"u1"}"""))
    assertNull(PushPayload.parse("""{"u":"u1"}"""))
    // A field of the wrong kind, or missing, is no payload at all.
    assertNull(PushPayload.parse(reminder.replace("\"u\":\"u1\"", "\"u\":1")))
    assertNull(PushPayload.parse(reminder.replace(",\"tag\":\"event:g1\"", "")))
    assertNull(PushPayload.parse(wake.replace("\"dm\":true", "\"dm\":\"yes\"")))
    assertNull(PushPayload.parse(wake.replace("\"c\":\"c1\",", "")))
  }

  @Test
  fun unwrapsALoggedAndroidMessage() {
    val record =
        """{"at":"2026-11-12T00:00:00Z","registrationId":"r1","userId":"u1","platform":"android","environment":"production","address":"debug-1","message":{"platform":"android","priority":"high","data":{"payload":${org.json.JSONObject.quote(reminder)}}}}"""
    assertEquals(reminder, PushPayload.debugText(record))
    assertEquals(reminder, PushPayload.debugText(reminder))
    assertNull(PushPayload.debugText(null))
    assertNull(PushPayload.debugText("not json"))
    assertNull(PushPayload.debugText("""{"message":{"platform":"web","payload":"x"}}"""))
    assertNull(PushPayload.debugText("""{"message":{"data":{"payload":3}}}"""))
  }
}
