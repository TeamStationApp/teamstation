import Foundation
import Security

/**
 * What a chat wake shows on this iPhone, Signal style: the device opens the
 * message with its own keys and shows a notification only for a DM or a
 * mention of the person the wake is for. A port of `openWake`
 * (`src/app/push/chatWake.ts`), which the browser and Android run, with the
 * same rules and strings, through the chat crypto core's C ABI
 * (`chat_crypto_call`).
 *
 * The Notification Service Extension runs it for an alert, and the app for
 * a background push. Both read the key record and the session the app keeps
 * in their shared keychain group, and never write either.
 */

/**
 * A notification a wake shows: `tag` is `chat:<conversation id>`, one a chat,
 * and `seq` the message it is for, which only a read at it or past it takes
 * down.
 */
struct WakeNotification: Equatable {
  let title: String
  let body: String
  let url: String
  let tag: String
  let seq: Int
}

/// Why a wake did not open; every one ends in the wake's fallback.
enum WakeError: Error {
  case malformed
  case refused(String)
  case status(Int)
}

typealias Bytes = [UInt8]

/// The chat crypto core, through `chat_crypto_call`.
enum ChatCore {
  /// The ops this reads, by name, numbered as in `src/common/chatCrypto/ops.json`.
  static let ops: [String: UInt32] = [
    "verify": 8,
    "hpkeOpen": 11,
    "messageKey": 13,
    "verifyMessage": 15,
    "openWithMessageKey": 16,
    "openPreviousEpochKey": 23,
    "epochSignedBytes": 24,
  ]

  /// One call: each argument length-prefixed, the answer `0 ‖ results` or `1 ‖ reason`.
  static func call(_ name: String, _ args: [Bytes]) throws -> [Bytes] {
    guard let op = ops[name] else { throw WakeError.malformed }
    var input = Bytes()
    for arg in args { input += be32(arg.count) + arg }
    var out: UnsafeMutablePointer<UInt8>?
    var length = 0
    _ = input.withUnsafeBufferPointer { buffer in
      chat_crypto_call(op, buffer.baseAddress, buffer.count, &out, &length)
    }
    guard let out else { throw WakeError.malformed }
    defer { chat_crypto_free(out, length) }
    return try results(Bytes(UnsafeBufferPointer(start: out, count: length)))
  }

  static func results(_ answer: Bytes) throws -> [Bytes] {
    guard let status = answer.first else { throw WakeError.malformed }
    if status == 1 {
      throw WakeError.refused(String(decoding: answer.dropFirst(), as: UTF8.self))
    }
    guard status == 0 else { throw WakeError.malformed }
    var found: [Bytes] = []
    var at = 1
    while at < answer.count {
      guard at + 4 <= answer.count else { throw WakeError.malformed }
      let size = answer[at..<at + 4].reduce(0) { $0 << 8 | Int($1) }
      guard at + 4 + size <= answer.count else { throw WakeError.malformed }
      found.append(Bytes(answer[at + 4..<at + 4 + size]))
      at += 4 + size
    }
    return found
  }

  static func flag(_ name: String, _ args: [Bytes]) throws -> Bool {
    try call(name, args).first == [1]
  }

  static func one(_ name: String, _ args: [Bytes]) throws -> Bytes {
    guard let first = try call(name, args).first else { throw WakeError.malformed }
    return first
  }
}

func be32(_ value: Int) -> Bytes {
  (0..<4).map { UInt8(truncatingIfNeeded: value >> (8 * (3 - $0))) }
}

func u64(_ value: Int) -> Bytes {
  (0..<8).map { UInt8(truncatingIfNeeded: UInt64(value) >> (8 * (7 - $0))) }
}

func utf8(_ text: String) -> Bytes { Bytes(text.utf8) }

/// A string's UTF-8 bytes after their length, 4 bytes big-endian.
func lp(_ text: String) -> Bytes { be32(text.utf8.count) + utf8(text) }

/// base64url, padded or not, as `keyRecord.ts`'s `unb64` reads it.
func unb64(_ text: String) throws -> Bytes {
  var standard = text.replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")
  while standard.count % 4 != 0 { standard += "=" }
  guard let data = Data(base64Encoded: standard) else { throw WakeError.malformed }
  return Bytes(data)
}

/// The account ids of `src/common/userId.ts`: `usr_` and 22 base58 digits, a 128-bit value.
enum UserIds {
  static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")

  /// The value, 16 bytes big-endian.
  static func value(_ id: String) throws -> Bytes {
    guard id.count == 26, id.hasPrefix("usr_") else { throw WakeError.malformed }
    var value = Bytes(repeating: 0, count: 16)
    for digit in id.dropFirst(4) {
      guard var carry = alphabet.firstIndex(of: digit) else { throw WakeError.malformed }
      for index in stride(from: 15, through: 0, by: -1) {
        let next = Int(value[index]) * 58 + carry
        value[index] = UInt8(next & 0xff)
        carry = next >> 8
      }
      guard carry == 0 else { throw WakeError.malformed }
    }
    guard value.contains(where: { $0 != 0 }) else { throw WakeError.malformed }
    return value
  }

  /// `identityBytes`: a legacy id below 2^53 is its 8 bytes, any other `ff` and all 16.
  static func identity(_ id: String) throws -> Bytes {
    let value = try value(id)
    if value[0..<9].allSatisfy({ $0 == 0 }) && value[9] < 0x20 { return Bytes(value[8...]) }
    return [0xff] + value
  }

  /// `userIdOfGumbo`: a legacy number's id.
  static func ofGumbo(_ number: Int) -> String {
    var value = number
    var digits = ""
    while value > 0 {
      digits = String(alphabet[value % 58]) + digits
      value /= 58
    }
    return "usr_" + String(repeating: "1", count: max(0, 22 - digits.count)) + digits
  }
}

/// A push's chat wake (`src/common/push.ts`).
struct ChatWake {
  let user: String
  let conversation: String
  let seq: Int
  let dm: Bool
  let from: String
  let title: String?
  let url: String
  let envelope: [String: Any]?

  /// The wake a push carries beside `aps`, or nil for anything else.
  init?(_ payload: [AnyHashable: Any]) {
    guard payload["t"] as? String == "chat",
          let user = payload["u"] as? String,
          let conversation = payload["c"] as? String,
          let seq = payload["seq"] as? Int,
          let dm = payload["dm"] as? Bool,
          let from = payload["from"] as? String,
          let url = payload["url"] as? String
    else { return nil }
    self.user = user
    self.conversation = conversation
    self.seq = seq
    self.dm = dm
    self.from = from
    self.title = payload["title"] as? String
    self.url = url
    self.envelope = payload["env"] as? [String: Any]
  }
}

/// The parts of a stored key record (`keyRecord.ts`) a wake reads.
struct WakeKeyRecord {
  let userId: String
  let identityId: String?
  /// Per-user key generations' secret keys.
  let puks: [Int: Bytes]
  /// Opened epoch keys: conversation id → epoch → key.
  var epochKeys: [String: [Int: Bytes]]

  /// A record as the stores keep it, version 1 or 2; anything else throws.
  init(json text: String) throws {
    guard let raw = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
          let record = raw as? [String: Any],
          let version = record["version"] as? Int, version == 1 || version == 2
    else { throw WakeError.malformed }
    if version == 1 {
      guard let number = record["userId"] as? Int else { throw WakeError.malformed }
      userId = UserIds.ofGumbo(number)
    } else {
      guard let id = record["userId"] as? String else { throw WakeError.malformed }
      userId = id
    }
    let identity = record["identity"] as? [String: Any]
    identityId = identity?["id"] as? String
    var puks: [Int: Bytes] = [:]
    for puk in record["puks"] as? [[String: Any]] ?? [] {
      guard let generation = puk["generation"] as? Int,
            let keys = puk["keys"] as? [String: Any],
            let secret = keys["secretKey"] as? String
      else { throw WakeError.malformed }
      puks[generation] = try unb64(secret)
    }
    self.puks = puks
    var epochKeys: [String: [Int: Bytes]] = [:]
    for (conversation, keys) in record["epochKeys"] as? [String: [String: String]] ?? [:] {
      for (epoch, key) in keys {
        guard let number = Int(epoch) else { throw WakeError.malformed }
        epochKeys[conversation, default: [:]][number] = try unb64(key)
      }
    }
    self.epochKeys = epochKeys
  }
}

/// `GET` of an API path, answered with its status and body.
typealias WakeFetch = (_ path: String) async throws -> (status: Int, body: Data)

/// What opening one wake reads, as `WakeDeps` in `chatWake.ts`: the API through `fetch`.
struct ChatWakeDecryptor {
  let record: WakeKeyRecord?
  let fetch: WakeFetch
  private let identities = IdentityCache()

  init(record: WakeKeyRecord?, fetch: @escaping WakeFetch) {
    self.record = record
    self.fetch = fetch
  }

  /**
   * The notification a wake shows, or nil to show nothing. A DM shows the
   * sender and the message; a mention of `wake.user` shows "<from> in
   * <title>"; any other message, and anything but a new post, shows nothing.
   * A DM that cannot be opened here still says who wrote; a group message
   * that cannot shows nothing.
   */
  func open(_ wake: ChatWake) async -> WakeNotification? {
    let shown = { (title: String, body: String) in
      WakeNotification(title: title, body: body, url: wake.url, tag: "chat:\(wake.conversation)", seq: wake.seq)
    }
    let fallback = wake.dm ? shown(wake.from, "New message from \(wake.from)") : nil
    guard let record, record.userId == wake.user else { return fallback }
    let post: Post?
    do {
      post = try await openPost(wake, record)
    } catch {
      return fallback
    }
    guard let post else { return fallback }
    guard case let .text(body, mentions) = post else { return nil }
    if wake.dm { return shown(wake.from, body) }
    guard mentions.contains(wake.user) else { return nil }
    return shown("\(wake.from) in \(wake.title ?? "")", body)
  }

  private enum Post {
    case text(body: String, mentions: [String])
    case other
  }

  private struct Epoch {
    let number: Int
    let valid: Bool
    let previousKeyBox: Bytes?
  }

  /// The opened post's preview and mentions, `.other` for another kind, nil when it does not open.
  private func openPost(_ wake: ChatWake, _ record: WakeKeyRecord) async throws -> Post? {
    let envelope: [String: Any]?
    if let inline = wake.envelope {
      envelope = inline
    } else {
      envelope = try await message(wake.conversation, wake.seq)
    }
    guard let envelope,
          envelope["conversationId"] as? String == wake.conversation,
          envelope["seq"] as? Int == wake.seq,
          let kind = envelope["kind"] as? String,
          let number = envelope["epoch"] as? Int
    else { return nil }
    guard kind == "post" else { return .other }
    let conversation = wake.conversation
    let fetched = try await epochs(conversation, after: number - 1)
    var state: [Int: Epoch] = [:]
    for epoch in fetched.epochs {
      state[epoch.number] = epoch
    }
    var held = record
    if held.epochKeys[conversation]?[number] == nil,
       let key = try openEpochKey(record, conversation, state, fetched.boxes)[number] {
      // Into this copy only, never saved.
      held.epochKeys[conversation, default: [:]][number] = key
    }
    guard let key = held.epochKeys[conversation]?[number] else { return nil }
    return try await openEnvelope(envelope, kind, epoch: state[number], key: key)
  }

  /// `GET …/messages?after=<seq - 1>&limit=1`'s message.
  private func message(_ conversation: String, _ seq: Int) async throws -> [String: Any]? {
    let path = "\(chatPath(conversation))/messages?after=\(seq - 1)&limit=1"
    return (try await json(path) as? [[String: Any]])?.first
  }

  /// `GET …/epochs?after=<after>`: each epoch checked against who signed it, and this reader's boxes.
  private func epochs(
    _ conversation: String,
    after: Int
  ) async throws -> (epochs: [Epoch], boxes: [[String: Any]]) {
    guard let body = try await json("\(chatPath(conversation))/epochs?after=\(after)") as? [String: Any],
          let records = body["epochs"] as? [[String: Any]]
    else { throw WakeError.malformed }
    var epochs: [Epoch] = []
    for record in records {
      epochs.append(try await checkEpoch(conversation, record))
    }
    return (epochs, body["boxes"] as? [[String: Any]] ?? [])
  }

  /// `checkEpoch`: whether an epoch's record is what its creator signed, and well formed.
  private func checkEpoch(_ conversation: String, _ record: [String: Any]) async throws -> Epoch {
    guard let number = record["epoch"] as? Int,
          let chainBreak = record["chainBreak"] as? Bool,
          let identityId = record["identityId"] as? String,
          let creator = record["createdByUserId"] as? String,
          let signature = record["signature"] as? String
    else { throw WakeError.malformed }
    let box = try (record["previousKeyBox"] as? String).map(unb64)
    let shaped = number == 1 ? !chainBreak && box == nil : chainBreak == (box == nil)
    guard shaped, let identity = try await identity(identityId), identity.userId == creator else {
      return Epoch(number: number, valid: false, previousKeyBox: box)
    }
    let signed = try ChatCore.one(
      "epochSignedBytes", [utf8(conversation), u64(number), box ?? []]
    )
    let valid = try ChatCore.flag("verify", [try unb64(signature), signed, identity.publicKey])
    return Epoch(number: number, valid: valid, previousKeyBox: box)
  }

  /**
   * `openEpochKey`: the keys this reader's boxes give it, then each key it
   * holds walked down the chain as far as the chain goes. Keeps nothing.
   */
  private func openEpochKey(
    _ record: WakeKeyRecord,
    _ conversation: String,
    _ state: [Int: Epoch],
    _ boxes: [[String: Any]]
  ) throws -> [Int: Bytes] {
    var found: [Int: Bytes] = [:]
    guard let identityId = record.identityId else { return found }
    let have = { (epoch: Int) in found[epoch] ?? record.epochKeys[conversation]?[epoch] }
    for box in boxes {
      guard box["identityId"] as? String == identityId,
            let epoch = box["epoch"] as? Int, have(epoch) == nil,
            let generation = box["pukGeneration"] as? Int,
            let sealed = box["box"] as? String,
            let secret = record.puks[generation]
      else { continue }
      let aad = lp(conversation) + u64(epoch) + (try UserIds.identity(record.userId))
        + lp(identityId) + u64(generation)
      let purpose = box["grantedByUserId"] is String ? "grant" : "epoch"
      // A box that does not open is no key; the chat stays locked.
      guard let opened = try? unb64(sealed), opened.count >= 48,
            let key = try? ChatCore.one("hpkeOpen", [utf8(purpose), secret, aad, opened]),
            key.count == 32
      else { continue }
      found[epoch] = key
    }
    for number in state.keys.sorted(by: >) {
      guard let epoch = state[number], epoch.valid, let box = epoch.previousKeyBox,
            let key = have(number), have(number - 1) == nil, box.count >= 40
      else { continue }
      // A broken link: what lies below it stays closed.
      found[number - 1] = try? ChatCore.one(
        "openPreviousEpochKey", [utf8(conversation), u64(number), key, box]
      )
    }
    return found
  }

  /// `openEnvelope` of a post: verified against its sender's identity, then opened.
  private func openEnvelope(
    _ envelope: [String: Any],
    _ kind: String,
    epoch: Epoch?,
    key: Bytes
  ) async throws -> Post? {
    guard envelope["clearedAt"] as? String == nil,
          let id = envelope["id"] as? String,
          let conversation = envelope["conversationId"] as? String,
          let number = envelope["epoch"] as? Int,
          let sender = envelope["senderUserId"] as? String,
          let senderIdentity = envelope["senderIdentityId"] as? String,
          let nonce = envelope["nonce"] as? String,
          let ciphertext = envelope["ciphertext"] as? String, ciphertext != "",
          let signature = envelope["signature"] as? String,
          epoch?.valid == true,
          let identity = try await identity(senderIdentity), identity.userId == sender
    else { return nil }
    let fields = [utf8(conversation), u64(number), utf8(id), try UserIds.identity(sender), utf8(kind)]
    let sealed = (nonce: try unb64(nonce), ciphertext: try unb64(ciphertext))
    guard try ChatCore.flag(
      "verifyMessage",
      fields + [sealed.nonce, sealed.ciphertext, try unb64(signature), identity.publicKey]
    ) else { return nil }
    let messageKey = try ChatCore.one("messageKey", [key, utf8(conversation), utf8(id)])
    let plaintext = try ChatCore.one(
      "openWithMessageKey", fields + [messageKey, sealed.nonce, sealed.ciphertext]
    )
    return try content(plaintext)
  }

  /// A post's content (`decodeContent`), as its preview and mentions.
  private func content(_ plaintext: Bytes) throws -> Post? {
    guard let raw = try? JSONSerialization.jsonObject(with: Data(plaintext)),
          let content = raw as? [String: Any],
          content["type"] as? String == "text",
          let body = content["body"] as? String,
          let mentionList = content["mentions"] as? [Any],
          let attachments = content["attachments"] as? [[String: Any]]
    else { return nil }
    var mentions: [String] = []
    for mention in mentionList {
      if let id = mention as? String {
        mentions.append(id)
      } else if let number = mention as? Int {
        mentions.append(UserIds.ofGumbo(number))
      } else {
        return nil
      }
    }
    return .text(body: preview(body, attachments), mentions: mentions)
  }

  /// `contentPreview`: the words, or what the post holds when it has none.
  private func preview(_ body: String, _ attachments: [[String: Any]]) -> String {
    if body != "" { return body }
    if attachments.count > 1 { return "\(attachments.count) attachments" }
    guard let attachment = attachments.first else { return "Message unavailable" }
    let type = attachment["contentType"] as? String ?? ""
    if type.hasPrefix("image/") { return "Photo" }
    if type.hasPrefix("video/") { return "Video" }
    return "File: \(attachment["fileName"] as? String ?? "")"
  }

  private struct Identity {
    let userId: String
    let publicKey: Bytes
  }

  /// `GET /chat/identities/:id`, each read once; nil when the server has none to show.
  private func identity(_ identityId: String) async throws -> Identity? {
    if let known = await identities.get(identityId) { return known }
    let path = "/chat/identities/\(escaped(identityId))"
    let answer = try await fetch(path)
    if answer.status == 404 { return nil }
    guard let body = try decoded(answer, path) as? [String: Any],
          let userId = body["userId"] as? String,
          let publicKey = body["publicKey"] as? String
    else { throw WakeError.malformed }
    let identity = Identity(userId: userId, publicKey: try unb64(publicKey))
    await identities.set(identityId, identity)
    return identity
  }

  private actor IdentityCache {
    private var known: [String: Identity] = [:]
    func get(_ id: String) -> Identity? { known[id] }
    func set(_ id: String, _ identity: Identity) { known[id] = identity }
  }

  private func json(_ path: String) async throws -> Any {
    try decoded(try await fetch(path), path)
  }

  private func decoded(_ answer: (status: Int, body: Data), _ path: String) throws -> Any {
    guard answer.status == 200 else { throw WakeError.status(answer.status) }
    guard let value = try? JSONSerialization.jsonObject(with: answer.body) else {
      throw WakeError.malformed
    }
    return value
  }

  private func chatPath(_ conversation: String) -> String {
    "/chat/conversations/\(escaped(conversation))"
  }

  private func escaped(_ part: String) -> String {
    part.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(["-", "_", "."])) ?? part
  }
}

/// What the app keeps in the keychain, read the way `react-native-keychain` wrote it.
enum WakeKeychain {
  /// `sessionStore.native.ts`: the API's base URL as the account, the bearer token as the password.
  static let sessionService = "app.teamstation.session"
  /// `keyStore.native.ts`: `app.teamstation.chat.<userId>`, or the legacy one-account slot.
  static let keyService = "app.teamstation.chat"

  /// One generic password: its account and its text. Synchronized or not, as it was saved.
  static func item(_ service: String) -> (account: String, password: String)? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
          let item = found as? [String: Any],
          let data = item[kSecValueData as String] as? Data
    else { return nil }
    return (item[kSecAttrAccount as String] as? String ?? "", String(decoding: data, as: UTF8.self))
  }

  /// The signed-in session: where its API is and its token.
  static func session() -> (baseUrl: String, token: String)? {
    guard let item = item(sessionService), item.account.hasPrefix("http") else { return nil }
    return (item.account, item.password)
  }

  /// This phone's record for `userId`, read only; nil when it holds none it can read.
  static func record(_ userId: String) -> WakeKeyRecord? {
    for service in ["\(keyService).\(userId)", keyService] {
      if let item = item(service), let record = try? WakeKeyRecord(json: item.password),
         record.userId == userId {
        return record
      }
    }
    return nil
  }
}

/// What a push comes to on this phone.
enum WakeOutcome: Equatable {
  /// Not a chat wake: shown as the server sent it.
  case notWake
  case show(WakeNotification)
  /// A wake that shows nothing.
  case hide
}

enum ChatWakes {
  /**
   * Opens `payload` with the record and the session the app keeps. Signed
   * out, a wake shows nothing, not even who wrote a DM: whoever holds the
   * phone is not told who writes to the person.
   */
  static func open(_ payload: [AnyHashable: Any]) async -> WakeOutcome {
    guard let wake = ChatWake(payload) else { return .notWake }
    guard let session = WakeKeychain.session() else { return .hide }
    let decryptor = ChatWakeDecryptor(
      record: WakeKeychain.record(wake.user),
      fetch: { path in try await get(session.baseUrl + path, token: session.token) }
    )
    guard let shown = await decryptor.open(wake) else { return .hide }
    return .show(shown)
  }

  /// One signed-in `GET`, with the session's bearer token.
  static func get(_ url: String, token: String) async throws -> (status: Int, body: Data) {
    guard let address = URL(string: url) else { throw WakeError.malformed }
    var request = URLRequest(url: address, timeoutInterval: 10)
    request.setValue("application/json", forHTTPHeaderField: "accept")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
    let (body, response) = try await URLSession.shared.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, body)
  }
}

/**
 * The same, by name, for `ChatWakeDecryptorTests`: the test bundle takes no
 * pods and cannot import the app, so it reaches this through the
 * Objective-C runtime, as `SceneLifecycleTests` reaches `SceneDelegate`.
 */
@objc(TSChatWakes)
final class ChatWakesEntry: NSObject {
  /// Opens `payload` with `record` (stored JSON) and the API answers `fetch` gives for each path.
  @objc(open:record:fetch:done:)
  func open(
    _ payload: NSDictionary,
    record: NSString?,
    fetch: @escaping (NSString, @escaping (NSData?, Int) -> Void) -> Void,
    done: @escaping (NSDictionary?) -> Void
  ) {
    guard let wake = ChatWake(payload as? [AnyHashable: Any] ?? [:]) else { return done(nil) }
    let decryptor = ChatWakeDecryptor(
      record: try? record.map { try WakeKeyRecord(json: $0 as String) },
      fetch: { path in
        try await withCheckedThrowingContinuation { resume in
          fetch(path as NSString) { body, status in
            if status == 0 {
              resume.resume(throwing: WakeError.status(0))
            } else {
              resume.resume(returning: (status, (body ?? NSData()) as Data))
            }
          }
        }
      }
    )
    Task { done(Self.dictionary(await decryptor.open(wake))) }
  }

  /// `ChatWakes.open` over the keychain and the network: `{ outcome, title?, body?, url?, tag? }`.
  @objc(openStored:done:)
  func openStored(_ payload: NSDictionary, done: @escaping (NSDictionary) -> Void) {
    Task {
      switch await ChatWakes.open(payload as? [AnyHashable: Any] ?? [:]) {
      case .notWake: done(["outcome": "notWake"])
      case .hide: done(["outcome": "hide"])
      case let .show(shown):
        let fields = Self.dictionary(shown) as? [String: String] ?? [:]
        done(fields.merging(["outcome": "show"]) { $1 } as NSDictionary)
      }
    }
  }

  /// The op numbers this file calls, for checking against `ops.json`.
  @objc func ops() -> NSDictionary {
    ChatCore.ops.mapValues { NSNumber(value: $0) } as NSDictionary
  }

  private static func dictionary(_ shown: WakeNotification?) -> NSDictionary? {
    guard let shown else { return nil }
    return ["title": shown.title, "body": shown.body, "url": shown.url, "tag": shown.tag]
  }
}
