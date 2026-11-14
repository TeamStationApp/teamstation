package app.teamstation.app.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.util.Log
import com.google.firebase.messaging.RemoteMessage
import java.io.File
import java.util.UUID
import kotlin.concurrent.thread

/**
 * The emulator tests' FCM, in debug builds only (`mobile/test/teamStationAppNotifications.e2e.ts`).
 * An emulator has no Firebase project, so a test hands the app what FCM would:
 *
 *     adb shell am broadcast -p app.teamstation.app -a app.teamstation.app.PUSH_DEBUG --es payload '<payload or push.jsonl record>'
 *     adb shell am broadcast -p app.teamstation.app -a app.teamstation.app.PUSH_DEBUG_TOKEN
 *     adb shell am broadcast -p app.teamstation.app -a app.teamstation.app.PUSH_DEBUG_DUMP --es n <n>
 *
 * The first two go through [PushMessagingService]'s own `onMessageReceived`
 * and `onNewToken`, on a worker thread as FCM calls them, with no service
 * started: the token is `debug-<uuid>`. The third writes a coverage build's
 * JaCoCo counters to `files/coverage-<n>.ec`, for the test to pull before the
 * process goes. A broadcast that fails throws, and the test sees the crash.
 */
class PushDebugReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    val app = context.applicationContext
    thread(name = "PushDebug") {
      try {
        when (intent.action) {
          PUSH_DEBUG ->
              PushPayload.debugText(intent.getStringExtra("payload"))?.let {
                service(app)
                    .onMessageReceived(
                        RemoteMessage.Builder("debug@fcm.googleapis.com")
                            .addData(PushPayload.FIELD, it)
                            .build())
              }
          PUSH_DEBUG_TOKEN -> service(app).onNewToken("debug-${UUID.randomUUID()}")
          PUSH_DEBUG_DUMP -> dump(app, intent.getStringExtra("n") ?: "0")
        }
      } finally {
        pending.finish()
      }
    }
  }

  /** FCM's service as FCM would hold it, on the application's context. */
  private fun service(app: Context): PushMessagingService =
      PushMessagingService().also {
        ContextWrapper::class
            .java
            .getDeclaredMethod("attachBaseContext", Context::class.java)
            .apply { isAccessible = true }
            .invoke(it, app)
      }

  /** The JaCoCo agent's counters so far, which a coverage build carries. */
  private fun dump(app: Context, n: String) {
    val agent = Class.forName("org.jacoco.agent.rt.RT").getMethod("getAgent").invoke(null)
    val data =
        agent.javaClass.getMethod("getExecutionData", Boolean::class.javaPrimitiveType).invoke(agent, false)
            as ByteArray
    File(app.filesDir, "coverage-$n.ec").writeBytes(data)
    Log.i(TAG, "coverage-$n.ec ${data.size} bytes")
  }

  companion object {
    private const val TAG = "TSPushDebug"
    const val PUSH_DEBUG = "app.teamstation.app.PUSH_DEBUG"
    const val PUSH_DEBUG_TOKEN = "app.teamstation.app.PUSH_DEBUG_TOKEN"
    const val PUSH_DEBUG_DUMP = "app.teamstation.app.PUSH_DEBUG_DUMP"
  }
}
