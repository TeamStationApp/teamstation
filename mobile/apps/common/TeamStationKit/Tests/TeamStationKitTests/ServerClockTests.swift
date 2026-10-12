import Foundation
import Synchronization
import Testing

@testable import TeamStationKit

/// A device clock and a server that answer from a script: each request reads the device clock once
/// before and once after, and the server says what the script says.
private final class ScriptedTrips: Sendable {
  /// `(sent, server, received)` in milliseconds, one per request; a nil server reading fails it.
  private let script: Mutex<[(sent: Double, server: Double?, received: Double)]>
  /// The device clock's readings, in the order they are taken: before and after each request.
  private let readings: Mutex<[Double]>
  let fetched = Mutex(0)

  init(_ script: [(sent: Double, server: Double?, received: Double)]) {
    self.script = Mutex(script)
    readings = Mutex(script.flatMap { [ $0.sent, $0.received ] })
  }

  var now: @Sendable () -> Date {
    { [self] in
      let ms = readings.withLock { $0.isEmpty ? 0 : $0.removeFirst() }
      return Date(timeIntervalSince1970: ms / 1000)
    }
  }

  var fetch: @Sendable () async throws -> Double {
    { [self] in
      fetched.withLock { $0 += 1 }
      let next = script.withLock { $0.isEmpty ? nil : $0.removeFirst() }
      guard let next, let server = next.server else {
        // A failed request reads the clock before it and not after: its second reading goes.
        _ = readings.withLock { $0.isEmpty ? nil : $0.removeFirst() }
        throw URLError(.timedOut)
      }
      return server
    }
  }
}

/// A sleep that returns only when the test lets it, and writes down how long it was asked for.
private final class Gate: Sendable {
  private let waiting = Mutex<[CheckedContinuation<Void, Never>]>([])
  let asked = Mutex<[Duration]>([])

  var sleep: @Sendable (Duration) async throws -> Void {
    { [self] duration in
      asked.withLock { $0.append(duration) }
      await withCheckedContinuation { continuation in
        waiting.withLock { $0.append(continuation) }
      }
    }
  }

  var sleepers: Int { waiting.withLock { $0.count } }

  func open() {
    let next = waiting.withLock { $0.isEmpty ? nil : $0.removeFirst() }
    next?.resume()
  }
}

/// Waits for `condition`, a little at a time, for at most two seconds.
private func eventually(_ condition: @Sendable () -> Bool) async -> Bool {
  for _ in 0 ..< 400 {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return condition()
}

/// The server's `/api/v1/time`, answering whatever `now` holds.
private final class TimeServer: URLProtocol, @unchecked Sendable {
  nonisolated(unsafe) static var reply = #"{"now":1789672609123}"#
  nonisolated(unsafe) static var status = 200
  nonisolated(unsafe) static var asked: [(path: String, authorization: String?)] = []

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.asked.append((request.url?.path ?? "", request.value(forHTTPHeaderField: "authorization")))
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: Self.status,
      httpVersion: nil,
      headerFields: [ "content-type": "application/json" ]
    )!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(Self.reply.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}

@Suite("Measuring the server's clock", .serialized)
struct ServerClockTests {
  // MARK: - S1: the lowest round trip and its offset

  @Test("The trip with the shortest round trip gives the offset, from the middle of the trip")
  func keepsTheShortestTrip() async throws {
    let trips = ScriptedTrips([
      (sent: 1_000, server: 1_400, received: 1_300),  // 300 ms there and back
      (sent: 2_000, server: 2_540, received: 2_080),  // 80 ms: the one kept
      (sent: 3_000, server: 3_700, received: 3_200),
      (sent: 4_000, server: 4_600, received: 4_120),
      (sent: 5_000, server: 5_900, received: 5_500)
    ])
    let heard = Mutex<[ServerClockSample]>([])
    let clock = ServerClock(fetch: trips.fetch, now: trips.now, onSample: { sample in
      heard.withLock { $0.append(sample) }
    })

    let sample = try #require(await clock.measure())

    // The middle of the 80 ms trip is 2040; the server read 2540 then.
    #expect(sample.offsetMs == 500)
    #expect(sample.rttMs == 80)
    #expect(sample.wall == Date(timeIntervalSince1970: 2.04))
    #expect(trips.fetched.withLock { $0 } == ServerClock.tripsPerSample)
    #expect(clock.offsetMs == 500)
    #expect(clock.latest == sample)
    #expect(heard.withLock { $0 } == [ sample ])
  }

  @Test("A server behind the device gives a negative offset")
  func serverBehind() {
    let sample = ServerClock.best(of: [
      ServerClock.Trip(
        sent: Date(timeIntervalSince1970: 10),
        serverMs: 9_750,
        received: Date(timeIntervalSince1970: 10.1)
      )
    ])
    #expect(sample?.offsetMs == -300)
    #expect(sample?.rttMs == 100)
  }

  @Test("Of equal round trips the first is kept")
  func firstOfEquals() {
    let sample = ServerClock.best(of: [
      ServerClock.Trip(sent: Date(timeIntervalSince1970: 1), serverMs: 1_100, received: Date(timeIntervalSince1970: 1.1)),
      ServerClock.Trip(sent: Date(timeIntervalSince1970: 2), serverMs: 2_900, received: Date(timeIntervalSince1970: 2.1))
    ])
    #expect(sample?.offsetMs == 50)
  }

  @Test("Failed requests are left out, and nothing answered keeps nothing")
  func failures() async throws {
    let some = ScriptedTrips([
      (sent: 0, server: nil, received: 0),
      (sent: 1_000, server: 1_210, received: 1_020),
      (sent: 0, server: nil, received: 0),
      (sent: 0, server: nil, received: 0),
      (sent: 0, server: nil, received: 0)
    ])
    let clock = ServerClock(fetch: some.fetch, now: some.now)
    #expect(await clock.measure()?.offsetMs == 200)

    let none = ScriptedTrips(Array(repeating: (sent: 0, server: nil, received: 0), count: 5))
    let silent = ServerClock(fetch: none.fetch, now: none.now)
    #expect(await silent.measure() == nil)
    #expect(silent.offsetMs == nil)
    #expect(silent.latest == nil)
  }

  @Test("The server's clock is read from GET /api/v1/time, with no sign-in")
  func readsTheTimeRoute() async throws {
    TimeServer.asked = []
    TimeServer.status = 200
    TimeServer.reply = #"{"now":1789672609123}"#
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ TimeServer.self ]
    let client = TeamStationClient(
      baseURL: URL(string: "https://teamstation.example")!,
      session: URLSession(configuration: configuration)
    )

    #expect(try await client.serverTime() == 1_789_672_609_123)
    #expect(TimeServer.asked.first?.path == "/api/v1/time")
    #expect(TimeServer.asked.first?.authorization == nil)

    // Measured through the client, every trip asks the route.
    let clock = ServerClock(client: client)
    let sample = try #require(await clock.measure())
    #expect(TimeServer.asked.count == 1 + ServerClock.tripsPerSample)
    #expect(sample.rttMs >= 0)
  }

  @Test("A server without the route measures nothing")
  func olderServer() async {
    TimeServer.asked = []
    TimeServer.status = 404
    TimeServer.reply = #"{"code":"notFound","message":"no such route"}"#
    defer { TimeServer.status = 200 }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ TimeServer.self ]
    let clock = ServerClock(
      client: TeamStationClient(
        baseURL: URL(string: "https://teamstation.example")!,
        session: URLSession(configuration: configuration)
      )
    )
    #expect(await clock.measure() == nil)
  }

  // MARK: - S2: the sampling schedule and stopping

  @Test("Following measures at once, then once a minute, until it is stopped")
  func followsUntilStopped() async throws {
    let gate = Gate()
    let measured = Mutex(0)
    let clock = ServerClock(
      fetch: { 1_000 },
      now: { Date(timeIntervalSince1970: 0) },
      sleep: gate.sleep,
      onSample: { _ in measured.withLock { $0 += 1 } }
    )
    #expect(!clock.isFollowing)

    clock.follow(true)
    #expect(clock.isFollowing)
    // Measured straight away, then waiting a minute.
    #expect(await eventually { measured.withLock { $0 } == 1 && gate.sleepers == 1 })
    #expect(gate.asked.withLock { $0 } == [ .seconds(60) ])

    // Following again while following starts no second schedule.
    clock.follow(true)
    gate.open()
    #expect(await eventually { measured.withLock { $0 } == 2 && gate.sleepers == 1 })
    #expect(gate.asked.withLock { $0 } == [ .seconds(60), .seconds(60) ])

    clock.follow(false)
    #expect(!clock.isFollowing)
    // The minute that was running ends, and nothing more is measured.
    gate.open()
    try await Task.sleep(for: .milliseconds(50))
    #expect(measured.withLock { $0 } == 2)
    #expect(gate.sleepers == 0)

    // Stopping when stopped changes nothing; following again starts over at once.
    clock.follow(false)
    clock.follow(true)
    #expect(await eventually { measured.withLock { $0 } == 3 })
    clock.follow(false)
    gate.open()
  }

  @Test("A sleep that is cancelled ends the schedule")
  func cancelledSleep() async throws {
    let measured = Mutex(0)
    let clock = ServerClock(
      fetch: { 1_000 },
      sleep: { _ in throw CancellationError() },
      onSample: { _ in measured.withLock { $0 += 1 } }
    )
    clock.follow(true)
    #expect(await eventually { measured.withLock { $0 } == 1 })
    try await Task.sleep(for: .milliseconds(30))
    #expect(measured.withLock { $0 } == 1)
    clock.follow(false)
  }

  @Test("The real sleep waits the interval and stops when cancelled")
  func realSleep() async throws {
    let measured = Mutex(0)
    let clock = ServerClock(fetch: { 1_000 }, onSample: { _ in measured.withLock { $0 += 1 } })
    clock.follow(true)
    #expect(await eventually { measured.withLock { $0 } == 1 })
    clock.follow(false)
    try await Task.sleep(for: .milliseconds(30))
    #expect(measured.withLock { $0 } == 1)
  }
}
