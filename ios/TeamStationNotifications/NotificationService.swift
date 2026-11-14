import Foundation
import UserNotifications

/**
 * The Notification Service Extension: iOS hands it every alert the server
 * marks `mutable-content` before showing it, which for TeamStation is a chat
 * wake (`server/push/chatWakes.ts`). It opens the wake with this phone's own
 * keys (`ChatWakeDecryptor.swift`) and shows the message in place of the
 * server's content-free body, or hides it.
 *
 * Hiding needs Apple's filtering entitlement
 * (`TeamStationNotifications.filtering.entitlements`); without it iOS shows
 * the server's body instead, which is why the server sends a group wake as an
 * alert only when `push.iosFiltering` is on. Anything that is not a wake, and
 * a DM that runs out of time, is shown as it came; a group wake that runs out
 * of time is hidden, as one that cannot be opened is.
 *
 * The app compiles it too, only so `ChatWakeDecryptorTests` can hand it a
 * request: a simulator's `simctl push` shows an alert without running the
 * extension, which only a delivery through APNs does.
 */
final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var handler: ((UNNotificationContent) -> Void)?
  private var original: UNNotificationContent?
  private var work: Task<Void, Never>?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    PushCoverage.start()
    lock.withLock {
      handler = contentHandler
      original = request.content
    }
    work = Task { [weak self] in
      let outcome = await ChatWakes.open(request.content.userInfo)
      self?.finish(Self.content(outcome, request.content))
    }
  }

  override func serviceExtensionTimeWillExpire() {
    work?.cancel()
    finish(Self.expired(lock.withLock { original } ?? UNNotificationContent()))
  }

  /// What is shown of `sent` when its wake could not be opened in time.
  static func expired(_ sent: UNNotificationContent) -> UNNotificationContent {
    guard let wake = ChatWake(sent.userInfo), !wake.dm else { return sent }
    return UNNotificationContent()
  }

  /// Hands iOS what to show, once, whichever of the wake and the clock comes first.
  private func finish(_ content: UNNotificationContent) {
    let handler = lock.withLock {
      defer { self.handler = nil }
      return self.handler
    }
    guard let handler else { return }
    handler(content)
    PushCoverage.flush()
  }

  /// What a wake's outcome shows in place of what the server sent.
  static func content(_ outcome: WakeOutcome, _ sent: UNNotificationContent) -> UNNotificationContent {
    switch outcome {
    case .notWake:
      return sent
    case .hide:
      return UNNotificationContent()
    case let .show(shown):
      let content = (sent.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
      content.title = shown.title
      content.body = shown.body
      content.threadIdentifier = shown.tag
      return content
    }
  }
}
