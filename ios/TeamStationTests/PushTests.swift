import UIKit
import UserNotifications
import XCTest

/// `Push.swift`'s `TSPushCenter`, the `TSPush` module's half in Swift. Reached by name, because
/// this bundle takes no pods and cannot import the app.
@objc private protocol PushCentering {
  func environment() -> String
  func permissionState(_ done: @escaping (String) -> Void)
  func requestPermission(_ done: @escaping (String) -> Void)
  func token(_ done: @escaping (String?) -> Void)
  func received(_ token: Data)
  func failed()
  func registerIfAllowed()
  func show(_ title: String, body: String, url: String, tag: String)
  @objc(show:body:url:tag:seq:)
  func show(_ title: String, body: String, url: String, tag: String, seq: Int64)
  func center(status: Int, granting: Bool, register: @escaping () -> Void, wait: TimeInterval) -> AnyObject
  @objc(centerShowing:removed:)
  func center(showing: [NSDictionary], removed: @escaping ([String]) -> Void) -> AnyObject
  @objc(setActiveConversation:)
  func setActiveConversation(_ conversation: String?)
  @objc(presents:thread:)
  func presents(_ userInfo: NSDictionary, thread: String) -> Bool
  @objc(clear:done:)
  func clear(_ tag: String, done: @escaping () -> Void)
  @objc(clear:upTo:done:)
  func clear(_ tag: String, upTo seq: NSNumber?, done: @escaping () -> Void)
  @objc(cleared:done:)
  func cleared(_ userInfo: NSDictionary, done: @escaping () -> Void) -> Bool
  @objc(centerPosting:registered:unregistered:)
  func center(
    posting: @escaping (NSDictionary) -> Void,
    registered: @escaping () -> Void,
    unregistered: @escaping () -> Void
  ) -> AnyObject
  @objc(unregister:)
  func unregister(_ done: @escaping () -> Void)
  var signedOut: Bool { get }
}

/// `RCTPush`, the module JavaScript calls, as the bridge calls it.
@objc private protocol PushModule {
  func permissionState(_ resolve: @escaping (Any?) -> Void, reject: @escaping (String?, String?, Error?) -> Void)
  func requestPermission(_ resolve: @escaping (Any?) -> Void, reject: @escaping (String?, String?, Error?) -> Void)
  func token(_ resolve: @escaping (Any?) -> Void, reject: @escaping (String?, String?, Error?) -> Void)
  func environment(_ resolve: @escaping (Any?) -> Void, reject: @escaping (String?, String?, Error?) -> Void)
  func show(_ title: String, body: String, url: String, tag: String, channel: String, seq: Double)
  func clear(_ tag: String)
  func setActiveConversation(_ conversationId: String?)
  func unregister(_ resolve: @escaping (Any?) -> Void, reject: @escaping (String?, String?, Error?) -> Void)
}

final class PushTests: XCTestCase {
  private var center: AnyObject { NSClassFromString("TSPushCenter")! }
  private var shared: AnyObject { center.perform(NSSelectorFromString("shared"))!.takeUnretainedValue() }

  private func call<T>(_ selector: String, _ argument: Any?) -> T? {
    center.perform(NSSelectorFromString(selector), with: argument)?.takeUnretainedValue() as? T
  }

  func testTheEnvironmentIsTheBuildsApsEnvironment() {
    let environment: String? = call("environmentOf:", ["TSApsEnvironment": "production"] as NSDictionary)
    XCTAssertEqual(environment, "production")
    XCTAssertEqual(call("environmentOf:", ["TSApsEnvironment": "development"] as NSDictionary), "development")
    // A build that names none, or anything else, is a development build.
    XCTAssertEqual(call("environmentOf:", NSDictionary()), "development")
    XCTAssertEqual(call("environmentOf:", ["TSApsEnvironment": "$(TS_APS_ENVIRONMENT)"] as NSDictionary), "development")
    // This build's own: a simulator build's entitlement is development.
    XCTAssertEqual(shared.environment?(), "development")
    XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "TSApsEnvironment") as? String, "development")
  }

  func testATapOpensThePushsUrl() {
    let chat: URL? = call("urlOf:", ["url": "teamstation://chat/cnv_one", "t": "chat"] as NSDictionary)
    XCTAssertEqual(chat, URL(string: "teamstation://chat/cnv_one"))
    XCTAssertEqual(
      call("urlOf:", ["url": "teamstation://games/tev_one", "aps": ["alert": "x"]] as NSDictionary),
      URL(string: "teamstation://games/tev_one")
    )
    // Only the app's own links, and only a push that names one.
    let web: URL? = call("urlOf:", ["url": "https://example.com/chat/cnv_one"] as NSDictionary)
    XCTAssertNil(web)
    let none: URL? = call("urlOf:", ["aps": ["alert": "x"]] as NSDictionary)
    XCTAssertNil(none)
    let number: URL? = call("urlOf:", ["url": 7] as NSDictionary)
    XCTAssertNil(number)
  }

  func testAuthorizationIsTheStatesPushStateKnows() {
    typealias State = @convention(c) (AnyObject, Selector, Int) -> Unmanaged<NSString>
    let selector = NSSelectorFromString("stateOf:")
    let meta: AnyClass = object_getClass(center)!
    let state = unsafeBitCast(class_getMethodImplementation(meta, selector), to: State.self)
    let of = { (status: Int) in state(self.center, selector, status).takeUnretainedValue() as String }
    XCTAssertEqual(of(UNAuthorizationStatus.authorized.rawValue), "granted")
    XCTAssertEqual(of(UNAuthorizationStatus.provisional.rawValue), "granted")
    XCTAssertEqual(of(UNAuthorizationStatus.ephemeral.rawValue), "granted")
    XCTAssertEqual(of(UNAuthorizationStatus.denied.rawValue), "denied")
    XCTAssertEqual(of(UNAuthorizationStatus.notDetermined.rawValue), "prompt")
    XCTAssertEqual(of(99), "unsupported")
  }

  /// The app delegate hands APNs's answers to the shared center, which tells whoever waits.
  func testTheAppDelegatePassesOnRegistration() {
    let delegate = UIApplication.shared.delegate
    delegate?.application?(UIApplication.shared, didRegisterForRemoteNotificationsWithDeviceToken: Data([0xab]))
    let known = expectation(description: "known")
    shared.token? { token in
      XCTAssertEqual(token, "ab")
      known.fulfill()
    }
    wait(for: [known], timeout: 10)
    delegate?.application?(
      UIApplication.shared,
      didFailToRegisterForRemoteNotificationsWithError: NSError(domain: "APNs", code: 3000)
    )
  }

  func testATokenIsLowercaseHex() {
    let hex: String? = call("hexOf:", Data([0x00, 0x0f, 0xab, 0xff]) as NSData)
    XCTAssertEqual(hex, "000fabff")
  }

  /// A center of its own, which starts in `status` and is answered `granting` when it asks.
  private func center(
    _ status: UNAuthorizationStatus,
    granting: Bool,
    wait: TimeInterval = 0.2,
    register: @escaping () -> Void = {}
  ) -> AnyObject {
    shared.center!(status: status.rawValue, granting: granting, register: register, wait: wait)
  }

  private func answer(_ ask: (@escaping (String) -> Void) -> Void) -> String {
    let answered = expectation(description: "answer")
    var state = ""
    ask { answer in
      state = answer
      answered.fulfill()
    }
    wait(for: [answered], timeout: 10)
    return state
  }

  func testThePermissionIsAskedOnceThenAnsweredAsItStands() {
    var registered = 0
    let allowing = center(.notDetermined, granting: true) { registered += 1 }
    XCTAssertEqual(answer { allowing.permissionState?($0) }, "prompt")
    XCTAssertEqual(answer { allowing.requestPermission?($0) }, "granted")
    XCTAssertEqual(registered, 1)
    // Asked once: after that it answers without asking or registering again.
    XCTAssertEqual(answer { allowing.requestPermission?($0) }, "granted")
    XCTAssertEqual(registered, 1)
    allowing.registerIfAllowed?()
    XCTAssertEqual(answer { allowing.permissionState?($0) }, "granted")

    let refusing = center(.notDetermined, granting: false) { registered += 1 }
    XCTAssertEqual(answer { refusing.requestPermission?($0) }, "denied")
    XCTAssertEqual(answer { refusing.requestPermission?($0) }, "denied")
    refusing.registerIfAllowed?()
    XCTAssertEqual(registered, 2)
  }

  func testAnAllowedPhoneWithNoTokenAnswersNilInTime() {
    let registering = expectation(description: "registers")
    let allowed = center(.authorized, granting: true, wait: 0.3) { registering.fulfill() }
    let answered = expectation(description: "token")
    allowed.token? { token in
      XCTAssertNil(token)
      answered.fulfill()
    }
    // A second caller waits for the same registration.
    let second = expectation(description: "second")
    allowed.token? { token in
      XCTAssertNil(token)
      second.fulfill()
    }
    wait(for: [registering, answered, second], timeout: 10)
    let refused = center(.denied, granting: false)
    let none = expectation(description: "refused")
    refused.token? { token in
      XCTAssertNil(token)
      none.fulfill()
    }
    wait(for: [none], timeout: 10)
  }

  func testAnEarlierAttemptsTimerLeavesALaterOneWaiting() {
    var registrations = 0
    var allowed: AnyObject!
    allowed = center(.authorized, granting: true, wait: 1) {
      registrations += 1
      // The first registration fails at once, as `didFailToRegister` says.
      if registrations == 1 { allowed.failed?() }
    }
    let first = expectation(description: "first")
    allowed.token? { token in
      XCTAssertNil(token)
      first.fulfill()
    }
    wait(for: [first], timeout: 10)
    // A second attempt, begun before the first one's timer runs out (1 s)
    // and still waiting when it does, with its own timer later (1.6 s).
    let begun = expectation(description: "a moment later")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { begun.fulfill() }
    wait(for: [begun], timeout: 10)
    let second = expectation(description: "second")
    var answered: String?? = .none
    allowed.token? { token in
      answered = .some(token)
      second.fulfill()
    }
    let timerPassed = expectation(description: "first timer passed")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { timerPassed.fulfill() }
    wait(for: [timerPassed], timeout: 10)
    XCTAssertNil(answered, "the first attempt's timer answered the second")
    allowed.received?(Data([0xab, 0xcd]))
    wait(for: [second], timeout: 10)
    XCTAssertEqual(answered, .some("abcd"))
  }

  func testTheTokenIsAnsweredOnceRegistered() {
    // A center of its own: the app's shared one may hold a token already.
    let center = (NSClassFromString("TSPushCenter") as! NSObject.Type).init()
    let answered = expectation(description: "token")
    (center as AnyObject).token? { token in
      // Registered, or not allowed in this test host and answered at once.
      XCTAssertTrue(token == nil || token == "c0ffee", String(describing: token))
      answered.fulfill()
    }
    (center as AnyObject).received?(Data([0xc0, 0xff, 0xee]))
    wait(for: [answered], timeout: 30)
    // Known from then on, without asking again.
    let again = expectation(description: "again")
    (center as AnyObject).token? { token in
      XCTAssertEqual(token, "c0ffee")
      again.fulfill()
    }
    wait(for: [again], timeout: 5)
    (center as AnyObject).failed?()
  }

  func testThePermissionAndTheModuleAnswerAsThingsStand() {
    let state = expectation(description: "state")
    var first = ""
    shared.permissionState? { answer in
      first = answer
      state.fulfill()
    }
    wait(for: [state], timeout: 10)
    XCTAssertTrue(["granted", "denied", "prompt"].contains(first), first)
    shared.registerIfAllowed?()

    let module = (NSClassFromString("RCTPush") as! NSObject.Type).init()
    let reject: (String?, String?, Error?) -> Void = { _, _, error in XCTFail("rejected: \(String(describing: error))") }
    let read = expectation(description: "module state")
    (module as AnyObject).permissionState?({ answer in
      XCTAssertEqual(answer as? String, first)
      read.fulfill()
    }, reject: reject)
    let environment = expectation(description: "module environment")
    (module as AnyObject).environment?({ answer in
      XCTAssertEqual(answer as? String, "development")
      environment.fulfill()
    }, reject: reject)
    wait(for: [read, environment], timeout: 10)
    // Asked before, the module answers without asking again; never asked, a
    // test host cannot answer the prompt, so it is not asked here.
    if first != "prompt" {
      let asked = expectation(description: "module request")
      (module as AnyObject).requestPermission?({ answer in
        XCTAssertEqual(answer as? String, first)
        asked.fulfill()
      }, reject: reject)
      wait(for: [asked], timeout: 10)
    }
    let token = expectation(description: "module token")
    (module as AnyObject).token?({ _ in token.fulfill() }, reject: reject)
    shared.received?(Data([0x01]))
    wait(for: [token], timeout: 30)
  }

  func testSignOutLetsGoOfTheTokenUntilASignedInAppAsksAgain() {
    var registered = 0
    var unregistered = 0
    var posted: [NSDictionary] = []
    let center = shared.center!(
      posting: { posted.append($0) },
      registered: { registered += 1 },
      unregistered: { unregistered += 1 }
    )
    XCTAssertEqual(center.signedOut, false)
    let released = expectation(description: "unregistered")
    center.unregister?({ released.fulfill() })
    wait(for: [released], timeout: 5)
    XCTAssertEqual(unregistered, 1)
    XCTAssertEqual(center.signedOut, true)
    // At launch, signed out, the phone does not register again.
    center.registerIfAllowed?()
    let settled = expectation(description: "settled")
    DispatchQueue.main.async { settled.fulfill() }
    wait(for: [settled], timeout: 5)
    XCTAssertEqual(registered, 0)
    // Signed in, the app asks for a token, which registers it again.
    let token = expectation(description: "token")
    center.token? { _ in token.fulfill() }
    wait(for: [token], timeout: 5)
    XCTAssertEqual(center.signedOut, false)
    XCTAssertEqual(registered, 1)
    center.registerIfAllowed?()
    let again = expectation(description: "again")
    DispatchQueue.main.async { again.fulfill() }
    wait(for: [again], timeout: 5)
    XCTAssertEqual(registered, 2)
    // What it posts keeps its message's seq.
    center.show?("Clayton K", body: "Hi", url: "teamstation://chat/cnv_seq", tag: "chat:cnv_seq", seq: 12)
    XCTAssertEqual(posted.first?["seq"] as? NSNumber, 12)
    // The module JavaScript calls, on the app's own center, answers.
    let module = (NSClassFromString("RCTPush") as! NSObject.Type).init() as AnyObject
    let resolved = expectation(description: "module")
    module.unregister?({ _ in resolved.fulfill() }, reject: { _, _, _ in XCTFail("rejected") })
    wait(for: [resolved], timeout: 5)
    let shared = self.shared
    XCTAssertEqual(shared.signedOut, true)
    let restored = expectation(description: "restored")
    shared.token? { _ in restored.fulfill() }
    wait(for: [restored], timeout: 30)
    XCTAssertEqual(shared.signedOut, false)
  }

  func testShowPostsOneNotificationPerTag() {
    let module = (NSClassFromString("RCTPush") as! NSObject.Type).init()
    let tag = "chat:cnv_pushTests"
    (module as AnyObject).show?("Clayton K", body: "First", url: "teamstation://chat/cnv_pushTests", tag: tag, channel: "messages", seq: 3)
    shared.show?("Clayton K", body: "Second", url: "teamstation://chat/cnv_pushTests", tag: tag)
    shared.show?("Clayton K", body: "Third", url: "teamstation://chat/cnv_pushTests", tag: tag, seq: 4)
    let pending = expectation(description: "posted")
    UNUserNotificationCenter.current().getPendingNotificationRequests { _ in pending.fulfill() }
    wait(for: [pending], timeout: 10)
    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [tag])
  }

  /// A notification as iOS hands one to `willPresent`: there is no public way to make one.
  private func notification(_ userInfo: [AnyHashable: Any], thread: String = "") -> UNNotification {
    let content = UNMutableNotificationContent()
    content.userInfo = userInfo
    content.threadIdentifier = thread
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    return UNNotification.perform(NSSelectorFromString("notificationWithRequest:date:"), with: request, with: Date())!
      .takeUnretainedValue() as! UNNotification
  }

  /// What the app delegate's `willPresent` answers for `note`.
  private func presented(_ note: UNNotification) -> UNNotificationPresentationOptions {
    let delegate = UIApplication.shared.delegate as! UNUserNotificationCenterDelegate
    var shown: UNNotificationPresentationOptions = []
    let answered = expectation(description: "presented")
    delegate.userNotificationCenter?(.current(), willPresent: note) { options in
      shown = options
      answered.fulfill()
    }
    wait(for: [answered], timeout: 5)
    return shown
  }

  func testNothingIsPresentedForTheConversationOnScreen() {
    let module = (NSClassFromString("RCTPush") as! NSObject.Type).init()
    let wake: [AnyHashable: Any] = ["t": "chat", "c": "cnv_on", "url": "teamstation://chat/cnv_on"]
    (module as AnyObject).setActiveConversation?("cnv_on")
    defer { shared.setActiveConversation?(nil) }
    // A wake for it, by the server's thread, the extension's, the app's own tag, or its `c`.
    XCTAssertEqual(presented(notification(wake, thread: "chat:cnv_on")), [])
    XCTAssertEqual(presented(notification(["tag": "chat:cnv_on"])), [])
    XCTAssertEqual(presented(notification(wake)), [])
    // Another conversation, and a reminder, are shown.
    XCTAssertEqual(presented(notification(["t": "chat", "c": "cnv_off"], thread: "chat:cnv_off")), [.banner, .list, .sound])
    XCTAssertEqual(presented(notification(["tag": "event:tev_one"], thread: "event:tev_one")), [.banner, .list, .sound])
    XCTAssertEqual(presented(notification([:])), [.banner, .list, .sound])
    // Once nothing is on screen, it is shown too.
    shared.setActiveConversation?(nil)
    XCTAssertEqual(presented(notification(wake, thread: "chat:cnv_on")), [.banner, .list, .sound])
  }

  func testAReadRemovesItsConversationsDeliveredNotifications() {
    var removed: [[String]] = []
    let showing: [NSDictionary] = [
      ["id": "apns-1", "thread": "chat:cnv_read", "userInfo": ["t": "chat", "c": "cnv_read"]],
      ["id": "chat:cnv_read", "thread": "chat:cnv_read", "userInfo": ["tag": "chat:cnv_read"]],
      ["id": "apns-2", "thread": "", "userInfo": ["t": "chat", "c": "cnv_read"]],
      ["id": "apns-3", "thread": "chat:cnv_other", "userInfo": ["t": "chat", "c": "cnv_other"]],
      ["id": "event:tev_one", "thread": "event:tev_one", "userInfo": ["tag": "event:tev_one"]],
      ["thread": "chat:cnv_read"],
    ]
    let center = shared.center!(showing: showing) { removed.append($0) }
    let done = expectation(description: "cleared")
    XCTAssertEqual(
      center.cleared?(["t": "read", "u": "usr_one", "c": "cnv_read", "seq": 4], done: { done.fulfill() }),
      true
    )
    wait(for: [done], timeout: 5)
    XCTAssertEqual(removed, [["apns-1", "chat:cnv_read", "apns-2"]])
    // Gone already: a second read removes nothing.
    let again = expectation(description: "again")
    center.clear?("chat:cnv_read") { again.fulfill() }
    wait(for: [again], timeout: 5)
    XCTAssertEqual(removed.count, 1)
    // Anything but a read is left to the wake's own handling.
    XCTAssertEqual(center.cleared?(["t": "chat", "c": "cnv_read"], done: { XCTFail("not a read") }), false)
    XCTAssertEqual(center.cleared?(["t": "read"], done: { XCTFail("no conversation") }), false)
  }

  func testAReadTakesDownOnlyWhatWasAtOrBeforeIt() {
    var removed: [[String]] = []
    // A wake's alert keeps its `seq` in `userInfo`, as APNs delivered it, and
    // one the app posted keeps the one it was shown with.
    let showing: [NSDictionary] = [
      ["id": "apns-11", "thread": "chat:cnv_seq", "userInfo": ["t": "chat", "c": "cnv_seq", "seq": 11]],
      ["id": "apns-12", "thread": "chat:cnv_seq", "userInfo": ["t": "chat", "c": "cnv_seq", "seq": 12]],
      ["id": "chat:cnv_seq", "thread": "chat:cnv_seq", "userInfo": ["tag": "chat:cnv_seq", "seq": 13]],
      ["id": "apns-old", "thread": "chat:cnv_seq", "userInfo": ["t": "chat", "c": "cnv_seq"]],
    ]
    let center = shared.center!(showing: showing) { removed.append($0) }
    // A read of 11, held back behind the alert for 12: 12 and 13 stay.
    let first = expectation(description: "read to 11")
    XCTAssertEqual(
      center.cleared?(["t": "read", "u": "usr_one", "c": "cnv_seq", "seq": 11], done: { first.fulfill() }),
      true
    )
    wait(for: [first], timeout: 5)
    XCTAssertEqual(removed, [["apns-11", "apns-old"]])
    let second = expectation(description: "read to 13")
    center.clear?("chat:cnv_seq", upTo: 13) { second.fulfill() }
    wait(for: [second], timeout: 5)
    XCTAssertEqual(removed, [["apns-11", "apns-old"], ["apns-12", "chat:cnv_seq"]])
  }

  func testTheAppDelegateClearsOnABackgroundRead() {
    let delegate = UIApplication.shared.delegate!
    let module = (NSClassFromString("RCTPush") as! NSObject.Type).init()
    // The module's clear and the delegate's, on the app's own center.
    (module as AnyObject).clear?("chat:cnv_none")
    let fetched = expectation(description: "fetched")
    delegate.application?(
      UIApplication.shared,
      didReceiveRemoteNotification: ["aps": ["content-available": 1], "t": "read", "u": "usr_one", "c": "cnv_none", "seq": 1],
      fetchCompletionHandler: { result in
        XCTAssertEqual(result, .newData)
        fetched.fulfill()
      }
    )
    wait(for: [fetched], timeout: 10)
  }
}
