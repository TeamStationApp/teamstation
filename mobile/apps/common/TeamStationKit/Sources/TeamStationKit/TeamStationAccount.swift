import Foundation
import Observation

/// The TeamStation account this Director is signed in to, and the game it is
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
///
/// Choosing a game and claiming it are separate. The chosen game is the one
/// this Director is covering: every recording is filed under it, and its
/// scoreboard can be drawn on the programme. Claiming asks TeamStation for
/// somewhere to stream it, which only a stream to the game itself needs.
@MainActor
@Observable
public final class TeamStationAccount: TeamStationEventService {
  public private(set) var user: TeamStationUser?
  public private(set) var events: [TeamStationEvent] = []
  /// The games already played, latest first — the list an upload picks from.
  public private(set) var finishedEvents: [TeamStationEvent] = []
  /// One recording on its way up, by the take it came from.
  public private(set) var uploads: [Int64: UploadProgress] = [:]
  public private(set) var isLoading = false
  public private(set) var lastError: String?

  /// The game the Stream button publishes to, as far as this app knows.
  public private(set) var chosen: ChosenEvent?

  public var isSignedIn: Bool { user != nil }

  /// The account and server this device last proved its token belongs to.
  ///
  /// Set when a sign-in completes or the server answers `auth/me`, kept across relaunches, and
  /// left alone when the server cannot be reached — so a Director relaunched with no network,
  /// whose `user` stays nil, still knows who it is. Cleared by sign-out and by the server
  /// rejecting the token.
  public private(set) var scope: TeamStationAccountScope?

  /// Whether a token is kept, whether or not the server has been reached since.
  public var hasToken: Bool { keychain.token() != nil }

  /// Whether this device may take part in device event control as the account in `scope`: it
  /// holds a token, and the identity it proved is for the server it is pointed at now.
  public var isEventControlEligible: Bool {
    guard hasToken, let scope else { return false }
    return scope.server == TeamStationAccountScope.origin(of: serverURL)
  }

  /// Where TeamStation is. Changed only in Settings, and only by Paul.
  public var serverURL: URL

  /// This app's own link host, which its sign-in links are mailed to and
  /// opened from. Nil in a build without one, which asks for web links.
  public let appOrigin: URL?

  private let keychain: KeychainStore
  private let deviceName: String
  private let session: URLSession
  /// This installation's own id, which the server keys its stream on: the same camera name on
  /// two devices is two cameras. Kept in the app's preferences.
  public let installId: String
  /// What the device is, for every list of the game's cameras ("iPad Pro").
  public let deviceModel: String
  /// The clock, in seconds since 1970, that the instants this account reports are read on: the
  /// server-clock offset is measured against it, so it lines up with them. Director times its
  /// stream on the steady wall clock, which an NTP step of the device's own clock does not move.
  private let clock: @Sendable () -> Double

  public init(
    serverURL: URL,
    deviceName: String,
    appOrigin: URL? = nil,
    installId: String = "",
    deviceModel: String = DeviceModelName.current,
    keychain: KeychainStore = KeychainStore(service: "app.teamstation.director"),
    session: URLSession = .shared,
    clock: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 }
  ) {
    self.clock = clock
    self.serverURL = serverURL
    self.appOrigin = appOrigin
    self.deviceName = deviceName
    self.installId = installId
    self.deviceModel = deviceModel
    self.keychain = keychain
    self.session = session
    chosen = keychain.chosenEvent()
    scope = keychain.token() == nil ? nil : keychain.accountScope()
  }

  /// What was picked, kept whole so the app can show the row and stream to it
  /// without asking anybody anything.
  ///
  /// `streamURL` is nil until the game has been claimed: a game chosen only to
  /// file recordings under, or to draw its scoreboard, never asks for one.
  ///
  /// `streamId` is the stream the address belongs to, which a redial names so
  /// that a stream ended on TeamStation stays ended. Optional, so a value kept
  /// by a build from before it decodes; the next refresh fills it in.
  public struct ChosenEvent: Sendable, Codable, Equatable {
    public let gameId: String
    public let title: String
    public let startAt: Date
    public let streamURL: String?
    public let streamId: String?

    public init(
      gameId: String,
      title: String,
      startAt: Date,
      streamURL: String?,
      streamId: String? = nil
    ) {
      self.gameId = gameId
      self.title = title
      self.startAt = startAt
      self.streamURL = streamURL
      self.streamId = streamId
    }
  }

  private var client: TeamStationClient {
    TeamStationClient(baseURL: serverURL, token: keychain.token(), session: session)
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
  /// The plain form, for a caller that reports progress its own way — TS
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
      lastError = "Sign in to TeamStation first."
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
  public private(set) var waiting: TeamStationSignInWait?

  /**
   * Asks TeamStation to send the e-mail, and starts waiting for it to be
   * answered — by the button in it, tapped anywhere, or by the code typed
   * here.
   */
  public func startSignIn(email: String) async throws {
    waiting = try await client.startSignIn(
      email: email,
      appOrigin: appOrigin.map { TeamStationAccountScope.origin(of: $0) }
    )
    lastError = nil
  }

  /**
   * Signs in with a link the operating system handed the app.
   *
   * Only a `/signin/<token>` link on this app's own link host is one. Its
   * token is spent against this app's server when the link names that server
   * or none, or names another name the server reports as its own OpenID
   * issuer. A link from any other server is never sent anywhere.
   */
  public func signIn(link: URL) async -> SignInLinkOutcome {
    let own = TeamStationAccountScope.origin(of: serverURL)
    let token: String
    switch SignInLink.read(link, appOrigin: appOrigin, serverOrigin: own) {
    case .notSignIn:
      return .notSignIn
    case let .spend(spendable):
      token = spendable
    case let .confirm(spendable, server):
      let issuer: String?
      do {
        issuer = try await client.issuer()
      } catch {
        let outcome = SignInLinkOutcome.unreachable(own: own)
        lastError = outcome.message
        return outcome
      }
      guard issuer == "\(server)/oauth" else {
        return .wrongServer(server: server, own: own)
      }
      token = spendable
    }
    do {
      let session = try await client.signInWithLink(
        token: token,
        deviceName: deviceName,
        requestId: waiting?.requestId
      )
      waiting = nil
      adopt(session)
      return .signedIn(displayName: session.user.displayName)
    } catch {
      let why = error.localizedDescription
      lastError = why
      return .failed(why)
    }
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

  private func adopt(_ session: TeamStationSession) {
    keychain.setToken(session.token)
    user = session.user
    remember(session.user.id)
    waiting = nil
    lastError = nil
  }

  private func remember(_ userId: String) {
    let next = TeamStationAccountScope(
      server: TeamStationAccountScope.origin(of: serverURL),
      userId: userId
    )
    guard next != scope else { return }
    scope = next
    keychain.setAccountScope(next)
  }

  /// Picks the signed-in account up again after a relaunch.
  public func restore() async {
    guard keychain.token() != nil else { return }
    do {
      let who = try await client.whoAmI()
      user = who
      remember(who.id)
    } catch TeamStationError.notSignedIn {
      // The session was revoked or ran out. Forget it rather than leave the
      // screen claiming to be signed in as somebody.
      signOut()
    } catch {
      // Offline. The account is still ours; the name simply is not known until
      // there is a network, and the cached event still streams. `scope` keeps
      // the identity proved before.
    }
  }

  /**
   * This device's key for device event control, fetched with its own session.
   *
   * The answer names the user the server holds this token for, which is
   * remembered as `scope`. The server rejecting the token signs this device
   * out, as `restore` does; anything else is thrown and changes nothing.
   *
   * An answer that arrives after the token changed (a sign-out, or a sign-in
   * as someone else, while it was on its way) is for the token it was asked
   * with, not the one kept now: it is thrown away as `accountChanged`, and
   * neither remembered nor allowed to sign the new session out.
   */
  public func deviceEventControlKey() async throws -> TeamStationEventControlKey {
    let askedWith = keychain.token()
    do {
      let key = try await client.deviceEventControlKey()
      guard keychain.token() == askedWith else { throw TeamStationError.accountChanged }
      remember(key.userId)
      return key
    } catch TeamStationError.notSignedIn {
      guard keychain.token() == askedWith else { throw TeamStationError.accountChanged }
      signOut()
      throw TeamStationError.notSignedIn
    }
  }

  public func signOut() {
    keychain.setToken(nil)
    keychain.setChosenEvent(nil)
    keychain.setAccountScope(nil)
    scope = nil
    user = nil
    events = []
    chosen = nil
    waiting = nil
  }

  // MARK: - Events

  public func refreshEvents() async {
    guard keychain.token() != nil else {
      lastError = TeamStationError.notSignedIn.localizedDescription
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

  /**
   * Points this Director at a game, and claims it when `claim` is true.
   *
   * Unclaimed, nothing is asked of the server: the game is kept as the one
   * being covered, and a stream address is fetched only if the programme is
   * later streamed to it. A claim that fails fails the choice, and the game
   * chosen before stays chosen.
   */
  @discardableResult
  public func choose(
    event: TeamStationEvent,
    claim: Bool = true,
    cameraName: String = ""
  ) async -> Bool {
    guard claim else {
      // Choosing the same game again keeps the address it was given.
      let same = chosen?.gameId == event.gameId
      keep(ChosenEvent(
        gameId: event.gameId,
        title: event.title,
        startAt: event.startAt,
        streamURL: same ? chosen?.streamURL : nil,
        streamId: same ? chosen?.streamId : nil
      ))
      lastError = nil
      return true
    }
    isLoading = true
    defer { isLoading = false }
    do {
      let taken = try await requestStream(gameId: event.gameId, cameraName: cameraName, held: nil)
      keep(claimed(taken, gameId: event.gameId, title: event.title, startAt: event.startAt))
      lastError = nil
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  /**
   * Claims the game already chosen, and keeps the address it is given.
   *
   * Unlike `refreshChosen` this is loud: it is asked for when somebody picks
   * the game as the stream's destination or presses Stream with no address
   * yet, and a refusal is something they need to read. `lastError` says why.
   */
  @discardableResult
  public func claimChosen(cameraName: String = "") async -> Bool {
    guard let current = chosen else {
      lastError = "Pick a TeamStation event first."
      return false
    }
    isLoading = true
    defer { isLoading = false }
    do {
      let taken = try await requestStream(gameId: current.gameId, cameraName: cameraName, held: nil)
      // Another game may have been picked while the claim was out.
      guard chosen?.gameId == current.gameId else { return false }
      keep(claimed(taken, gameId: current.gameId, title: current.title, startAt: current.startAt))
      lastError = nil
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  /// The chosen game's scoreboard page, drawn on the programme.
  ///
  /// Built here without asking anybody: every game has one, open from the
  /// moment the game exists. `quiet=1` makes a closed scoreboard draw nothing
  /// rather than the page that invites a visitor to sign up.
  public func scoreboardURL(for gameId: String) -> URL {
    let page = serverURL.appending(path: "scoreboard").appending(path: gameId)
    var parts = URLComponents(url: page, resolvingAgainstBaseURL: false)
    parts?.queryItems = [URLQueryItem(name: "quiet", value: "1")]
    return parts?.url ?? page
  }

  private func claimed(
    _ stream: TeamStationDeviceStream,
    gameId: String,
    title: String,
    startAt: Date
  ) -> ChosenEvent {
    ChosenEvent(
      gameId: gameId,
      title: title,
      startAt: startAt,
      streamURL: stream.url,
      streamId: stream.id
    )
  }

  /// This device's stream on a game, by its install id and model: `POST …/live-streams`.
  private func requestStream(
    gameId: String,
    cameraName: String,
    held: String?
  ) async throws -> TeamStationDeviceStream {
    try await client.requestLiveStream(
      gameId: gameId,
      label: cameraName,
      deviceId: installId,
      deviceModel: deviceModel,
      heldStreamId: held
    )
  }

  private func keep(_ next: ChosenEvent) {
    chosen = next
    keychain.setChosenEvent(next)
  }

  /**
   * Asks for the chosen game's address again.
   *
   * A key can have been rotated since the game was picked — on the website, or
   * by another Director taking the same game — and the first anybody would
   * know of it is a stream that will not start at the first pitch. So it is
   * asked for again at the moment it is about to be used, and only then.
   *
   * `.start` asks without naming the stream held, so a stream that was ended
   * is replaced by a fresh one, whose id and address are kept. `.redial` names
   * the held stream: if it was ended this throws `TeamStationError.streamEnded`
   * and nothing new is made, so a drop never puts back a camera somebody
   * ended.
   *
   * Every other failure is deliberately quiet. Out at a field with no signal
   * the cached address is the best thing anybody has, and it is usually still
   * right.
   */
  public func refreshChosen(
    cameraName: String = "",
    reason: LiveStreamRequestReason = .start
  ) async throws {
    guard let current = chosen else { return }
    do {
      let taken = try await requestStream(
        gameId: current.gameId,
        cameraName: cameraName,
        held: reason == .redial ? current.streamId : nil
      )
      guard chosen?.gameId == current.gameId else { return }
      keep(claimed(taken, gameId: current.gameId, title: current.title, startAt: current.startAt))
      lastError = nil
    } catch TeamStationError.streamEnded {
      throw TeamStationError.streamEnded
    } catch {
      // Kept to itself: the cached address is what the Stream button is about
      // to use, and saying "could not reach TeamStation" over a stream that is
      // starting anyway would be noise at the worst moment.
    }
  }

  /**
   * Renames the camera this device holds on the chosen game: `PATCH` on its
   * stream, which keeps the stream, its key and its video. Nothing is asked
   * when no stream is held yet; the next request sends the new name.
   */
  @discardableResult
  public func renameStream(label: String) async -> Bool {
    guard let current = chosen, let streamId = current.streamId else { return false }
    do {
      _ = try await client.updateLiveStream(
        gameId: current.gameId,
        streamId: streamId,
        label: label
      )
      lastError = nil
      return true
    } catch {
      lastError = error.localizedDescription
      return false
    }
  }

  /**
   * Says when the first picture of the held stream's first publish was
   * captured, which is where TeamStation places the stream's live video.
   * Nothing is asked when no stream is held. A failure is not the operator's
   * to hear about: the server then places the video by when it heard it.
   *
   * `startedAt` is on this account's `clock`, and so is the offset to the
   * server's: measured against `Date()` instead, an NTP step since launch
   * would move the reported start by that step.
   */
  @discardableResult
  public func reportLiveStart(startedAt: Date) async -> Bool {
    guard let current = chosen, let streamId = current.streamId else { return false }
    do {
      // On the server's clock (`ServerClock`); an iPad's own is usually right, but not always.
      let offset = try await client.serverClockOffset(now: clock)
      try await client.reportLiveStart(
        gameId: current.gameId,
        streamId: streamId,
        startedAt: startedAt.addingTimeInterval(offset)
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Why TeamStation refused the publish, in its own words.
   *
   * The ingest writes the reason on the game's row — the key is not open, the
   * codec is wrong, there is no room on the disk — and that sentence is worth
   * far more than the socket's, which can only say a connection closed.
   *
   * The row read is this device's own among the game's cameras: the one whose
   * `deviceId` is this installation's. Its state and its window come first,
   * because the ingest refuses those without writing anything: a camera
   * somebody ended, or a window that has not opened or has closed. After
   * those, the ingest's own last word.
   *
   * `nil` when it has nothing to add, which includes every case where the
   * network is the problem: then the socket's own message is the true one.
   */
  public func reasonForRefusal() async -> String? {
    guard let gameId = chosen?.gameId, keychain.token() != nil else {
      return nil
    }
    guard let streams = try? await client.liveStreams(gameId: gameId) else {
      return nil
    }
    guard let mine = streams.mine.first(where: { $0.deviceId == installId }) else { return nil }
    return Self.refusal(of: mine, now: Date(timeIntervalSince1970: clock()))
  }

  /// Why the ingest would refuse `stream` at `now`, nil when nothing on its row says.
  static func refusal(of stream: TeamStationDeviceStream, now: Date) -> String? {
    if stream.state == "ended" || stream.state == "revoked" {
      return TeamStationError.streamEnded.localizedDescription
    }
    let time = Date.FormatStyle(date: .omitted, time: .shortened)
    if let opensAt = stream.opensAt, now < opensAt {
      return "This camera can go live from \(opensAt.formatted(time))."
    }
    if let closesAt = stream.closesAt, now >= closesAt {
      return "This camera's streaming window closed at \(closesAt.formatted(time))."
    }
    guard let said = stream.lastError, !said.isEmpty else { return nil }
    return said
  }

  public func forgetChosenEvent() {
    chosen = nil
    keychain.setChosenEvent(nil)
  }
}

/**
 * The part of the account that decides which game this Director covers.
 *
 * Director's event coordinator talks to this rather than to the account, so
 * its rules can be tested against a stub that answers without a server.
 */
@MainActor
public protocol TeamStationEventService: AnyObject {
  var chosen: TeamStationAccount.ChosenEvent? { get }
  /// Why the last request failed, in TeamStation's words.
  var lastError: String? { get }
  @discardableResult
  func choose(event: TeamStationEvent, claim: Bool, cameraName: String) async -> Bool
  @discardableResult
  func claimChosen(cameraName: String) async -> Bool
  /// Throws `TeamStationError.streamEnded` when a `.redial` finds the held stream ended.
  func refreshChosen(cameraName: String, reason: LiveStreamRequestReason) async throws
  /// Renames the held stream's camera on TeamStation.
  @discardableResult
  func renameStream(label: String) async -> Bool
  /// Says when the held stream's first published picture was captured.
  @discardableResult
  func reportLiveStart(startedAt: Date) async -> Bool
  func forgetChosenEvent()
  func scoreboardURL(for gameId: String) -> URL
}
