package app.teamstation.app.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.teamstation.app.MainActivity
import app.teamstation.app.R
import com.facebook.react.ReactApplication
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.common.LifecycleState
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Where every push and every new token goes: FCM's service, and in a debug
 * build the emulator tests' broadcast. A reminder is posted at once. A chat
 * wake is opened by the JavaScript task `ChatWake`
 * (`chatWakeTask.native.ts`), in this call, on the caller's worker thread:
 * FCM gives a normal-priority message no allowance to start a service, so
 * nothing is started, and the thread waits for the task. A read takes its
 * conversation's notification down, and nothing is shown for the
 * conversation on screen.
 */
object PushHandler {
  /** How long a wake or a token may take: FCM allows a message about ten seconds. */
  const val TASK_MS = 9_000L

  /**
   * The conversation on screen, as JavaScript says (`TSPush.setActiveConversation`),
   * or null.
   */
  @Volatile var activeConversation: String? = null

  /** Where [PushModule] keeps what it knows of this phone. */
  const val PREFS = "app.teamstation.push"
  private const val SIGNED_OUT = "signedOut"

  /**
   * Whether this phone signed out (`TSPush.unregister`) and has not asked for
   * its token since, as a signed-in app does: then nothing it posts on its
   * own is shown.
   */
  fun signedOut(context: Context): Boolean =
      context.getSharedPreferences(PREFS, 0).getBoolean(SIGNED_OUT, false)

  fun setSignedOut(context: Context, signedOut: Boolean) {
    context.getSharedPreferences(PREFS, 0).edit().putBoolean(SIGNED_OUT, signedOut).apply()
  }

  /** Handles one FCM message's data. Never on the main thread: it waits. */
  fun handle(context: Context, data: Map<String, String>) {
    when (val payload = PushPayload.of(data)) {
      is PushPayload.Reminder ->
          PushNotifications.reminder(payload, signedOut(context))?.let { show(context, it) }
      is PushPayload.ChatWake -> runChatWake(context, payload)
      is PushPayload.Read -> cancel(context, PushNotifications.cleared(payload), payload.seq)
      null -> Unit
    }
  }

  /**
   * Takes down the notification posted with [tag], if it is still there; with
   * [upTo], only if it is for a message at or before it ([PushNotifications.clears]).
   */
  fun cancel(context: Context, tag: String, upTo: Long? = null) {
    if (upTo != null) {
      val shown =
          context.getSystemService(NotificationManager::class.java).activeNotifications.firstOrNull {
            it.tag == tag && it.id == 0
          } ?: return
      val extras = shown.notification.extras
      val seq = if (extras.containsKey(PushNotifications.SEQ)) extras.getLong(PushNotifications.SEQ) else null
      if (!PushNotifications.clears(seq, upTo)) return
    }
    NotificationManagerCompat.from(context).cancel(tag, 0)
  }

  /** Whether React's activity is in the foreground: resumed. */
  private fun resumed(context: Context): Boolean =
      (context.applicationContext as? ReactApplication)
          ?.reactHost
          ?.currentReactContext
          ?.lifecycleState == LifecycleState.RESUMED

  /**
   * Opens a wake in JavaScript, which posts what it shows through `TSPush.show`.
   * A DM the task did not finish in time still says who wrote, unless this
   * phone has signed out.
   */
  fun runChatWake(context: Context, wake: PushPayload.ChatWake) {
    val finished = runTask(context, "ChatWake", Bundle().apply { putString(PushPayload.FIELD, wake.json) })
    if (finished) return
    PushNotifications.fallback(
            wake, context.getString(R.string.push_new_message_from), signedOut(context))
        ?.let { show(context, it) }
  }

  /** Registers `token` for the signed-in session, through the JavaScript task `PushToken`. */
  fun registerToken(context: Context, token: String): Boolean =
      runTask(context, "PushToken", Bundle().apply { putString("token", token) })

  /**
   * Runs the headless task `task` with `data`, starting React first when this
   * process has none, and waits until it ends or [TASK_MS] pass. True when it ended.
   */
  fun runTask(context: Context, task: String, data: Bundle): Boolean {
    val host = (context.applicationContext as ReactApplication).reactHost ?: return false
    val done = CountDownLatch(1)
    val start = { react: ReactContext ->
      val tasks = HeadlessJsTaskContext.getInstance(react)
      var id = -1
      val listener =
          object : HeadlessJsTaskEventListener {
            override fun onHeadlessJsTaskStart(taskId: Int) = Unit

            override fun onHeadlessJsTaskFinish(taskId: Int) {
              if (taskId != id) return
              tasks.removeTaskEventListener(this)
              done.countDown()
            }
          }
      tasks.addTaskEventListener(listener)
      try {
        id = tasks.startTask(HeadlessJsTaskConfig(task, Arguments.fromBundle(data), TASK_MS, true))
      } catch (_: RuntimeException) {
        tasks.removeTaskEventListener(listener)
        done.countDown()
      }
    }
    UiThreadUtil.runOnUiThread {
      val current = host.currentReactContext
      if (current != null) {
        start(current)
        return@runOnUiThread
      }
      host.addReactInstanceEventListener(
          object : ReactInstanceEventListener {
            override fun onReactContextInitialized(context: ReactContext) {
              host.removeReactInstanceEventListener(this)
              UiThreadUtil.runOnUiThread { start(context) }
            }
          })
      host.start()
    }
    return done.await(TASK_MS, TimeUnit.MILLISECONDS)
  }

  /**
   * Posts `notice`, unless this phone may not show notifications, or the
   * conversation it is about is on screen.
   */
  fun show(context: Context, notice: PushNotice) {
    val manager = NotificationManagerCompat.from(context)
    if (!manager.areNotificationsEnabled()) return
    if (PushNotifications.suppressed(notice.tag, activeConversation, resumed(context))) return
    channels(context)
    val open =
        Intent(Intent.ACTION_VIEW, Uri.parse(notice.uri), context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap =
        PendingIntent.getActivity(
            context,
            notice.requestCode,
            open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val notification =
        NotificationCompat.Builder(context, notice.channel.id)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
            .setCategory(
                if (notice.channel == PushChannel.EVENTS) NotificationCompat.CATEGORY_EVENT
                else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .apply { notice.seq?.let { addExtras(Bundle().apply { putLong(PushNotifications.SEQ, it) }) } }
            .build()
    try {
      manager.notify(notice.tag, 0, notification)
    } catch (_: SecurityException) {
      // The permission was withdrawn between the check and the post.
    }
  }

  /** "Messages" and "Events", made once. */
  private fun channels(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    for ((channel, name) in
        listOf(
            PushChannel.MESSAGES to R.string.push_channel_messages,
            PushChannel.EVENTS to R.string.push_channel_events)) {
      if (manager.getNotificationChannel(channel.id) == null)
          manager.createNotificationChannel(
              NotificationChannel(
                  channel.id, context.getString(name), NotificationManager.IMPORTANCE_HIGH))
    }
  }
}
