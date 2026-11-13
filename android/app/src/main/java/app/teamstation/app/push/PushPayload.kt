package app.teamstation.app.push

import org.json.JSONException
import org.json.JSONObject

/**
 * What one FCM data message carries (`server/push/chatWakes.ts`,
 * `server/push/rsvpReminders.ts`, `server/push/chatReads.ts`): a single
 * `payload` field holding the JSON of a chat wake, a reminder or a read, as
 * `common/push.ts` defines them. A reminder is shown as it came. A wake is
 * handed to JavaScript whole, which opens it with this phone's chat keys and
 * decides whether anything is shown. A read takes its conversation's
 * notification down.
 */
sealed class PushPayload {
  /** The recipient's user id. */
  abstract val user: String

  data class Reminder(
      override val user: String,
      val title: String,
      val body: String,
      val url: String,
      val tag: String,
  ) : PushPayload()

  data class ChatWake(
      override val user: String,
      val conversation: String,
      /** The message it is for, which a notification of it keeps. */
      val seq: Long,
      val dm: Boolean,
      val from: String,
      val url: String,
      /** The wake as it came, for `chatWakeTask.native.ts` to clean and open. */
      val json: String,
  ) : PushPayload()

  /** The person read [conversation] elsewhere, up to [seq]. */
  data class Read(
      override val user: String,
      val conversation: String,
      val seq: Long,
  ) : PushPayload()

  companion object {
    /** The data field the server puts the payload in. */
    const val FIELD = "payload"

    /** The payload of an FCM message's data, or null for anything else. */
    fun of(data: Map<String, String>): PushPayload? = parse(data[FIELD])

    /** A wake, a reminder or a read from its JSON, or null when it is none of them. */
    fun parse(text: String?): PushPayload? {
      if (text == null) return null
      return try {
        val json = JSONObject(text)
        when (json.opt("t")) {
          "event" ->
              Reminder(
                  json.text("u"),
                  json.text("title"),
                  json.text("body"),
                  json.text("url"),
                  json.text("tag"))
          "chat" ->
              ChatWake(
                  json.text("u"),
                  json.text("c"),
                  json.number("seq"),
                  json.get("dm") as? Boolean ?: throw JSONException("dm"),
                  json.text("from"),
                  json.text("url"),
                  text)
          "read" ->
              Read(json.text("u"), json.text("c"), json.number("seq"))
          else -> null
        }
      } catch (_: JSONException) {
        null
      }
    }

    /**
     * The payload a debug broadcast carries: the wake or the reminder itself,
     * or a whole `push.jsonl` record of an Android message (`server/push/log.ts`),
     * whose `message.data.payload` it is.
     */
    fun debugText(extra: String?): String? {
      if (extra == null) return null
      return try {
        val record = JSONObject(extra)
        val message = record.optJSONObject("message") ?: return extra
        message.optJSONObject("data")?.opt(FIELD) as? String
      } catch (_: JSONException) {
        null
      }
    }

    private fun JSONObject.text(key: String): String =
        opt(key) as? String ?: throw JSONException(key)

    private fun JSONObject.number(key: String): Long =
        (opt(key) as? Number ?: throw JSONException(key)).toLong()
  }
}
