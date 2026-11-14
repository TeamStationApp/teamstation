import Security
import UIKit
import UserNotifications
import XCTest

/// `ChatWakeDecryptor.swift`'s `TSChatWakes`. Reached by name, because this bundle takes no pods
/// and cannot import the app.
@objc private protocol ChatWakesOpening {
  func open(
    _ payload: NSDictionary,
    record: NSString?,
    fetch: @escaping (NSString, @escaping (NSData?, Int) -> Void) -> Void,
    done: @escaping (NSDictionary?) -> Void
  )
  func openStored(_ payload: NSDictionary, done: @escaping (NSDictionary) -> Void)
  func ops() -> NSDictionary
}

/// `Push.swift`'s `TSPushCenter`, as far as the background wakes reach it.
@objc private protocol BackgroundCentering {
  @objc(centerPosting:registered:unregistered:)
  func center(
    posting: @escaping (NSDictionary) -> Void,
    registered: @escaping () -> Void,
    unregistered: @escaping () -> Void
  ) -> AnyObject
  @objc(background:done:)
  func background(_ userInfo: NSDictionary, done: @escaping (UIBackgroundFetchResult) -> Void)
}

/// The API on `wake.example.test`, answered from one vector, as `URLSession.shared` reaches it.
private final class WakeAPI: URLProtocol {
  static let host = "wake.example.test"
  nonisolated(unsafe) static var answer: (URLRequest) -> (Int, Data) = { _ in (404, Data()) }
  nonisolated(unsafe) static var tokens: [String] = []

  override class func canInit(with request: URLRequest) -> Bool { request.url?.host == host }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.tokens.append(request.value(forHTTPHeaderField: "authorization") ?? "")
    let (status, body) = Self.answer(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

/**
 * The extension's port of `openWake`, over the very cases `chatWake.test.ts` opens: real chat
 * crypto with fresh throwaway keys, written by `scripts/pushWakeVectors.ts` to the file named by
 * `TS_WAKE_VECTORS` (`TEST_RUNNER_TS_WAKE_VECTORS` to `xcodebuild test`). `TS_CHAT_OPS` names
 * `src/common/chatCrypto/ops.json`. `scripts/push-coverage.mjs` sets both.
 */
final class ChatWakeDecryptorTests: XCTestCase {
  private var wakes: AnyObject {
    (NSClassFromString("TSChatWakes") as! NSObject.Type).init()
  }

  private func environment(_ name: String) throws -> String {
    guard let value = ProcessInfo.processInfo.environment[name], value != "" else {
      throw XCTSkip("Set \(name) (TEST_RUNNER_\(name) for xcodebuild): see scripts/push-coverage.mjs")
    }
    return value
  }

  private func json(_ path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func cases() throws -> [[String: Any]] {
    let vectors = try json(environment("TS_WAKE_VECTORS"))
    XCTAssertEqual(vectors["version"] as? Int, 1)
    return try XCTUnwrap(vectors["cases"] as? [[String: Any]])
  }

  private func named(_ name: String) throws -> [String: Any] {
    try XCTUnwrap(cases().first { $0["name"] as? String == name })
  }

  private func body(_ value: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed])
  }

  private func recordText(_ item: [String: Any]) -> String? {
    guard let record = item["record"] as? [String: Any] else { return nil }
    return String(decoding: body(record), as: UTF8.self)
  }

  /// What the API answers for `path`, as the case's device would be answered; `calls` records each.
  private func answer(_ item: [String: Any], _ path: String, _ calls: inout [String]) -> (Int, Data) {
    calls.append(path)
    let wake = item["wake"] as! [String: Any]
    let conversation = wake["c"] as! String
    if path.hasPrefix("/chat/identities/") {
      let id = String(path.dropFirst("/chat/identities/".count))
      let identities = item["identities"] as! [[String: Any]]
      guard let identity = identities.first(where: { $0["id"] as? String == id }) else {
        return (404, body(["error": ["code": "notFound"]]))
      }
      return (200, body(identity))
    }
    if path.hasPrefix("/chat/conversations/\(conversation)/epochs?after=") {
      return (200, body(item["epochs"]!))
    }
    if path == "/chat/conversations/\(conversation)/messages?after=\((wake["seq"] as! Int) - 1)&limit=1" {
      let message = item["message"] as? [String: Any]
      return (200, body(message == nil ? [] : [message!]))
    }
    return (404, body(["error": ["code": "notFound"]]))
  }

  /// Opens one case's wake with its record and its API answers, or `fetch`'s.
  private func open(
    _ item: [String: Any],
    record: String?? = .none,
    payload: [String: Any]? = nil,
    fetch: ((String) -> (Int, Data))? = nil
  ) -> (shown: [String: String]?, calls: [String]) {
    var calls: [String] = []
    let lock = NSLock()
    let done = expectation(description: item["name"] as? String ?? "wake")
    var shown: [String: String]?
    wakes.open?(
      (payload ?? item["wake"] as! [String: Any]) as NSDictionary,
      record: (record ?? recordText(item)) as NSString?,
      fetch: { path, reply in
        let (status, data) = lock.withLock {
          fetch?(path as String) ?? self.answer(item, path as String, &calls)
        }
        reply(data as NSData, status)
      },
      done: { answer in
        shown = answer as? [String: String]
        done.fulfill()
      }
    )
    wait(for: [done], timeout: 30)
    return (shown, calls)
  }

  func testEveryCaseShowsWhatTheBrowserAndAndroidShow() throws {
    let all = try cases()
    XCTAssertEqual(all.count, 14)
    for item in all {
      let name = item["name"] as! String
      let (shown, calls) = open(item)
      XCTAssertEqual(shown, item["expected"] as? [String: String], name)
      if item["record"] is NSNull { XCTAssertEqual(calls, [], name) }
    }
  }

  func testAnInlineEnvelopeIsNotFetchedAndAFetchedOneIs() throws {
    let wake = try named("dm")["wake"] as! [String: Any]
    let inline = open(try named("dm")).calls
    XCTAssertFalse(inline.contains { $0.contains("/messages") })
    XCTAssertTrue(inline.contains("/chat/conversations/\(wake["c"]!)/epochs?after=0"))
    let fetched = open(try named("fetched")).calls
    XCTAssertTrue(fetched.contains("/chat/conversations/\(wake["c"]!)/messages?after=6&limit=1"))
  }

  func testTheOpsAreTheCoresOwn() throws {
    let file = try json(environment("TS_CHAT_OPS"))
    let ops = try XCTUnwrap(file["ops"] as? [[String: Any]])
    let numbers = Dictionary(uniqueKeysWithValues: ops.map { ($0["name"] as! String, $0["id"] as! Int) })
    let used = try XCTUnwrap(wakes.ops?() as? [String: Int])
    XCTAssertEqual(used.count, 7)
    for (name, id) in used { XCTAssertEqual(numbers[name], id, name) }
  }

  func testAPushThatIsNoWakeOpensToNothing() throws {
    let item = try named("dm")
    let reminder: [String: Any] = ["t": "event", "u": "usr_x", "title": "Batting cage", "url": "teamstation://games/x"]
    XCTAssertNil(open(item, payload: reminder).shown)
    var wake = item["wake"] as! [String: Any]
    wake["seq"] = "seven"
    XCTAssertNil(open(item, payload: wake).shown)
  }

  /// Every way a DM can fail to open still says who wrote; a group's shows nothing.
  func testADmThatCannotBeOpenedSaysWhoWrote() throws {
    let dm = try named("dm")
    let fallback = try named("dmNoRecord")["expected"] as? [String: String]
    let wake = dm["wake"] as! [String: Any]
    let conversation = wake["c"] as! String
    // An unreadable record, another version, another person's.
    XCTAssertEqual(open(dm, record: .some("{not json")).shown, fallback)
    XCTAssertEqual(open(dm, record: .some(#"{"version":3,"userId":"usr_x"}"#)).shown, fallback)
    var other = dm["record"] as! [String: Any]
    other["userId"] = (try named("dm")["identities"] as! [[String: Any]])[0]["userId"]
    XCTAssertEqual(open(dm, record: .some(String(decoding: body(other), as: UTF8.self))).shown, fallback)
    // The API failing, unreachable, or saying something unreadable.
    for (status, data) in [(500, Data()), (0, Data()), (200, Data("<html>".utf8)), (200, body([1, 2]))] {
      let shown = open(dm, fetch: { path in
        path.contains("/epochs") ? (status, data) : self.answer(dm, path, &self.ignored)
      }).shown
      XCTAssertEqual(shown, fallback, "\(status)")
    }
    // The sender's identity gone, or answering as someone else.
    XCTAssertEqual(open(dm, fetch: { path in
      path.hasPrefix("/chat/identities/") ? (404, Data()) : self.answer(dm, path, &self.ignored)
    }).shown, fallback)
    XCTAssertEqual(open(dm, fetch: { path in
      path.hasPrefix("/chat/identities/") ? (200, self.body(["userId": "usr_x"])) : self.answer(dm, path, &self.ignored)
    }).shown, fallback)
    // A fetched envelope for another message, or none.
    var unfetched = wake
    unfetched.removeValue(forKey: "env")
    XCTAssertEqual(open(dm, payload: unfetched).shown, fallback)
    XCTAssertEqual(open(dm, payload: unfetched, fetch: { path in
      path.contains("/messages") ? (200, self.body([["conversationId": conversation, "seq": 1]])) : self.answer(dm, path, &self.ignored)
    }).shown, fallback)
    // An emptied envelope, and one whose epoch is malformed or not signed.
    var cleared = wake
    var envelope = wake["env"] as! [String: Any]
    envelope["clearedAt"] = "2027-04-10T12:00:00Z"
    cleared["env"] = envelope
    XCTAssertEqual(open(dm, payload: cleared).shown, fallback)
    var epochs = dm["epochs"] as! [String: Any]
    var epoch = (epochs["epochs"] as! [[String: Any]])[0]
    epoch["chainBreak"] = true
    epochs["epochs"] = [epoch]
    XCTAssertEqual(open(dm, fetch: { path in
      path.contains("/epochs") ? (200, self.body(epochs)) : self.answer(dm, path, &self.ignored)
    }).shown, fallback)
    epochs["epochs"] = [["epoch": 1]]
    XCTAssertEqual(open(dm, fetch: { path in
      path.contains("/epochs") ? (200, self.body(epochs)) : self.answer(dm, path, &self.ignored)
    }).shown, fallback)
    // A group message in the same straits shows nothing.
    XCTAssertNil(open(try named("mention"), fetch: { _ in (500, Data()) }).shown)
  }

  private var ignored: [String] = []

  func testALegacyRecordAndNumberedMentionsOpen() throws {
    let mention = try named("mention")
    var record = mention["record"] as! [String: Any]
    // Version 1 named people by number; the reader is gumbo 2 in every case.
    record["version"] = 1
    record["userId"] = 2
    record["pins"] = [:]
    record["previousPins"] = [:]
    record["logs"] = [:]
    let shown = open(mention, record: .some(String(decoding: body(record), as: UTF8.self))).shown
    XCTAssertEqual(shown, mention["expected"] as? [String: String])
    record["puks"] = [["generation": "one"]]
    XCTAssertNil(open(mention, record: .some(String(decoding: body(record), as: UTF8.self))).shown)
  }

  func testABoxThatDoesNotOpenAndAnotherPersonsBoxGiveNoKey() throws {
    let uncached = try named("uncachedEpoch")
    // The core refuses a box that is not one: no key, so the mention shows nothing.
    var epochs = uncached["epochs"] as! [String: Any]
    var box = (epochs["boxes"] as! [[String: Any]])[0]
    box["box"] = String(repeating: "A", count: 86)
    epochs["boxes"] = [box]
    XCTAssertNil(open(uncached, fetch: { path in
      path.contains("/epochs") ? (200, self.body(epochs)) : self.answer(uncached, path, &self.ignored)
    }).shown)
    // A reader whose account id is past the legacy range: its box is sealed
    // to another identity, so it opens to nothing either.
    let wide = "usr_11112LJ7YLqvVc8DmhwT3n"
    var record = uncached["record"] as! [String: Any]
    record["userId"] = wide
    var wake = uncached["wake"] as! [String: Any]
    wake["u"] = wide
    XCTAssertNil(open(uncached, record: .some(String(decoding: body(record), as: UTF8.self)), payload: wake).shown)
    // An id that is not one.
    record["userId"] = "usr_0"
    wake["u"] = "usr_0"
    XCTAssertNil(open(uncached, record: .some(String(decoding: body(record), as: UTF8.self)), payload: wake).shown)
  }

  // MARK: the keychain and the network, as the extension reads them

  private let session = "app.teamstation.session"

  private func item(_ service: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
     kSecAttrSynchronizable as String: kSecAttrSynchronizableAny]
  }

  /// Saves a generic password the way `react-native-keychain` does.
  private func save(_ service: String, account: String, password: String, synchronizable: Bool) {
    SecItemDelete(item(service) as CFDictionary)
    let status = SecItemAdd([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecAttrSynchronizable as String: synchronizable,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
      kSecValueData as String: Data(password.utf8),
    ] as CFDictionary, nil)
    XCTAssertEqual(status, errSecSuccess, service)
  }

  /// The app's own session on this simulator, put back after the test.
  private var kept: (account: String, password: Data)?

  override func setUp() {
    super.setUp()
    var query = item(session)
    query[kSecReturnAttributes as String] = true
    query[kSecReturnData as String] = true
    var found: CFTypeRef?
    if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
       let found = found as? [String: Any], let data = found[kSecValueData as String] as? Data {
      kept = (found[kSecAttrAccount as String] as? String ?? "", data)
    }
    URLProtocol.registerClass(WakeAPI.self)
  }

  override func tearDown() {
    URLProtocol.unregisterClass(WakeAPI.self)
    SecItemDelete(item(session) as CFDictionary)
    if let kept {
      save(session, account: kept.account, password: String(decoding: kept.password, as: UTF8.self), synchronizable: false)
    }
    super.tearDown()
  }

  private func openStored(_ payload: [String: Any]) -> [String: String] {
    let done = expectation(description: "stored")
    var outcome: [String: String] = [:]
    wakes.openStored?(payload as NSDictionary) { answer in
      outcome = answer as? [String: String] ?? [:]
      done.fulfill()
    }
    wait(for: [done], timeout: 30)
    return outcome
  }

  /// The extension's principal class, as compiled into the app.
  private func service() -> UNNotificationServiceExtension {
    (NSClassFromString("TeamStation.NotificationService") as! UNNotificationServiceExtension.Type).init()
  }

  /// What the extension hands iOS for an alert carrying `payload`.
  private func serve(_ payload: [String: Any], expire: Bool = false) -> UNNotificationContent {
    let sent = UNMutableNotificationContent()
    sent.body = "New message"
    sent.userInfo = payload
    let request = UNNotificationRequest(identifier: "wake", content: sent, trigger: nil)
    let done = expectation(description: "content")
    var shown = UNNotificationContent()
    let extensionService = service()
    extensionService.didReceive(request) { content in
      shown = content
      done.fulfill()
    }
    if expire { extensionService.serviceExtensionTimeWillExpire() }
    wait(for: [done], timeout: 30)
    return shown
  }

  func testTheExtensionShowsAMentionHidesAPlainMessageAndPassesAReminder() throws {
    let mention = try named("mention")
    let wake = mention["wake"] as! [String: Any]
    let records = "app.teamstation.chat.\(wake["u"] as! String)"
    defer { SecItemDelete(item(records) as CFDictionary) }
    WakeAPI.answer = { request in
      var path = request.url!.path.replacingOccurrences(of: "/api/v1", with: "")
      if let query = request.url!.query { path += "?\(query)" }
      return self.answer(mention, path, &self.ignored)
    }
    save(session, account: "https://\(WakeAPI.host)/api/v1", password: "session-token", synchronizable: false)
    save(records, account: "chat", password: recordText(mention)!, synchronizable: true)
    let expected = mention["expected"] as! [String: String]
    let shown = serve(wake)
    XCTAssertEqual(shown.title, expected["title"])
    XCTAssertEqual(shown.body, expected["body"])
    XCTAssertEqual(shown.threadIdentifier, expected["tag"])
    XCTAssertEqual(shown.userInfo["url"] as? String, expected["url"])
    // A plain group message comes back empty, which the filtering entitlement hides.
    let hidden = serve(try named("groupPlain")["wake"] as! [String: Any])
    XCTAssertEqual(hidden.title, "")
    XCTAssertEqual(hidden.body, "")
    // A reminder is shown as the server sent it.
    XCTAssertEqual(serve(["t": "event", "url": "teamstation://games/x"]).body, "New message")
    // Out of time (the API slow to answer), a group wake is hidden, once.
    let answering = WakeAPI.answer
    WakeAPI.answer = { request in
      Thread.sleep(forTimeInterval: 2)
      return answering(request)
    }
    let expired = serve(wake, expire: true)
    XCTAssertEqual(expired.title, "")
    XCTAssertEqual(expired.body, "")
    // A DM out of time is shown as it was sent. Without its envelope it is
    // fetched, from the slow API.
    let dm = try named("dm")
    var dmWake = dm["wake"] as! [String: Any]
    dmWake["env"] = nil
    let dmRecords = "app.teamstation.chat.\(dmWake["u"] as! String)"
    defer { SecItemDelete(item(dmRecords) as CFDictionary) }
    save(dmRecords, account: "chat", password: recordText(dm)!, synchronizable: true)
    XCTAssertEqual(serve(dmWake, expire: true).body, "New message")
    Thread.sleep(forTimeInterval: 3)
  }

  /// The app delegate's background handler, as iOS calls it for a background push.
  private func background(_ payload: [String: Any]) -> UIBackgroundFetchResult? {
    let done = expectation(description: "fetched")
    var result: UIBackgroundFetchResult?
    UIApplication.shared.delegate?.application?(
      UIApplication.shared,
      didReceiveRemoteNotification: payload,
      fetchCompletionHandler: { answer in
        result = answer
        done.fulfill()
      }
    )
    wait(for: [done], timeout: 30)
    return result
  }

  /// A simulator's `simctl push` refuses a push with no alert, so the app's handler is called here.
  func testTheAppOpensABackgroundGroupWake() throws {
    let mention = try named("mention")
    let wake = mention["wake"] as! [String: Any]
    let records = "app.teamstation.chat.\(wake["u"] as! String)"
    defer { SecItemDelete(item(records) as CFDictionary) }
    WakeAPI.answer = { request in
      var path = request.url!.path.replacingOccurrences(of: "/api/v1", with: "")
      if let query = request.url!.query { path += "?\(query)" }
      return self.answer(mention, path, &self.ignored)
    }
    save(session, account: "https://\(WakeAPI.host)/api/v1", password: "session-token", synchronizable: false)
    save(records, account: "chat", password: recordText(mention)!, synchronizable: true)
    let quiet: [String: Any] = ["aps": ["content-available": 1]]
    WakeAPI.tokens = []
    // A mention is opened and posted; a plain message is opened and not.
    XCTAssertEqual(background(wake.merging(quiet) { $1 }), .newData)
    XCTAssertFalse(WakeAPI.tokens.isEmpty)
    let plain = try named("groupPlain")["wake"] as! [String: Any]
    XCTAssertEqual(background(plain.merging(quiet) { $1 }), .newData)
    // An alert is the extension's, and a push that is no wake is nothing to open.
    WakeAPI.tokens = []
    XCTAssertEqual(background(wake.merging(["aps": ["alert": ["body": "x"]]]) { $1 }), .noData)
    XCTAssertEqual(background(["t": "event", "aps": ["content-available": 1]]), .noData)
    XCTAssertEqual(WakeAPI.tokens, [])
  }

  /**
   * A mention opened in the background is posted with its wake's `seq`, so a
   * read of an earlier message that arrives after it (iOS delays and
   * reorders these most) leaves it up.
   */
  func testABackgroundMentionKeepsItsSeq() throws {
    let mention = try named("mention")
    let wake = mention["wake"] as! [String: Any]
    let records = "app.teamstation.chat.\(wake["u"] as! String)"
    defer { SecItemDelete(item(records) as CFDictionary) }
    WakeAPI.answer = { request in
      var path = request.url!.path.replacingOccurrences(of: "/api/v1", with: "")
      if let query = request.url!.query { path += "?\(query)" }
      return self.answer(mention, path, &self.ignored)
    }
    save(session, account: "https://\(WakeAPI.host)/api/v1", password: "session-token", synchronizable: false)
    save(records, account: "chat", password: recordText(mention)!, synchronizable: true)
    var posted: [NSDictionary] = []
    let shared = (NSClassFromString("TSPushCenter") as AnyObject)
      .perform(NSSelectorFromString("shared"))!.takeUnretainedValue()
    let center = shared.center!(posting: { posted.append($0) }, registered: {}, unregistered: {})
    let background = { (payload: [String: Any]) -> UIBackgroundFetchResult? in
      let done = self.expectation(description: "fetched")
      var result: UIBackgroundFetchResult?
      center.background?(payload as NSDictionary) { answer in
        result = answer
        done.fulfill()
      }
      self.wait(for: [done], timeout: 30)
      return result
    }
    let quiet: [String: Any] = ["aps": ["content-available": 1]]
    XCTAssertEqual(background(wake.merging(quiet) { $1 }), .newData)
    let expected = mention["expected"] as! [String: String]
    XCTAssertEqual(posted.count, 1)
    XCTAssertEqual(posted.first?["seq"] as? NSNumber, NSNumber(value: wake["seq"] as! Int))
    XCTAssertEqual(posted.first?["tag"] as? String, expected["tag"])
    XCTAssertEqual(posted.first?["url"] as? String, expected["url"])
    // Signed out, the same mention posts nothing.
    SecItemDelete(item(session) as CFDictionary)
    XCTAssertEqual(background(wake.merging(quiet) { $1 }), .newData)
    XCTAssertEqual(posted.count, 1)
  }

  /// Signed out, a DM tells whoever holds the phone nothing, not even who wrote.
  func testASignedOutPhoneShowsNoDm() throws {
    let dm = try named("dm")
    let wake = dm["wake"] as! [String: Any]
    let records = "app.teamstation.chat.\(wake["u"] as! String)"
    defer { SecItemDelete(item(records) as CFDictionary) }
    save(records, account: "chat", password: recordText(dm)!, synchronizable: true)
    SecItemDelete(item(session) as CFDictionary)
    WakeAPI.tokens = []
    XCTAssertEqual(openStored(wake), ["outcome": "hide"])
    var unfetched = wake
    unfetched.removeValue(forKey: "env")
    XCTAssertEqual(openStored(unfetched), ["outcome": "hide"])
    XCTAssertEqual(WakeAPI.tokens, [])
    // The extension empties the alert, which the filtering entitlement hides.
    let shown = serve(wake)
    XCTAssertEqual(shown.title, "")
    XCTAssertEqual(shown.body, "")
  }

  func testTheExtensionOpensAWakeWithTheAppsKeychainAndSession() throws {
    let mention = try named("mention")
    let wake = mention["wake"] as! [String: Any]
    let user = wake["u"] as! String
    let records = "app.teamstation.chat.\(user)"
    defer {
      SecItemDelete(item(records) as CFDictionary)
      SecItemDelete(item("app.teamstation.chat") as CFDictionary)
    }
    WakeAPI.tokens = []
    WakeAPI.answer = { request in
      var path = request.url!.path.replacingOccurrences(of: "/api/v1", with: "")
      if let query = request.url!.query { path += "?\(query)" }
      return self.answer(mention, path, &self.ignored)
    }
    // Signed out: a group wake shows nothing, and nothing is fetched.
    SecItemDelete(item(session) as CFDictionary)
    XCTAssertEqual(openStored(wake), ["outcome": "hide"])
    XCTAssertEqual(WakeAPI.tokens, [])

    save(session, account: "https://\(WakeAPI.host)/api/v1", password: "session-token", synchronizable: false)
    save(records, account: "chat", password: recordText(mention)!, synchronizable: true)
    let expected = mention["expected"] as! [String: String]
    XCTAssertEqual(openStored(wake), expected.merging(["outcome": "show"]) { $1 })
    XCTAssertFalse(WakeAPI.tokens.isEmpty)
    XCTAssertTrue(WakeAPI.tokens.allSatisfy { $0 == "Bearer session-token" })
    // A record left in the one-account slot by an older build is read too.
    SecItemDelete(item(records) as CFDictionary)
    save("app.teamstation.chat", account: "chat", password: recordText(mention)!, synchronizable: false)
    XCTAssertEqual(openStored(wake)["outcome"], "show")
    // Signed in with no record for the person: nothing to open a mention with.
    SecItemDelete(item("app.teamstation.chat") as CFDictionary)
    XCTAssertEqual(openStored(wake), ["outcome": "hide"])
    save(records, account: "chat", password: recordText(mention)!, synchronizable: true)
    // A plain group message hides; a reminder is shown as it came.
    let plain = try named("groupPlain")["wake"] as! [String: Any]
    XCTAssertEqual(openStored(plain), ["outcome": "hide"])
    XCTAssertEqual(openStored(["t": "event", "url": "teamstation://games/x"]), ["outcome": "notWake"])
  }
}
