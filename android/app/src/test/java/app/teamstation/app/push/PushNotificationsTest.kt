package app.teamstation.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a push posts: its channel, its fields, and what a tap opens. */
class PushNotificationsTest {
  @Test
  fun choosesTheChannel() {
    assertEquals(PushChannel.MESSAGES, PushChannel.of("messages", "event:g1"))
    assertEquals(PushChannel.EVENTS, PushChannel.of("events", "chat:c1"))
    assertEquals(PushChannel.EVENTS, PushChannel.of("", "event:g1"))
    assertEquals(PushChannel.MESSAGES, PushChannel.of(null, "chat:c1"))
    assertEquals(PushChannel.MESSAGES, PushChannel.of("other", "anything"))
    assertEquals(listOf("messages", "events"), PushChannel.entries.map { it.id })
  }

  @Test
  fun tapsOpenTheAppsOwnLinksOnly() {
    assertEquals("teamstation://chat/c1", PushNotifications.tapUri("teamstation://chat/c1"))
    assertEquals("teamstation://games/g1", PushNotifications.tapUri("teamstation://games/g1"))
    assertEquals("teamstation://", PushNotifications.tapUri("https://example.test/chat/c1"))
    assertEquals("teamstation://", PushNotifications.tapUri(""))
  }

  @Test
  fun aNoticeKeepsItsFields() {
    val notice =
        PushNotifications.notice("Erin", "Bring the cones", "teamstation://chat/c1", "chat:c1", "messages")
    assertEquals(
        PushNotice(PushChannel.MESSAGES, "Erin", "Bring the cones", "teamstation://chat/c1", "chat:c1"),
        notice)
    assertEquals("chat:c1".hashCode(), notice.requestCode)
    assertNotEquals(
        notice.requestCode,
        PushNotifications.notice("Erin", "x", "teamstation://chat/c2", "chat:c2", "messages").requestCode)
  }

  @Test
  fun showsNothingForTheConversationOnScreen() {
    assertEquals("chat:c1", PushNotifications.chatTag("c1"))
    // A read takes down the tag its wake was posted with.
    assertEquals("chat:c1", PushNotifications.cleared(PushPayload.Read("u1", "c1", 3L)))
    assertTrue(PushNotifications.suppressed("chat:c1", "c1", true))
    // In the background, on another conversation, on none, or a reminder: shown.
    assertFalse(PushNotifications.suppressed("chat:c1", "c1", false))
    assertFalse(PushNotifications.suppressed("chat:c1", "c2", true))
    assertFalse(PushNotifications.suppressed("chat:c1", null, true))
    assertFalse(PushNotifications.suppressed("event:c1", "c1", true))
  }

  @Test
  fun aReadTakesDownOnlyWhatWasAtOrBeforeIt() {
    val shown = PushNotifications.notice("Erin", "Hi", "teamstation://chat/c1", "chat:c1", "messages", 12L)
    assertEquals(12L, shown.seq)
    // A read of seq 11, held back behind the wake for 12, leaves it up.
    assertFalse(PushNotifications.clears(shown.seq, 11L))
    assertTrue(PushNotifications.clears(shown.seq, 12L))
    assertTrue(PushNotifications.clears(shown.seq, 40L))
    // A notification that kept no seq goes on any read of its chat.
    assertNull(PushNotifications.notice("Erin", "Hi", "teamstation://chat/c1", "chat:c1", "messages").seq)
    assertTrue(PushNotifications.clears(null, 1L))
  }

  @Test
  fun aReminderIsAnEvent() {
    val reminder =
        PushPayload.Reminder("u1", "Batting cage", "Starts at 5:30 PM", "teamstation://games/g1", "event:g1")
    assertEquals(
        PushNotice(
            PushChannel.EVENTS, "Batting cage", "Starts at 5:30 PM", "teamstation://games/g1", "event:g1"),
        PushNotifications.notice(reminder))
    assertEquals(PushNotifications.notice(reminder), PushNotifications.reminder(reminder, signedOut = false))
    // Signed out, the phone tells whoever holds it nothing of the person's events.
    assertNull(PushNotifications.reminder(reminder, signedOut = true))
  }

  @Test
  fun aDmNotOpenedInTimeSaysWhoWrote() {
    val dm = PushPayload.ChatWake("u2", "c1", 7L, true, "Erin", "teamstation://chat/c1", "{}")
    assertEquals(
        PushNotice(
            PushChannel.MESSAGES, "Erin", "New message from Erin", "teamstation://chat/c1", "chat:c1", 7L),
        PushNotifications.fallback(dm, "New message from %s"))
    assertNull(PushNotifications.fallback(dm.copy(dm = false), "New message from %s"))
    // Signed out, nor who writes to the person.
    assertNull(PushNotifications.fallback(dm, "New message from %s", signedOut = true))
  }

  @Test
  fun answersThePermissionAsPushStateDoes() {
    // Android 13 and later ask once.
    assertEquals("prompt", PushNotifications.permission(33, granted = false, enabled = false, refused = false))
    assertEquals("denied", PushNotifications.permission(36, granted = false, enabled = false, refused = true))
    assertEquals("granted", PushNotifications.permission(36, granted = true, enabled = true, refused = true))
    // Allowed, then turned off in Settings.
    assertEquals("denied", PushNotifications.permission(36, granted = true, enabled = false, refused = false))
    // Before 13 there is no question, only the setting.
    assertEquals("granted", PushNotifications.permission(32, granted = false, enabled = true, refused = false))
    assertEquals("denied", PushNotifications.permission(30, granted = false, enabled = false, refused = false))
  }

  @Test
  fun aDismissedDialogIsNoRefusal() {
    // Refused: Android offers the rationale from then on.
    assertTrue(PushNotifications.refusal(granted = false, rationale = true))
    // Dismissed without a choice: no rationale, and the person may be asked again.
    assertFalse(PushNotifications.refusal(granted = false, rationale = false))
    assertEquals("prompt", PushNotifications.permission(33, granted = false, enabled = false, refused = false))
    assertFalse(PushNotifications.refusal(granted = true, rationale = false))
  }
}
