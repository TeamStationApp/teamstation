package app.teamstation.app.push

/** The two channels a person can silence apart in Android's settings. */
enum class PushChannel(val id: String) {
  MESSAGES("messages"),
  EVENTS("events");

  companion object {
    /** The channel `show` names, or the one its tag implies. */
    fun of(name: String?, tag: String): PushChannel =
        entries.firstOrNull { it.id == name }
            ?: if (tag.startsWith("event:")) EVENTS else MESSAGES
  }
}

/** One notification as it is posted: one per tag, so a chat or an event shows once. */
data class PushNotice(
    val channel: PushChannel,
    val title: String,
    val body: String,
    /** What a tap opens: a `teamstation://` link, which `MainActivity` routes. */
    val uri: String,
    val tag: String,
    /** A chat notification's message, which only a read at it or past it takes down. */
    val seq: Long? = null,
) {
  /** The tap intent's request code, distinct for each tag. */
  val requestCode: Int
    get() = tag.hashCode()
}

/** What a push shows, decided apart from Android's classes. */
object PushNotifications {
  /** The app's own scheme, and the link to its home for anything else. */
  const val HOME = "teamstation://"

  /** A tap opens the app's own links only; anything else opens the app. */
  fun tapUri(url: String): String = if (url.startsWith(HOME)) url else HOME

  fun notice(
      title: String,
      body: String,
      url: String,
      tag: String,
      channel: String?,
      seq: Long? = null,
  ): PushNotice = PushNotice(PushChannel.of(channel, tag), title, body, tapUri(url), tag, seq)

  /** The extra a posted notification keeps its [PushNotice.seq] in. */
  const val SEQ = "app.teamstation.seq"


  fun notice(reminder: PushPayload.Reminder): PushNotice =
      notice(reminder.title, reminder.body, reminder.url, reminder.tag, PushChannel.EVENTS.id)

  /**
   * What a reminder shows: nothing once this phone has signed out
   * ([signedOut]), when it would tell whoever holds it about the person's
   * events.
   */
  fun reminder(reminder: PushPayload.Reminder, signedOut: Boolean): PushNotice? =
      if (signedOut) null else notice(reminder)

  /** The tag a conversation's notification is posted with, on every platform. */
  fun chatTag(conversation: String): String = "chat:$conversation"

  /** The notification a read takes down: its conversation's. */
  fun cleared(read: PushPayload.Read): String = chatTag(read.conversation)

  /**
   * Whether a read up to [read] takes down a notification kept with [shown]:
   * one for a message at or before it, or one that kept none. A read that
   * arrives late, behind the wake of a later message, leaves that one up.
   */
  fun clears(shown: Long?, read: Long): Boolean = shown == null || shown <= read

  /**
   * Whether a notice tagged [tag] is left unshown: it is the conversation
   * [active] on screen, with the app [resumed], so the person is reading it.
   */
  fun suppressed(tag: String, active: String?, resumed: Boolean): Boolean =
      resumed && active != null && tag == chatTag(active)

  /**
   * What a DM shows when JavaScript did not open it in time: who wrote,
   * through `template` ("New message from %s"). A group wake shows nothing,
   * and so does a DM once this phone has signed out ([signedOut]).
   */
  fun fallback(wake: PushPayload.ChatWake, template: String, signedOut: Boolean = false): PushNotice? =
      if (!wake.dm || signedOut) null
      else
          notice(
              wake.from,
              template.replace("%s", wake.from),
              wake.url,
              chatTag(wake.conversation),
              PushChannel.MESSAGES.id,
              wake.seq)

  /**
   * `pushState.ts`'s answer. From Android 13 a person is asked for
   * POST_NOTIFICATIONS: before they refuse it is "prompt", a dialog dismissed
   * without a choice included, and once they have refused "denied".
   * Notifications turned off in Settings are "denied" whatever the permission
   * says; before Android 13 there is nothing to ask.
   */
  fun permission(sdk: Int, granted: Boolean, enabled: Boolean, refused: Boolean): String =
      when {
        sdk < 33 -> if (enabled) "granted" else "denied"
        granted -> if (enabled) "granted" else "denied"
        refused -> "denied"
        else -> "prompt"
      }

  /**
   * Whether a request's answer was a refusal, from whether it was granted
   * and `shouldShowRequestPermissionRationale` after it. A refusal is the
   * only answer after which Android offers the rationale; a dismissed dialog
   * leaves it as it was, and may be shown again.
   */
  fun refusal(granted: Boolean, rationale: Boolean): Boolean = !granted && rationale
}
