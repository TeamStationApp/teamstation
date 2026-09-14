import Foundation
import Security

/// What is kept for a signed-in PeerTube account. Never the password.
public struct StoredAccount: Codable, Equatable, Sendable {
  public var host: String
  public var username: String
  public var client: OAuthClient
  public var tokens: TokenSet

  public init(host: String, username: String, client: OAuthClient, tokens: TokenSet) {
    self.host = host
    self.username = username
    self.client = client
    self.tokens = tokens
  }
}

public protocol AccountStorage: Sendable {
  func load() -> StoredAccount?
  func save(_ account: StoredAccount) throws
  func delete()
}

/// The Keychain, on this device only, readable after the first unlock so a recording's upload can
/// fetch a token without the screen being on. Not synced to iCloud.
public struct KeychainAccountStorage: AccountStorage {
  public let service: String

  public init(service: String = "co.gamestation.director.peertube") {
    self.service = service
  }

  public func load() -> StoredAccount? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "account",
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
      return nil
    }
    return try? JSONDecoder().decode(StoredAccount.self, from: data)
  }

  public func save(_ account: StoredAccount) throws {
    let data = try JSONEncoder().encode(account)
    delete()
    let item: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "account",
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      kSecValueData as String: data
    ]
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw PeerTubeError.http(status: Int(status), message: "the Keychain refused the account")
    }
  }

  public func delete() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: "account"
    ]
    SecItemDelete(query as CFDictionary)
  }
}

/// Kept in memory, for tests.
public final class MemoryAccountStorage: AccountStorage, @unchecked Sendable {
  private let lock = NSLock()
  private var account: StoredAccount?

  public init(_ account: StoredAccount? = nil) {
    self.account = account
  }

  public func load() -> StoredAccount? { lock.withLock { account } }
  public func save(_ account: StoredAccount) throws { lock.withLock { self.account = account } }
  public func delete() { lock.withLock { account = nil } }
}

/// The signed-in account GS Director holds: it signs in with a password it then forgets, keeps
/// the tokens, and hands out an access token that is always fresh enough to use.
public actor PeerTubeAccount {
  private let storage: any AccountStorage
  private let session: URLSession

  public init(storage: any AccountStorage, session: URLSession = PeerTubeAPI.ephemeral) {
    self.storage = storage
    self.session = session
  }

  public var current: StoredAccount? { storage.load() }

  /// Signs in and stores the tokens. Throws `.otpRequired` when the account wants a two-factor
  /// code; call again with it.
  @discardableResult
  public func signIn(host: String, username: String, password: String, otp: String?) async throws -> StoredAccount {
    let api = PeerTubeAPI(host: host, session: session)
    try await api.checkInstance()
    let client = try await api.localClient()
    let tokens = try await api.signIn(username: username, password: password, otp: otp, client: client)
    let account = StoredAccount(host: host, username: username, client: client, tokens: tokens)
    try storage.save(account)
    return account
  }

  public struct AccessToken: Sendable {
    public var host: String
    public var username: String
    public var token: String
    public var expiresAt: Date
  }

  /// An access token with at least five minutes left, refreshed and stored when it had less.
  /// A refresh the server refuses signs the account out.
  public func accessToken(now: Date = Date()) async throws -> AccessToken {
    guard var account = storage.load() else { throw PeerTubeError.signInAgain }
    if account.tokens.needsRefresh(now: now) {
      do {
        account.tokens = try await PeerTubeAPI(host: account.host, session: session)
          .refresh(account.tokens, client: account.client, now: now)
        try storage.save(account)
      } catch PeerTubeError.signInAgain {
        storage.delete()
        throw PeerTubeError.signInAgain
      }
    }
    return AccessToken(
      host: account.host,
      username: account.username,
      token: account.tokens.accessToken,
      expiresAt: account.tokens.accessExpiresAt
    )
  }

  public func signOut() async {
    if let account = storage.load() {
      await PeerTubeAPI(host: account.host, session: session).revoke(accessToken: account.tokens.accessToken)
    }
    storage.delete()
  }
}
