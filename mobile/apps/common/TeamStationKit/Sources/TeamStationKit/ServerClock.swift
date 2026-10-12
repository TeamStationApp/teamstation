import Foundation
import Synchronization

/// One measurement of how far the server's clock is from this device's.
public struct ServerClockSample: Sendable, Equatable {
  /// When it was taken: the middle of the round trip it was read from, on the device clock the
  /// offset is measured against.
  public let wall: Date
  /// The server's clock less the device's, in milliseconds. Positive when the server is ahead.
  public let offsetMs: Int
  /// How long the request took there and back. The offset is right to within half of it.
  public let rttMs: Int

  public init(wall: Date, offsetMs: Int, rttMs: Int) {
    self.wall = wall
    self.offsetMs = offsetMs
    self.rttMs = rttMs
  }
}

/// How far the server's clock is from this device's, measured with `GET /api/v1/time`.
///
/// A take is placed on the game's timeline by the device's clock, and the game's scoring is stamped
/// on the server's. The two agree only as well as the device's clock does, which on an iPad at a
/// field is whatever NTP last managed, and the steady wall clock the live path reads (`SteadyWall`)
/// does not follow NTP at all after launch. Measuring the difference while a take is made lets
/// every upload of it say how far off it was, and the server puts it right.
///
/// One measurement is five requests, one after another, of which the one with the shortest round
/// trip is kept: a slow answer is slow on one leg or the other, and the offset is the server's
/// reading less the middle of the trip, so the shortest trip has the least room to be wrong.
///
/// Measured at sign-in, then every sixty seconds while `follow(true)` holds: Director follows while
/// a take linked to an event is recording or streaming.
public final class ServerClock: Sendable {
  /// Requests per measurement.
  public static let tripsPerSample = 5
  /// The wait between measurements while following.
  public static let interval: Duration = .seconds(60)

  /// One request: the device clock either side of it, and the server's clock in between.
  public struct Trip: Sendable, Equatable {
    public var sent: Date
    public var serverMs: Double
    public var received: Date

    public init(sent: Date, serverMs: Double, received: Date) {
      self.sent = sent
      self.serverMs = serverMs
      self.received = received
    }
  }

  private struct State: Sendable {
    var latest: ServerClockSample?
    var follower: Task<Void, Never>?
  }

  private let fetch: @Sendable () async throws -> Double
  private let now: @Sendable () -> Date
  private let sleep: (@Sendable (Duration) async throws -> Void)?
  private let onSample: @Sendable (ServerClockSample) -> Void
  private let state = Mutex(State())

  /// `fetch` reads the server's clock in milliseconds since 1970; `now` is the device clock the
  /// offset is measured against; `onSample` hears every measurement, which Director writes to its
  /// index. `sleep` stands in for the wait between measurements, for tests.
  public init(
    fetch: @escaping @Sendable () async throws -> Double,
    now: @escaping @Sendable () -> Date = { Date() },
    sleep: (@Sendable (Duration) async throws -> Void)? = nil,
    onSample: @escaping @Sendable (ServerClockSample) -> Void = { _ in }
  ) {
    self.fetch = fetch
    self.now = now
    self.sleep = sleep
    self.onSample = onSample
  }

  /// Measured against `client`'s server, with no sign-in.
  public convenience init(
    client: TeamStationClient,
    now: @escaping @Sendable () -> Date = { Date() },
    onSample: @escaping @Sendable (ServerClockSample) -> Void = { _ in }
  ) {
    self.init(fetch: { try await client.serverTime() }, now: now, onSample: onSample)
  }

  /// The last measurement, or nil before the first that got an answer.
  public var latest: ServerClockSample? { state.withLock { $0.latest } }

  /// The last measured offset in milliseconds, or nil when none has been measured.
  public var offsetMs: Int? { latest?.offsetMs }

  /// Whether it is measuring every `interval`.
  public var isFollowing: Bool { state.withLock { $0.follower != nil } }

  /// Measures once: five requests, the shortest round trip kept. Nil, and nothing kept, when none
  /// of them was answered.
  @discardableResult
  public func measure() async -> ServerClockSample? {
    var trips: [Trip] = []
    for _ in 0 ..< Self.tripsPerSample {
      if Task.isCancelled { break }
      let sent = now()
      guard let serverMs = try? await fetch() else { continue }
      trips.append(Trip(sent: sent, serverMs: serverMs, received: now()))
    }
    guard let sample = Self.best(of: trips) else { return nil }
    state.withLock { $0.latest = sample }
    onSample(sample)
    return sample
  }

  /// The sample the trip with the shortest round trip gives, the earliest of equals: the server's
  /// reading less the middle of the trip.
  public static func best(of trips: [Trip]) -> ServerClockSample? {
    func rttMs(_ trip: Trip) -> Double {
      (trip.received.timeIntervalSince1970 - trip.sent.timeIntervalSince1970) * 1000
    }
    guard let trip = trips.min(by: { rttMs($0) < rttMs($1) }) else { return nil }
    let middleMs = (trip.sent.timeIntervalSince1970 + trip.received.timeIntervalSince1970) * 500
    return ServerClockSample(
      wall: Date(timeIntervalSince1970: middleMs / 1000),
      offsetMs: Int((trip.serverMs - middleMs).rounded()),
      rttMs: Int(rttMs(trip).rounded())
    )
  }

  /// Starts measuring now and every `interval` after, or stops. Starting while already following,
  /// or stopping while not, changes nothing.
  public func follow(_ on: Bool) {
    state.withLock { state in
      if on {
        guard state.follower == nil else { return }
        state.follower = Task { [self] in await self.run() }
      } else {
        state.follower?.cancel()
        state.follower = nil
      }
    }
  }

  private func run() async {
    while !Task.isCancelled {
      await measure()
      do {
        // `Task.sleep` called here, never through a stored function value: cancelling it through
        // one (`sleep: Task.sleep(for:)` as a default) crashed the Swift 6 runtime's task allocator
        // with "freed pointer was not the last allocation".
        if let sleep {
          try await sleep(Self.interval)
        } else {
          try await Task.sleep(for: Self.interval)
        }
      } catch {
        return
      }
    }
  }
}
