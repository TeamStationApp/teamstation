import Foundation
import Observation

/// The GameStation account this Director is signed in to, and the game it is
/// pointed at.
///
/// The token lives in the keychain rather than in `AppConfig`, which is a plain
/// JSON file in the app's container: a settings file is copied around, read by
/// the export tools and printed in diagnostics, and a token that lasts a season
/// has no business in one.
///
/// The **stream key is kept too**, beside the event it belongs to. A ball field
/// is where this app works and a ball field is where the signal is worst; an
/// operator who picked the game at home on Friday must be able to press Stream
/// on Saturday with no network at all.
@MainActor
@Observable
public final class GameStationAccount {
  public private(set) var user: GameStationUser?
  public private(set) var events: [GameStationEvent] = []
  /// The games already played, latest first — the list an upload picks from.
  public private(set) var finishedEvents: [GameStationEvent] = []
  /// One recording on its way up, by the take it came from.
  public private(set) var uploads: [Int64: UploadProgress] = [:]
  public private(set) var isLoading = false
  public private(set) var lastError: String?

  /// The game the Stream button publishes to, as far as this app knows.
  public private(set) var chosen: ChosenEvent?

  public var isSignedIn: Bool { user != nil }

  /// Where GameStation is. Changed only in Settings, and only by Paul.
  public var serverURL: URL

  private let keychain: KeychainStore
  private let deviceName: String

  public init(
    serverURL: URL,
    deviceName: String,
    keychain: KeychainStore = KeychainStore(service: "co.gamestation.director")
  ) {
    self.serverURL = serverURL
    self.deviceName = deviceName
    self.keychain = keychain
    chosen = keychain.chosenEvent()
  }

  /// What was picked, kept whole so the app can show the row and stream to it
  /// without asking anybody anything.
  public struct ChosenEvent: Sendable, Codable, Equatable {
    public let gameId: String
    public let title: String
    public let startAt: Date
    public let streamURL: String

    public init(
      gameId: String,
      title: String,
      startAt: Date,
      streamURL: String
    ) {
      self.gameId = gameId
      self.title = title
      self.startAt = startAt
      self.streamURL = streamURL
    }
  }

  private var client: GameStationClient {
    GameStationClient(baseURL: serverURL, token: keychain.token())
  }

  /// What one recording's upload is doing, for the row it came from.
  public struct UploadProgress: Sendable, Equatable {
    public var name: String
    public var fraction: Double
    public var done: Bool
    public var failed: String?
    /// What the server is doing once the bytes are up: nil while they are
    /// going, then a word for the phase. Without it a two-hour take shows a
    /// full bar for four minutes and looks wedged.
    public var step: String?

    /// What to show for this upload, in words.
    public var saying: String {
      if let failed { return failed }
      if done { return "Uploaded" }
      guard let step else { return "Uploading \(Int(fraction * 100))%" }
      switch step {
      case "assembling": return "Putting the parts together…"
      case "probing": return "Reading the recording…"
      case "remuxing": return "Converting…"
      case "uploading": return "Copying to the library…"
      case "writing": return "Nearly there…"
      default: return "Working…"
      }
    }
  }

  /// The games already played, for a take that was never claimed to one.
  public func refreshFinishedEvents() async {
    guard keychain.token() != nil else { return }
    do {
      finishedEvents = try await client.finishedEvents()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  /// Sends one file to a game and answers with the video it became.
  ///
  /// The plain form, for a caller that reports progress its own way — GS
  /// Distributor tracks it per export rather than per take. `upload` below is
  /// the same thing with the Director's bookkeeping around it.
  public func send(
    file: URL,
    gameId: String,
    title: String,
    kind: String,
    startedAt: Date,
    onProgress: @escaping @Sendable (Int64, Int64, String?) -> Void = { _, _, _ in }
  ) async throws -> String {
    let service = UploadService(client: client)
    return try await service.send(
      file: file,
      gameId: gameId,
      title: title,
      kind: kind,
      startedAt: startedAt,
      onProgress: { progress in
        onProgress(
          Int64(progress.bytesSent),
          Int64(progress.bytesTotal),
          progress.step
        )
      }
    )
  }

  /// Sends one exported file to a game, and reports its progress by take.
  ///
  /// The upload is the export's own files — whatever the operator ticked —
  /// sent somewhere else, so nothing is exported twice and nothing is chosen
  /// twice. What comes back is the video it became, which by then has already
  /// taken the live stream's place on that game.
  public func upload(
    file: URL,
    recordingID: Int64,
    gameId: String,
    title: String,
    kind: String,
    startedAt: Date
  ) async -> String? {
    guard keychain.token() != nil else {
      lastError = "Sign in to GameStation first."
      return nil
    }
    uploads[recordingID] = UploadProgress(
      name: file.lastPathComponent,
      fraction: 0,
      done: false,
      failed: nil
    )
    do {
      let videoId = try await send(
        file: file,
        gameId: gameId,
        title: title,
        kind: kind,
        startedAt: startedAt,
        onProgress: { [weak self] sent, total, step in
          Task { @MainActor in
            guard let self, total > 0 else { return }
            var held = self.uploads[recordingID]
            held?.fraction = Double(sent) / Double(total)
            held?.step = step
            self.uploads[recordingID] = held
          }
        }
      )
      uploads[recordingID]?.fraction = 1
      uploads[recordingID]?.step = nil
      uploads[recordingID]?.done = true
      return videoId
    } catch {
      let said = error.localizedDescription
      uploads[recordingID]?.failed = said
      lastError = said
      return nil
    }
  }

  // MARK: - Signing in

  /// What this Director is waiting on, while somebody goes to their e-mail.
  public private(set) var waiting: GameStationSignInWait?

  /**
   * Asks GameStation to send the e-mail, and starts waiting for it to be
   * answered — by the button in it, tapped anywhere, or by the code typed
   * here.
   */
  public func startSignIn(email: String) async throws {
    waiting = try await client.startSignIn(email: email)
    lastError = nil
  }

  public func completeSignIn(email: String, code: String) async throws {
    let session = try await client.completeSignIn(
      email: email,
      code: code,
      deviceName: deviceName
    )
    adopt(session)
  }

  /**
   * Asks whether somebody has answered the e-mail yet.
   *
   * Called on a timer while the sign-in screen is open. `false` means not yet,
   * which is what it says almost every time it is asked.
   */
  @discardableResult
  public func pollSignIn() async -> Bool {
    guard let wait = waiting else { return false }
    do {
      let session = try await client.pollSignIn(
        requestId: wait.requestId,
        clientSecret: wait.clientSecret,
        deviceName: deviceName
      )
      guard let session else { return false }
      adopt(session)
      return true
    } catch {
      // Offline, most likely. The next tick asks again; saying so on every
      // one would fill the screen with a message about a thing still working.
      return false
    }
  }

  private func adopt(_ session: GameStationSession) {
    keychain.setToken(session.token)
    user = session.user
    waiting = nil
    lastError = nil
  }

  /// Picks the signed-in account up again after a relaunch.
  public func restore() async {
    guard keychain.token() != nil else { return }
    do {
      user = try await client.whoAmI()
    } catch GameStationError.notSignedIn {
      // The session was revoked or ran out. Forget it rather than leave the
      // screen claiming to be signed in as somebody.
      signOut()
    } catch {
      // Offline. The account is still ours; the name simply is not known until
      // there is a network, and the cached event still streams.
    }
  }

  public func signOut() {
    keychain.setToken(nil)
    keychain.setChosenEvent(nil)
    user = nil
    events = []
    chosen = nil
    waiting = nil
  }

  // MARK: - Events

  public func refreshEvents() async {
    guard keychain.token() != nil else {
      lastError = GameStationError.notSignedIn.localizedDescription
      return
    }
    isLoading = true
    defer { isLoading = false }
    do {
      events = try await client.events()
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  /// Takes a game: the server hands back where to publish it, and it is kept.
  @discardableResult
  public func choose(event: GameStationEvent) async -> Bool {
    isLoading = true
    defer { isLoading = false }
    do {
      let claim = try await client.claim(gameId: event.gameId)
      let next = ChosenEvent(
        gameId: event.gameId,
        title: event.title,
        startAt: event.startAt,
        streamURL: claim.url
      )
      chosen = next
      keychain.setChosenEvent(next)
      lastError = nil
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  /**
   * Asks for the chosen game's address again.
   *
   * A key can have been rotated since the game was picked — on the website, or
   * by another Director taking the same game — and the first anybody would
   * know of it is a stream that will not start at the first pitch. So it is
   * asked for again at the moment it is about to be used, and only then.
   *
   * Failure is deliberately quiet. Out at a field with no signal the cached
   * address is the best thing anybody has, and it is usually still right.
   */
  public func refreshChosen() async {
    guard let current = chosen else { return }
    do {
      let claim = try await client.claim(gameId: current.gameId)
      let next = ChosenEvent(
        gameId: current.gameId,
        title: current.title,
        startAt: current.startAt,
        streamURL: claim.url
      )
      chosen = next
      keychain.setChosenEvent(next)
      lastError = nil
    } catch {
      // Kept to itself: the cached address is what the Stream button is about
      // to use, and saying "could not reach GameStation" over a stream that is
      // starting anyway would be noise at the worst moment.
    }
  }

  /**
   * Why GameStation refused the publish, in its own words.
   *
   * The ingest writes the reason on the game's row — the key is not open, the
   * codec is wrong, there is no room on the disk — and that sentence is worth
   * far more than the socket's, which can only say a connection closed.
   *
   * It had been asking an endpoint that stopped existing when a key became a
   * person's rather than a game's, so it has quietly answered nothing ever
   * since, and every refusal reached the screen as whatever the socket said.
   *
   * `nil` when it has nothing to add, which includes every case where the
   * network is the problem: then the socket's own message is the true one.
   */
  public func reasonForRefusal() async -> String? {
    guard let gameId = chosen?.gameId, keychain.token() != nil else {
      return nil
    }
    guard let stream = try? await client.liveStream(gameId: gameId) else {
      return nil
    }
    guard let said = stream.lastError, !said.isEmpty else { return nil }
    return said
  }

  public func forgetChosenEvent() {
    chosen = nil
    keychain.setChosenEvent(nil)
  }
}
