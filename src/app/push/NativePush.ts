import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

/**
 * `TSPush`, the app's own notifications module (Android:
 * `push/PushModule.kt`). Codegen contract; callers look it up inside their
 * own guard, so a build without it shows no notifications.
 */
export interface Spec extends TurboModule {
  /** `pushState.ts`'s answer, without asking. */
  permissionState: () => Promise<string>
  /** Asks once (POST_NOTIFICATIONS from Android 13), then answers as above. */
  requestPermission: () => Promise<string>
  /** This phone's push address, or null where it has none (no Firebase). */
  token: () => Promise<string | null>
  /** `production` or `development`: which APNs a token belongs to. */
  environment: () => Promise<string>
  /**
   * At sign-out: lets go of this phone's token (Android deletes it from FCM,
   * an iPhone unregisters from APNs).
   */
  unregister: () => Promise<void>
  /**
   * Who the app keeps as signed in (`sessionStore`'s user), or null for
   * nobody: what the phone posts on its own (a reminder, a DM it could not
   * open in time) is shown only when it is for them, and an iPhone's
   * notification extension opens only their wakes.
   */
  setUser: (userId: string | null) => void
  /**
   * Posts a notification, one per `tag`, on `channel` (`messages`, `events`),
   * keeping `seq`, the chat message it is for (0 for none), so a read of an
   * earlier message leaves it up.
   */
  show: (
    title: string,
    body: string,
    url: string,
    tag: string,
    channel: string,
    seq: number
  ) => void
  /** Takes down every notification posted or delivered with `tag`. */
  clear: (tag: string) => void
  /**
   * The conversation on screen with the app in the foreground, or null: a
   * wake for it shows nothing, since the person is reading it.
   */
  setActiveConversation: (conversationId: string | null) => void
  /**
   * Opens this app's notification settings, where a person who refused them
   * at the system's question can allow them (Android: the app's notification
   * settings; an iPhone: the app's page in Settings). Answers whether it
   * could.
   */
  openSettings: () => Promise<boolean>
}
export default TurboModuleRegistry.get<Spec>('TSPush')
