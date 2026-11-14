package app.teamstation.app.push

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
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
 * takes down, and the conversation on screen.
 */
class PushModule(context: ReactApplicationContext) : NativePushSpec(context) {
  private val prefs = context.getSharedPreferences(PushHandler.PREFS, 0)

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
   * already (or with no screen to ask from), answers as it stands.
   */
  override fun requestPermission(promise: Promise) {
    val activity = activity
    if (activity == null || state() != "prompt") {
      promise.resolve(state())
      return
    }
    activity.requestPermissions(
        arrayOf(POST_NOTIFICATIONS),
        REQUEST,
        PermissionListener { _, _, results ->
          val granted = results.firstOrNull() == PackageManager.PERMISSION_GRANTED
          if (PushNotifications.refusal(granted, rationale()))
              prefs.edit().putBoolean(REFUSED, true).apply()
          promise.resolve(state())
          true
        })
  }

  /**
   * The FCM registration token; null in a build without Firebase (no
   * google-services.json). Asked for by a signed-in app, which ends a
   * sign-out's quiet ([unregister]).
   */
  override fun token(promise: Promise) {
    PushHandler.setSignedOut(reactApplicationContext, false)
    val token: Task<String?> =
        if (FirebaseApp.getApps(reactApplicationContext).isEmpty()) Tasks.forResult(null)
        else FirebaseMessaging.getInstance().token
    token.addOnCompleteListener { promise.resolve(if (it.isSuccessful) it.result else null) }
  }

  /**
   * At sign-out: FCM's token is deleted, so whatever the server still holds
   * for it reaches nothing, and until the next [token] nothing this phone
   * posts on its own is shown (`PushHandler.signedOut`).
   */
  override fun unregister(promise: Promise) {
    PushHandler.setSignedOut(reactApplicationContext, true)
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

  override fun setActiveConversation(conversationId: String?) {
    PushHandler.activeConversation = conversationId
  }

  companion object {
    private const val REFUSED = "refused"
    private const val REQUEST = 4126
    private const val POST_NOTIFICATIONS = Manifest.permission.POST_NOTIFICATIONS
  }
}
