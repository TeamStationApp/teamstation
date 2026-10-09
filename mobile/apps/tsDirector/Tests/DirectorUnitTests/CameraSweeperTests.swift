import Foundation
import Testing
import DirectorSources

/// A sweep with no network under it: answers each pass from a table of host → open ports, and
/// writes down the ports every pass asked about.
final class FakeSweep: @unchecked Sendable {
  private let lock = NSLock()
  private var table: [String: Set<Int>]
  private var asked: [[Int]] = []
  private var priorities: [[String]] = []
  private var known: [[String]] = []
  var diagnostic: String?
  var denied = false

  init(_ table: [String: Set<Int>] = [:]) {
    self.table = table
  }

  func set(_ host: String, _ ports: Set<Int>?) {
    lock.withLock { table[host] = ports }
  }

  var askedPorts: [[Int]] { lock.withLock { asked } }
  var askedPriorities: [[String]] { lock.withLock { priorities } }
  var knownProbes: [[String]] { lock.withLock { known } }

  var scan: CameraSweeper.Scan {
    { [self] priority, portsNow in
      let ports = portsNow()
      return lock.withLock {
        asked.append(ports)
        priorities.append(priority)
        return answer(ports, hosts: Array(table.keys))
      }
    }
  }

  var probeKnown: CameraSweeper.KnownProbe {
    { [self] addresses, ports in
      lock.withLock {
        known.append(addresses)
        return answer(ports, hosts: addresses)
      }
    }
  }

  private func answer(_ ports: [Int], hosts: [String]) -> SubnetScanner.Result {
    var open: [String: Set<Int>] = [:]
    for host in hosts {
      let answered = (table[host] ?? []).intersection(ports)
      if !answered.isEmpty { open[host] = answered }
    }
    return SubnetScanner.Result(
      openHosts: open.keys.sorted(),
      probedCount: 254,
      subnet: "192.0.2.0/24",
      diagnostic: diagnostic,
      portsByHost: open,
      localNetworkDenied: denied
    )
  }
}

/// A participant whose ports a test sets, and which writes down every answer it is handed.
final class FakeParticipant: SweepParticipant, @unchecked Sendable {
  private let lock = NSLock()
  private var ports: [Int]
  private var results: [SubnetScanner.Result] = []

  init(ports: [Int]) {
    self.ports = ports
  }

  var extraSweepPorts: [Int] { lock.withLock { ports } }

  func setPorts(_ next: [Int]) {
    lock.withLock { ports = next }
  }

  func acceptSweep(_ result: SubnetScanner.Result) {
    lock.withLock { results.append(result) }
  }

  var received: [SubnetScanner.Result] { lock.withLock { results } }
}

/// Collects what a sweeper hands the cameras.
final class SweepResults: @unchecked Sendable {
  private let lock = NSLock()
  private var results: [SubnetScanner.Result] = []

  func append(_ result: SubnetScanner.Result) {
    lock.withLock { results.append(result) }
  }

  var all: [SubnetScanner.Result] { lock.withLock { results } }
}

func waitUntil(
  _ seconds: TimeInterval = 5,
  _ condition: () async -> Bool
) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(20))
  }
  return await condition()
}

@Suite("Camera sweeper")
struct CameraSweeperTests {
  private let cameraPorts = [ 554, 8554, 5960 ]
  private let eventPorts = [ 47614, 47615 ]

  private func sweeper(
    _ fake: FakeSweep,
    ports: [Int]? = nil,
    persistenceKey: String? = nil,
    results: SweepResults = SweepResults()
  ) -> CameraSweeper {
    CameraSweeper(
      ports: ports ?? cameraPorts,
      persistenceKey: persistenceKey,
      scan: fake.scan,
      probeKnown: fake.probeKnown,
      onResult: { results.append($0) }
    )
  }

  @Test("With no participant a sweep asks exactly the cameras' ports, as before")
  func noParticipantAsksCameraPortsOnly() async {
    let fake = FakeSweep([ "192.0.2.10": [ 554 ] ])
    let results = SweepResults()
    let sweeper = sweeper(fake, results: results)
    await sweeper.runSweep()
    #expect(fake.askedPorts == [ cameraPorts ])
    #expect(results.all.last?.openHosts == [ "192.0.2.10" ])
    #expect(sweeper.diagnostic.hasPrefix("sweeps=1 found=1"))
    #expect(!sweeper.diagnostic.contains("extraPorts"))
    // How long it took, for measuring sweeps on a device.
    #expect(sweeper.diagnostic.contains(" took=0.0s"))
  }

  @Test("A participant's ports join the one sweep, and each answer goes to whoever asked")
  func routesByPort() async throws {
    let fake = FakeSweep([
      "192.0.2.10": [ 554 ],
      "192.0.2.20": [ 47614 ],
      "192.0.2.30": [ 8554, 47615 ]
    ])
    let results = SweepResults()
    let sweeper = sweeper(fake, results: results)
    let participant = FakeParticipant(ports: eventPorts)
    sweeper.addParticipant(participant)
    sweeper.addParticipant(participant)
    await sweeper.runSweep()

    #expect(fake.askedPorts == [ cameraPorts + eventPorts ])
    // The cameras never see an event port, and the participant never sees a camera port.
    let cameras = try #require(results.all.last)
    #expect(cameras.openHosts == [ "192.0.2.10", "192.0.2.30" ])
    #expect(cameras.portsByHost == [ "192.0.2.10": [ 554 ], "192.0.2.30": [ 8554 ] ])
    let events = try #require(participant.received.last)
    #expect(participant.received.count == 1)
    #expect(events.openHosts == [ "192.0.2.20", "192.0.2.30" ])
    #expect(events.portsByHost == [ "192.0.2.20": [ 47614 ], "192.0.2.30": [ 47615 ] ])
    #expect(sweeper.diagnostic.contains("extraPorts=1"))
  }

  @Test("A host that answered only on an event port is neither remembered nor counted as a camera")
  func eventOnlyHostsAreNotCameras() async {
    let key = "test.sweeper.remembered.\(UUID().uuidString)"
    defer { UserDefaults.standard.removeObject(forKey: key) }
    let fake = FakeSweep([ "192.0.2.20": [ 47614 ] ])
    let sweeper = sweeper(fake, persistenceKey: key)
    sweeper.addParticipant(FakeParticipant(ports: eventPorts))
    await sweeper.runSweep()
    #expect(sweeper.diagnostic.hasPrefix("sweeps=1 found=0"))
    #expect(UserDefaults.standard.stringArray(forKey: key) == nil)

    // The next sweep's head start is cameras only, too.
    fake.set("192.0.2.10", [ 554 ])
    await sweeper.runSweep()
    #expect(UserDefaults.standard.stringArray(forKey: key) == [ "192.0.2.10" ])
    await sweeper.runSweep()
    #expect(fake.askedPriorities.last == [ "192.0.2.10" ])
  }

  @Test("Ports are read at the start of each sweep: on, off and on again without a restart")
  func portsReadPerSweep() async {
    let fake = FakeSweep()
    let sweeper = sweeper(fake)
    let participant = FakeParticipant(ports: [])
    sweeper.addParticipant(participant)
    await sweeper.runSweep()
    participant.setPorts(eventPorts)
    await sweeper.runSweep()
    participant.setPorts([])
    await sweeper.runSweep()
    #expect(fake.askedPorts == [ cameraPorts, cameraPorts + eventPorts, cameraPorts ])
    // Only the sweep that asked about its ports reached it.
    #expect(participant.received.count == 1)
  }

  @Test("While recording or streaming the sweep asks exactly what it did before event control")
  func busySweepLeavesEventPortsOut() async {
    let fake = FakeSweep([ "192.0.2.20": [ 47614 ] ])
    let sweeper = sweeper(fake)
    let participant = FakeParticipant(ports: eventPorts)
    sweeper.addParticipant(participant)
    sweeper.setDemand(isBusy: true, anyEnabledCameraMissing: true)
    await sweeper.runSweep()
    #expect(fake.askedPorts == [ cameraPorts ])
    #expect(participant.received.isEmpty)
    sweeper.setDemand(isBusy: false, anyEnabledCameraMissing: false)
    await sweeper.runSweep()
    #expect(fake.askedPorts.last == cameraPorts + eventPorts)
    #expect(participant.received.count == 1)
  }

  @Test("A sweeper with no camera ports runs only for its participants, and not at all without one")
  func eventOnlySweeper() async {
    let fake = FakeSweep([ "192.0.2.20": [ 47614 ] ])
    let results = SweepResults()
    let sweeper = sweeper(fake, ports: [], results: results)
    await sweeper.runSweep()
    #expect(fake.askedPorts.isEmpty)
    let participant = FakeParticipant(ports: eventPorts)
    sweeper.addParticipant(participant)
    await sweeper.runSweep()
    #expect(fake.askedPorts == [ eventPorts ])
    #expect(results.all.isEmpty)
    #expect(participant.received.last?.openHosts == [ "192.0.2.20" ])
  }

  @Test("A participant that has gone away drops out of the sweep")
  func participantsAreHeldWeakly() async {
    let fake = FakeSweep()
    let sweeper = sweeper(fake)
    var participant: FakeParticipant? = FakeParticipant(ports: eventPorts)
    sweeper.addParticipant(participant!)
    participant = nil
    await sweeper.runSweep()
    #expect(fake.askedPorts == [ cameraPorts ])
  }

  @Test("The participant list holds each once and lets go of those that have gone")
  func participantList() {
    var list = SweepParticipantList()
    let kept = FakeParticipant(ports: eventPorts)
    var gone: FakeParticipant? = FakeParticipant(ports: [ 47615 ])
    list.add(kept)
    list.add(gone!)
    list.add(kept)
    #expect(list.current().count == 2)
    #expect(list.current().last === kept)
    gone = nil
    #expect(list.current().count == 1)
    #expect(list.current().first === kept)
  }

  @Test("A stopped sweeper keeps nothing from a sweep that finishes after it stopped")
  func stoppedSweepIsDiscarded() async {
    let fake = FakeSweep([ "192.0.2.10": [ 554 ] ])
    let results = SweepResults()
    let sweeper = sweeper(fake, results: results)
    sweeper.stop()
    await sweeper.runSweep()
    #expect(results.all.isEmpty)
    #expect(sweeper.sweepCount == 0)
  }

  @Test("Running, a participant that wants discovery is swept for at once and on request")
  func loopSweepsForParticipant() async {
    let fake = FakeSweep([ "192.0.2.20": [ 47614 ] ])
    let sweeper = sweeper(fake)
    let participant = FakeParticipant(ports: eventPorts)
    sweeper.addParticipant(participant)
    sweeper.start()
    sweeper.start()
    defer { sweeper.stop() }
    #expect(await waitUntil { participant.received.count == 1 })
    // The next comes after thirty seconds, unless one is asked for.
    sweeper.sweepSoon()
    #expect(await waitUntil { participant.received.count == 2 })
    #expect(sweeper.sweepCount == 2)
  }

  @Test("Running with nothing to look for, the sweeper does not sweep")
  func loopIdlesWithoutDemand() async throws {
    let fake = FakeSweep()
    let sweeper = sweeper(fake)
    sweeper.addParticipant(FakeParticipant(ports: []))
    sweeper.start()
    try await Task.sleep(for: .milliseconds(1_300))
    sweeper.stop()
    #expect(fake.askedPorts.isEmpty)
  }

  @Test("At launch only the cameras remembered are asked, and only on camera ports")
  func probeRememberedAsksCameraPorts() async {
    let key = "test.sweeper.launch.\(UUID().uuidString)"
    UserDefaults.standard.set([ "192.0.2.10" ], forKey: key)
    defer { UserDefaults.standard.removeObject(forKey: key) }
    let fake = FakeSweep([ "192.0.2.10": [ 554 ] ])
    let results = SweepResults()
    let sweeper = sweeper(fake, persistenceKey: key, results: results)
    sweeper.addParticipant(FakeParticipant(ports: []))
    sweeper.start()
    defer { sweeper.stop() }
    #expect(await waitUntil { results.all.count == 1 })
    #expect(fake.knownProbes == [ [ "192.0.2.10" ] ])
    #expect(sweeper.diagnostic.contains("known=1"))
  }
}
