import DirectorCore
import Foundation

/// What runs a web-rendered overlay's page. `AppEnvironment` is the real one,
/// so the driver's controllers are the same ones every other web overlay uses.
@MainActor
public protocol WebOverlayHosting: AnyObject {
  /// Makes the overlay's page controller, if it has none, and loads `url`.
  func start(id: UUID, url: URL)
  /// Loads `url` into the controller the overlay already has.
  func load(id: UUID, url: URL)
  /// Stops and forgets the overlay's controller.
  func stop(id: UUID)
  /// Whether the overlay has a controller.
  func isRunning(id: UUID) -> Bool
}

/// What decides a scoreboard's page, apart from the overlays themselves.
public struct ScoreboardContext: Equatable, Sendable {
  /// The chosen event's quiet scoreboard, or nil with no event.
  public var live: URL?
  public var sample: URL
  public var editorOpen: Bool
  public var capturing: Bool

  public init(live: URL?, sample: URL, editorOpen: Bool, capturing: Bool) {
    self.live = live
    self.sample = sample
    self.editorOpen = editorOpen
    self.capturing = capturing
  }

  /// The page every scoreboard shows in this context.
  public var url: URL? {
    ScoreboardOverlaySource.url(
      live: live,
      sample: sample,
      editorOpen: editorOpen,
      capturing: capturing
    )
  }
}

/**
 * Keeps each Scoreboard content item's page on the URL its context resolves
 * to: started when it first resolves, reloaded when it changes, stopped when
 * it resolves to nothing, and left alone otherwise.
 *
 * A page that failed to load — Director offline when it started — is loaded
 * again every 10 s until a load succeeds or its URL changes. From then on the
 * page's own socket keeps it current.
 */
@MainActor
public final class ScoreboardOverlayDriver {
  public static let retrySeconds: TimeInterval = 10

  public typealias Schedule = @MainActor (
    TimeInterval,
    @escaping @MainActor () -> Void
  ) -> Void

  private weak var host: (any WebOverlayHosting)?
  private let schedule: Schedule
  /// The URL each scoreboard was last given.
  private var urls: [UUID: URL] = [:]

  public init(host: any WebOverlayHosting, schedule: @escaping Schedule = ScoreboardOverlayDriver.afterDelay) {
    self.host = host
    self.schedule = schedule
  }

  public static func afterDelay(
    _ seconds: TimeInterval,
    _ work: @escaping @MainActor () -> Void
  ) {
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      work()
    }
  }

  public func update(overlays: [ProgramOverlay], context: ScoreboardContext) {
    guard let host else { return }
    let ids = overlays.filter { $0.kind == .scoreboard }.map(\.id)
    // An overlay gone from the set is forgotten: when it comes back — a
    // template switched away and back — it starts again.
    for id in urls.keys where !ids.contains(id) { urls[id] = nil }
    let next = context.url
    for id in ids {
      let last = urls[id]
      urls[id] = next
      guard let next else {
        if last != nil || host.isRunning(id: id) { host.stop(id: id) }
        continue
      }
      if !host.isRunning(id: id) {
        host.start(id: id, url: next)
      } else if last != next {
        host.load(id: id, url: next)
      }
    }
  }

  /// The overlay's page failed to load. Tried again in 10 s, unless its URL
  /// has changed by then or it has gone.
  public func loadFailed(id: UUID) {
    guard let failed = urls[id] else { return }
    schedule(Self.retrySeconds) { [weak self] in
      guard let self, let host = self.host, self.urls[id] == failed, host.isRunning(id: id)
      else { return }
      host.load(id: id, url: failed)
    }
  }
}
