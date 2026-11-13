package app.teamstation.app.push

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.teamstation.app.walkup.NativePushSpec
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * `TSPush` (`src/app/push/NativePush.ts`): this phone's notification
 * permission, its FCM token, the notifications a chat wake shows and a read
 * takes down, the conversation on screen, and the session cookie the app's
 * networking keeps.
 */
class PushModule(context: ReactApplicationContext) : NativePushSpec(context) {
  private val prefs = context.getSharedPreferences(PushHandler.PREFS, 0)

  /** The permission ask whose dialog is up, if any. */
  @Volatile private var asking: PushPermissionAsk? = null

  private val activity: PermissionAwareActivity?
    get() = reactApplicationContext.currentActivity as? PermissionAwareActivity

  /** Whether Android would explain the permission now: refused before, and askable once more. */
  private fun rationale(): Boolean =
      Build.VERSION.SDK_INT >= 33 &&
          activity?.shouldShowRequestPermissionRationale(POST_NOTIFICATIONS) == true

  private fun state(): String =
      PushNotifications.permission(
          Build.VERSION.SDK_INT,
          Build.VERSION.SDK_INT >= 33 &&
              ContextCompat.checkSelfPermission(reactApplicationContext, POST_NOTIFICATIONS) ==
                  PackageManager.PERMISSION_GRANTED,
          NotificationManagerCompat.from(reactApplicationContext).areNotificationsEnabled(),
          prefs.getBoolean(REFUSED, false) || rationale())

  override fun permissionState(promise: Promise) {
    promise.resolve(state())
  }

  /**
   * Asks, from the app's own screen, until the person chooses, and answers
   * what they chose; a refusal is kept, so they are not asked again. Refused
   * already, asking already, or with no screen to ask from, answers as it
   * stands. An ask whose listener a recreated activity lost is answered as
   * the permission stands at the resume after its dialog ([PushPermissionAsk]).
   */
  override fun requestPermission(promise: Promise) {
    val activity = activity
    if (activity == null || asking != null || state() != "prompt") {
      promise.resolve(state())
      return
    }
    lateinit var ask: PushPermissionAsk
    ask =
        PushPermissionAsk({ Handler(Looper.getMainLooper()).post(it) }) { granted ->
          reactApplicationContext.removeLifecycleEventListener(ask)
          if (granted != null && PushNotifications.refusal(granted, rationale()))
              prefs.edit().putBoolean(REFUSED, true).apply()
          if (asking === ask) asking = null
          promise.resolve(state())
        }
    asking = ask
    reactApplicationContext.addLifecycleEventListener(ask)
    activity.requestPermissions(
        arrayOf(POST_NOTIFICATIONS),
        REQUEST,
        PermissionListener { _, _, results ->
          ask.settle(results.firstOrNull() == PackageManager.PERMISSION_GRANTED)
          true
        })
  }

  /** The FCM registration token; null in a build without Firebase (no google-services.json). */
  override fun token(promise: Promise) {
    val token: Task<String?> =
        if (FirebaseApp.getApps(reactApplicationContext).isEmpty()) Tasks.forResult(null)
        else FirebaseMessaging.getInstance().token
    token.addOnCompleteListener { promise.resolve(if (it.isSuccessful) it.result else null) }
  }

  /** At sign-out: FCM's token is deleted, so whatever the server still holds for it reaches nothing. */
  override fun unregister(promise: Promise) {
    val deleted: Task<Void> =
        if (FirebaseApp.getApps(reactApplicationContext).isEmpty()) Tasks.forResult(null)
        else FirebaseMessaging.getInstance().deleteToken()
    deleted.addOnCompleteListener { promise.resolve(null) }
  }

  /** FCM has no sandbox: every Android registration is production. */
  override fun environment(promise: Promise) {
    promise.resolve("production")
  }

  /** [seq] is the chat message the notification is for, or 0 for none. */
  override fun show(title: String, body: String, url: String, tag: String, channel: String, seq: Double) {
    PushHandler.show(
        reactApplicationContext,
        PushNotifications.notice(title, body, url, tag, channel, seq.toLong().takeIf { it > 0 }))
  }

  override fun clear(tag: String) {
    PushHandler.cancel(reactApplicationContext, tag)
  }

  /** Who the app keeps as signed in, or null: [PushHandler.signedIn]. */
  override fun setUser(userId: String?) {
    PushHandler.setSignedIn(reactApplicationContext, userId)
  }

  /**
   * The session token in the cookie React Native's networking keeps for [url]: [SessionCookie].
   * No WebView to keep cookies in is no cookie either.
   */
  override fun sessionCookie(url: String, promise: Promise) {
    promise.resolve(
        runCatching { SessionCookie.of(CookieManager.getInstance().getCookie(url)) }.getOrNull())
  }

  /**
   * Takes the session cookie for [url] out of the jar React Native's networking keeps
   * ([SessionCookie.expiring]), and writes the jar to disk at once, so a sign-out the app does
   * not live past still leaves it gone. Only that cookie: the jar's others, and other hosts', stay.
   */
  override fun clearSessionCookie(url: String, promise: Promise) {
    runCatching {
      val jar = CookieManager.getInstance()
      for (cookie in SessionCookie.expiring(url)) jar.setCookie(url, cookie)
      jar.flush()
    }
    promise.resolve(null)
  }

  override fun setActiveConversation(conversationId: String?) {
    PushHandler.activeConversation = conversationId
  }

  /**
   * Opens this app's notification settings ([PushNotifications.settings]), where a person who
   * refused notifications can allow them; answers whether they opened.
   */
  override fun openSettings(promise: Promise) {
    val target = PushNotifications.settings(reactApplicationContext.packageName)
    val opened = runCatching {
      val intent = Intent(target.action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      for ((key, value) in target.extras) intent.putExtra(key, value)
      (reactApplicationContext.currentActivity ?: reactApplicationContext).startActivity(intent)
    }
    promise.resolve(opened.isSuccess)
  }

  companion object {
    private const val REFUSED = "refused"
    private const val REQUEST = 4126
    private const val POST_NOTIFICATIONS = Manifest.permission.POST_NOTIFICATIONS
  }
}
