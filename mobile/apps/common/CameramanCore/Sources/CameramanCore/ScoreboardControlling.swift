import Foundation

/// One game the account may publish to. `recent` is the last three hours; `upcoming` is the next five.
public struct ScoreboardEventChoice: Equatable, Sendable, Identifiable {
  public var id: String { gameId }
  public var gameId: String
  public var title: String
  public var startAt: String
  public var whenLabel: String

  public init(gameId: String, title: String, startAt: String, whenLabel: String) {
    self.gameId = gameId
    self.title = title
    self.startAt = startAt
    self.whenLabel = whenLabel
  }
}

/// What Settings draws. The token stays in storage and is not on this object.
public struct ScoreboardSnapshot: Equatable, Sendable {
  public var route: ScoreboardRoute
  public var signedIn: Bool
  public var accountLabel: String
  public var apiServer: String
  public var v1EventId: String
  public var accountServer: String
  /// Bare host, for the line under sign-in when this build is not app.teamstation.app.
  public var accountHost: String
  public var gameTitle: String
  /// The chosen event's start, in the same words as the event list. Empty when none is chosen.
  public var gameWhen: String
  public var status: String
  public var awaitingCode: Bool
  public var pickerOpen: Bool
  public var recent: [ScoreboardEventChoice]
  public var upcoming: [ScoreboardEventChoice]
  public var pickerStatus: String
  /// "Allow Director Override", as saved.
  public var allowDirectorOverride: Bool
  /// The address of the Director whose event this is, while it holds one. Empty otherwise.
  public var overrideHost: String
  /// Why this device cannot take a Director's event yet, under the toggle. Empty when it can, or
  /// when the toggle is off.
  public var eventControlStatus: String

  public init(
    route: ScoreboardRoute = .v1,
    signedIn: Bool = false,
    accountLabel: String = "",
    apiServer: String = ScoreboardTarget.defaultV1Server,
    v1EventId: String = "",
    accountServer: String = ScoreboardTarget.defaultAccountServer,
    accountHost: String = ScoreboardTarget.productionAccountHost,
    gameTitle: String = "",
    gameWhen: String = "",
    status: String = "",
    awaitingCode: Bool = false,
    pickerOpen: Bool = false,
    recent: [ScoreboardEventChoice] = [],
    upcoming: [ScoreboardEventChoice] = [],
    pickerStatus: String = "",
    allowDirectorOverride: Bool = false,
    overrideHost: String = "",
    eventControlStatus: String = ""
  ) {
    self.route = route
    self.signedIn = signedIn
    self.accountLabel = accountLabel
    self.apiServer = apiServer
    self.v1EventId = v1EventId
    self.accountServer = accountServer
    self.accountHost = accountHost
    self.gameTitle = gameTitle
    self.gameWhen = gameWhen
    self.status = status
    self.awaitingCode = awaitingCode
    self.pickerOpen = pickerOpen
    self.recent = recent
    self.upcoming = upcoming
    self.pickerStatus = pickerStatus
    self.allowDirectorOverride = allowDirectorOverride
    self.overrideHost = overrideHost
    self.eventControlStatus = eventControlStatus
  }

  /// A Director holds the event: the row still shows its title and start time in full, and
  /// nothing on this device may change it.
  public var eventLocked: Bool { !overrideHost.isEmpty }

  /// "Override from Director 192.0.2.10" while a Director holds the event; empty otherwise.
  public var overrideLine: String {
    eventLocked ? "Override from Director \(overrideHost)" : ""
  }

  /// Whether Change Game (and the event row) opens the picker: signed in and no Director holding
  /// the event. Change Game shows gray and untappable otherwise.
  public var canPickEvent: Bool { signedIn && !eventLocked }
}

/// The phone's own environment conforms. A remote model does not, and the shared screen skips the card.
@MainActor
public protocol ScoreboardControlling: AnyObject {
  var scoreboard: ScoreboardSnapshot { get }
  func selectScoreboardRoute(_ route: ScoreboardRoute)
  func setScoreboardV1(apiServer: String, eventId: String)
  func setScoreboardAccountServer(_ server: String)
  func sendScoreboardCode(email: String)
  func verifyScoreboardCode(email: String, code: String)
  func signOutScoreboard()
  func openScoreboardEvents()
  func dismissScoreboardEvents()
  func chooseScoreboardEvent(_ gameId: String)
  /// "Allow Director Override". Off releases a Director's hold at once and gives the event back.
  func setAllowDirectorOverride(_ allowed: Bool)
}
