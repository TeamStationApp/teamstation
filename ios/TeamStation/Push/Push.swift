import UIKit
import UserNotifications

/**
 * The app's notifications: the permission, the APNs token, the notifications
 * the app posts itself and those a read takes down, and the conversation on
 * screen, for which nothing is shown. `RCTPush.mm` is the `TSPush` module
 * over it (`src/app/push/NativePush.ts`); `AppDelegate` hands it the token
 * and the pushes.
 */
@objc(TSPushCenter)
final class PushCenter: NSObject {
  @objc static let shared = PushCenter()

  private let lock = NSLock()
  private var token: String?
  private var registering = false
  /// Which registration is under way, so a timer answers only its own.
  private var attempt = 0
  private var waiting: [(String?) -> Void] = []
  private let center: UNUserNotificationCenter
  /// The authorization status, as `getNotificationSettings` answers it.
  private let status: (@escaping (UNAuthorizationStatus) -> Void) -> Void
  /// The system's question, answered with whether it was allowed.
  private let authorize: (@escaping (Bool) -> Void) -> Void
  private let register: () -> Void
  private let wait: TimeInterval
  /// The notifications on show: each one's identifier, thread and `userInfo`.
  private let delivered: (@escaping ([NSDictionary]) -> Void) -> Void
  /// Takes down the notifications with these identifiers.
  private let remove: ([String]) -> Void
  /// The conversation on screen in the foreground, as JavaScript says.
  private var active: String?
  /// Posts a notification.
  private let post: (UNNotificationRequest) -> Void
  /// Lets go of the APNs token.
  private let unregisterRemote: () -> Void
  /// Where a sign-out (`unregister`) is kept until the next `token`.
  private let defaults: UserDefaults

  /// The app's own: the system's notification center and APNs.
  override init() {
    let center = UNUserNotificationCenter.current()
    self.center = center
    status = { done in center.getNotificationSettings { done($0.authorizationStatus) } }
    authorize = { done in
      center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in done(granted) }
    }
    register = {
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    }
    wait = 15
    delivered = { done in
      center.getDeliveredNotifications { notes in
        done(notes.map { note in
          [
            "id": note.request.identifier,
            "thread": note.request.content.threadIdentifier,
            "userInfo": note.request.content.userInfo,
          ] as NSDictionary
        })
      }
    }
    remove = { center.removeDeliveredNotifications(withIdentifiers: $0) }
    post = { center.add($0) }
    unregisterRemote = {
      DispatchQueue.main.async { UIApplication.shared.unregisterForRemoteNotifications() }
    }
    defaults = .standard
  }

  /**
   * A center that starts in `status` and is answered `granting` when it
   * asks, registering through `register`, for `PushTests`: a test host
   * cannot answer the system's question.
   */
  @objc(centerWithStatus:granting:register:wait:)
  func center(
    status: Int,
    granting: Bool,
    register: @escaping () -> Void,
    wait: TimeInterval
  ) -> PushCenter {
    PushCenter(status: status, granting: granting, register: register, wait: wait)
  }

  private init(status: Int, granting: Bool, register: @escaping () -> Void, wait: TimeInterval) {
    let lock = NSLock()
    var current = UNAuthorizationStatus(rawValue: status) ?? .notDetermined
    center = .current()
    self.status = { done in done(lock.withLock { current }) }
    authorize = { done in
      lock.withLock { current = granting ? .authorized : .denied }
      done(granting)
    }
    self.register = register
    self.wait = wait
    delivered = { $0([]) }
    remove = { _ in }
    post = { _ in }
    unregisterRemote = {}
    defaults = UserDefaults(suiteName: "TSPushTests") ?? .standard
  }

  /**
   * A center showing `shown` (each `id`, `thread` and `userInfo`), whose
   * removals `removed` hears, for `PushTests`: a test host's own
   * notification center shows nothing it could check.
   */
  @objc(centerShowing:removed:)
  func center(showing shown: [NSDictionary], removed: @escaping ([String]) -> Void) -> PushCenter {
    PushCenter(shown: shown, removed: removed)
  }

  private init(shown: [NSDictionary], removed: @escaping ([String]) -> Void) {
    let lock = NSLock()
    var showing = shown
    center = .current()
    status = { $0(.authorized) }
    authorize = { $0(true) }
    register = {}
    wait = 0
    delivered = { done in done(lock.withLock { showing }) }
    remove = { ids in
      lock.withLock { showing.removeAll { ids.contains($0["id"] as? String ?? "") } }
      removed(ids)
    }
    post = { _ in }
    unregisterRemote = {}
    defaults = UserDefaults(suiteName: "TSPushTests") ?? .standard
  }

  /**
   * An allowed center whose posts `posted` hears (each one's `userInfo`),
   * whose registering for APNs `registered` and letting go `unregistered`
   * hear, for `PushTests` and `ChatWakeDecryptorTests`.
   */
  @objc(centerPosting:registered:unregistered:)
  func center(
    posting posted: @escaping (NSDictionary) -> Void,
    registered: @escaping () -> Void,
    unregistered: @escaping () -> Void
  ) -> PushCenter {
    PushCenter(posted: posted, registered: registered, unregistered: unregistered)
  }

  private init(
    posted: @escaping (NSDictionary) -> Void,
    registered: @escaping () -> Void,
    unregistered: @escaping () -> Void
  ) {
    center = .current()
    status = { $0(.authorized) }
    authorize = { $0(true) }
    register = registered
    wait = 0
    delivered = { $0([]) }
    remove = { _ in }
    post = { posted($0.content.userInfo as NSDictionary) }
    unregisterRemote = unregistered
    let defaults = UserDefaults(suiteName: "TSPushTests") ?? .standard
    defaults.removeObject(forKey: Self.signedOutKey)
    self.defaults = defaults
  }

  /// Which APNs this build's tokens are for: its `TSApsEnvironment`, `development` unless `production`.
  @objc(environmentOf:)
  static func environment(of info: NSDictionary?) -> String {
    info?["TSApsEnvironment"] as? String == "production" ? "production" : "development"
  }

  @objc func environment() -> String {
    Self.environment(of: Bundle.main.infoDictionary as NSDictionary?)
  }

  /// The address a notification opens: its `url`, which every TeamStation push carries.
  @objc(urlOf:)
  static func url(of userInfo: NSDictionary) -> URL? {
    guard let text = userInfo["url"] as? String, let url = URL(string: text),
          url.scheme == "teamstation"
    else { return nil }
    return url
  }

  /// `pushState.ts`'s answer for an authorization status.
  @objc(stateOf:)
  static func state(of status: Int) -> String {
    switch UNAuthorizationStatus(rawValue: status) {
    case .authorized, .provisional, .ephemeral: return "granted"
    case .denied: return "denied"
    case .notDetermined: return "prompt"
    default: return "unsupported"
    }
  }

  /// A token as APNs addresses it: lowercase hex.
  @objc(hexOf:)
  static func hex(of token: Data) -> String {
    token.map { String(format: "%02x", $0) }.joined()
  }

  @objc(permissionState:)
  func permissionState(_ done: @escaping (String) -> Void) {
    status { done(Self.state(of: $0.rawValue)) }
  }

  /// Asks once, the first time; after that answers as things stand, as Android does.
  @objc(requestPermission:)
  func requestPermission(_ done: @escaping (String) -> Void) {
    status { current in
      guard current == .notDetermined else { return done(Self.state(of: current.rawValue)) }
      self.authorize { granted in
        if granted { self.register() }
        self.permissionState(done)
      }
    }
  }

  /// Registers for pushes when they are allowed, as the app starts, unless it signed out since it last did.
  @objc func registerIfAllowed() {
    if signedOut { return }
    permissionState { state in
      if state == "granted" { self.register() }
    }
  }

  private static let signedOutKey = "app.teamstation.push.signedOut"

  /// Whether the app signed out (`unregister`) and has not asked for a token since.
  @objc var signedOut: Bool { defaults.bool(forKey: Self.signedOutKey) }

  /**
   * At sign-out: lets go of the APNs token, so whatever the server still
   * holds for it reaches nothing, and registers no more at launch until a
   * signed-in app asks for a token again.
   */
  @objc(unregister:)
  func unregister(_ done: @escaping () -> Void) {
    defaults.set(true, forKey: Self.signedOutKey)
    lock.withLock { token = nil }
    unregisterRemote()
    done()
  }

  /// This phone's APNs token, or nil when it has none: not allowed, or registration failed or took too long.
  /// Asked for by a signed-in app, which ends a sign-out's quiet.
  @objc(token:)
  func token(_ done: @escaping (String?) -> Void) {
    defaults.removeObject(forKey: Self.signedOutKey)
    lock.lock()
    if let token {
      lock.unlock()
      return done(token)
    }
    waiting.append(done)
    let first = !registering
    registering = true
    if first { attempt += 1 }
    let mine = attempt
    lock.unlock()
    guard first else { return }
    permissionState { state in
      guard state == "granted" else { return self.answer(nil, attempt: mine) }
      self.register()
      DispatchQueue.global().asyncAfter(deadline: .now() + self.wait) { self.answer(nil, attempt: mine) }
    }
  }

  @objc(received:)
  func received(_ token: Data) {
    let hex = Self.hex(of: token)
    lock.withLock { self.token = hex }
    answer(hex)
  }

  @objc func failed() {
    answer(nil)
  }

  /// Answers the registration under way; with `attempt`, only if it is still that one.
  private func answer(_ token: String?, attempt: Int? = nil) {
    let waiting = lock.withLock {
      if let attempt, attempt != self.attempt || !registering { return [(String?) -> Void]() }
      defer {
        self.waiting = []
        registering = false
      }
      return self.waiting
    }
    for done in waiting { done(token) }
  }

  /**
   * The tag a notification was shown with: the one the app posted it with,
   * or its thread (the server's `thread-id`, or the extension's), or a
   * chat wake's conversation.
   */
  @objc(tagOf:thread:)
  static func tag(of userInfo: NSDictionary, thread: String) -> String? {
    if let tag = userInfo["tag"] as? String { return tag }
    if !thread.isEmpty { return thread }
    if userInfo["t"] as? String == "chat", let conversation = userInfo["c"] as? String {
      return "chat:\(conversation)"
    }
    return nil
  }

  /// Whether a notification tagged `tag` is for the conversation `active`, on screen.
  @objc(isOnScreen:active:)
  static func isOnScreen(_ tag: String?, active: String?) -> Bool {
    guard let tag, let active else { return false }
    return tag == "chat:\(active)"
  }

  /// Says which conversation is on screen in the foreground, or that none is.
  @objc(setActiveConversation:)
  func setActiveConversation(_ conversation: String?) {
    lock.withLock { active = conversation }
  }

  /// Whether a notification arriving in the foreground is shown: not for the conversation on screen.
  @objc(presents:thread:)
  func presents(_ userInfo: NSDictionary, thread: String) -> Bool {
    !Self.isOnScreen(Self.tag(of: userInfo, thread: thread), active: lock.withLock { active })
  }

  /**
   * Whether a read up to `seq` takes down a notification with `userInfo`: one
   * for a chat message at or before it (the wake's `seq`, or the one the app
   * posted it with), or one that keeps none. A read that arrives late,
   * behind the alert for a later message, leaves that one up.
   */
  @objc(clears:upTo:)
  static func clears(_ userInfo: NSDictionary, upTo seq: NSNumber?) -> Bool {
    guard let seq, let shown = userInfo["seq"] as? NSNumber else { return true }
    return shown.int64Value <= seq.int64Value
  }

  /// Takes down every notification on show tagged `tag`, then calls `done`.
  @objc(clear:done:)
  func clear(_ tag: String, done: @escaping () -> Void) {
    clear(tag, upTo: nil, done: done)
  }

  /**
   * Takes down every notification on show tagged `tag` that a read up to
   * `seq` covers (`clears`), or with no `seq` all of them, then calls `done`.
   */
  @objc(clear:upTo:done:)
  func clear(_ tag: String, upTo seq: NSNumber?, done: @escaping () -> Void) {
    delivered { shown in
      let ids = shown.compactMap { note -> String? in
        let userInfo = note["userInfo"] as? NSDictionary ?? [:]
        guard let id = note["id"] as? String,
              Self.tag(of: userInfo, thread: note["thread"] as? String ?? "") == tag,
              Self.clears(userInfo, upTo: seq)
        else { return nil }
        return id
      }
      if !ids.isEmpty { self.remove(ids) }
      done()
    }
  }

  /**
   * A read (`{ t: "read", c, seq }`, a background push): takes its
   * conversation's notifications down, up to `seq`, then calls `done`.
   * False, and nothing done, for any other push.
   */
  @objc(cleared:done:)
  func cleared(_ userInfo: NSDictionary, done: @escaping () -> Void) -> Bool {
    guard userInfo["t"] as? String == "read", let conversation = userInfo["c"] as? String else { return false }
    clear("chat:\(conversation)", upTo: userInfo["seq"] as? NSNumber, done: done)
    return true
  }

  /// Posts a notification, one per `tag`: a later one with the same tag replaces it.
  @objc(show:body:url:tag:)
  func show(_ title: String, body: String, url: String, tag: String) {
    show(title, body: body, url: url, tag: tag, seq: 0)
  }

  /**
   * A background push (`AppDelegate`): a read takes its conversation's
   * notifications down; a chat wake is opened (`ChatWakes.open`) and posted
   * when it shows, a mention, keeping its `seq`, so a read of an earlier
   * message that arrives late leaves it up. Answers what iOS is told.
   */
  @objc(background:done:)
  func background(_ userInfo: NSDictionary, done: @escaping (UIBackgroundFetchResult) -> Void) {
    if cleared(userInfo, done: { done(.newData) }) { return }
    let payload = userInfo as? [AnyHashable: Any] ?? [:]
    Task {
      let outcome = await ChatWakes.open(payload)
      if case let .show(shown) = outcome {
        self.show(shown.title, body: shown.body, url: shown.url, tag: shown.tag, seq: Int64(shown.seq))
      }
      done(outcome == .notWake ? .noData : .newData)
    }
  }

  /// As `show`, keeping `seq`, the chat message it is for (0 for none), for a read to compare.
  @objc(show:body:url:tag:seq:)
  func show(_ title: String, body: String, url: String, tag: String, seq: Int64) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    content.threadIdentifier = tag
    var userInfo: [String: Any] = ["url": url, "tag": tag]
    if seq > 0 { userInfo["seq"] = NSNumber(value: seq) }
    content.userInfo = userInfo
    post(UNNotificationRequest(identifier: tag, content: content, trigger: nil))
  }
}
