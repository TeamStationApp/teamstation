package app.teamstation.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * FCM's deliveries. Every message is data only, so this runs for each one,
 * on FCM's worker thread, whatever the app is doing; [PushHandler] decides
 * what is shown.
 */
class PushMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    PushHandler.handle(this, message.data)
  }

  override fun onNewToken(token: String) {
    PushHandler.registerToken(this, token)
  }
}
