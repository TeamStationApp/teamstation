import Foundation
import Testing

@testable import DirectorSources

/// Answers probes from a table instead of the network, and writes down every probe: which host,
/// which port, and how many probes of the same host were in flight at once.
private final class FakeNetwork: @unchecked Sendable {
  private let lock = NSLock()
  private let open: [String: Set<Int>]
  private let delay: Duration
  private var inFlight: [String: Int] = [:]
  private var hostsInFlight = 0
  private var asked: [String: [Int]] = [:]
  private var order: [String] = []
  private(set) var mostPortsAtOnce = 0
  private(set) var mostHostsAtOnce = 0

  init(open: [String: Set<Int>] = [:], delay: Duration = .milliseconds(20)) {
    self.open = open
    self.delay = delay
  }

  var probe: SubnetScanner.Probe {
    { [self] host, port in
      lock.withLock {
        if inFlight[host, default: 0] == 0 {
          hostsInFlight += 1
          mostHostsAtOnce = max(mostHostsAtOnce, hostsInFlight)
        }
        inFlight[host, default: 0] += 1
        mostPortsAtOnce = max(mostPortsAtOnce, inFlight[host]!)
        asked[host, default: []].append(port)
        if !order.contains(host) { order.append(host) }
      }
      try? await Task.sleep(for: delay)
      return lock.withLock {
        inFlight[host]! -= 1
        if inFlight[host] == 0 { hostsInFlight -= 1 }
        return open[host]?.contains(port) == true ? .open : .closed
      }
    }
  }

  /// Every port each host was asked about, in the order asked.
  var askedPorts: [String: [Int]] { lock.withLock { asked } }
  /// Hosts in the order they were first asked.
  var hostOrder: [String] { lock.withLock { order } }
  var probeCount: Int { lock.withLock { asked.values.map(\.count).reduce(0, +) } }
}

/// A value a test changes while a sweep runs, read by the sweep before every batch.
private final class Changing<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Value
  private var reads = 0
  private var changes: [Int: Value] = [:]

  init(_ value: Value) {
    self.value = value
  }

  /// From the `read`th read on (1-based), the value is `next`.
  func change(onRead read: Int, to next: Value) {
    lock.withLock { changes[read] = next }
  }

  func read() -> Value {
    lock.withLock {
      reads += 1
      if let next = changes[reads] { value = next }
      return value
    }
  }
}

private func subnet(_ address: String, _ mask: String = "255.255.255.248") -> IPv4Subnet {
  IPv4Subnet(address: address, netmask: mask)!
}

@Suite("Subnet scanning while the ports change")
struct SubnetScanLiveTests {
  private let cameraPorts = [ 554, 8554, 5960 ]
  private let eventPorts = [ 47614, 47615 ]

  @Test("One address's ports are asked at the same time, so more ports do not lengthen the sweep")
  func portsOfOneHostAreConcurrent() async {
    let network = FakeNetwork(delay: .milliseconds(150))
    // 192.0.2.0/29 holds .1 to .6; this device is .1.
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let started = ContinuousClock.now
    let result = await scanner.scan(ports: cameraPorts + eventPorts)
    let took = ContinuousClock.now - started
    #expect(result.probedCount == 5)
    #expect(network.probeCount == 25)
    #expect(network.mostPortsAtOnce == 5)
    // Five addresses in one batch, each asked its five ports together: one probe's time, not five.
    #expect(took < .milliseconds(600), "took \(took)")
    #expect(result.askedPorts == Set(cameraPorts + eventPorts))
  }

  @Test("Pacing is unchanged: at most five addresses at a time outside the known ones")
  func pacingStillFiveAddressesAtATime() async {
    let network = FakeNetwork()
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1", "255.255.255.224")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(ports: cameraPorts)
    #expect(result.probedCount == 29)
    #expect(network.mostHostsAtOnce <= SubnetScanner.pacedBatchSize)
    #expect(Set(network.askedPorts.keys).count == 29)
  }

  @Test("Remembered addresses still go first")
  func priorityFirst() async {
    let network = FakeNetwork()
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1", "255.255.255.240")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    _ = await scanner.scan(priority: [ "192.0.2.12", "192.0.2.9" ], ports: cameraPorts)
    #expect(Array(network.hostOrder.prefix(2)).sorted() == [ "192.0.2.12", "192.0.2.9" ])
    // Each asked once, not again in the pass.
    #expect(network.askedPorts["192.0.2.12"]?.count == cameraPorts.count)
  }

  @Test("Ports added part-way are asked of the addresses still to come and caught up for those passed")
  func portsAddedMidSweep() async {
    // .2 answers an event port and is in the first batch; .13 answers one and comes after the change.
    let network = FakeNetwork(open: [
      "192.0.2.2": [ 47614 ],
      "192.0.2.13": [ 47615, 554 ]
    ])
    let ports = Changing(cameraPorts)
    // Read 1 is the first batch; from read 2 on, event control is on.
    ports.change(onRead: 2, to: cameraPorts + eventPorts)
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1", "255.255.255.240")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(priority: [], portsNow: { ports.read() })

    let asked = network.askedPorts
    #expect(asked.count == 13)
    for (host, ports) in asked {
      // Every address was asked every port in the end, and none twice.
      #expect(Set(ports) == Set(cameraPorts + eventPorts), "\(host)")
      #expect(ports.count == 5, "\(host) asked \(ports)")
    }
    #expect(result.portsByHost["192.0.2.2"] == [ 47614 ])
    #expect(result.portsByHost["192.0.2.13"] == [ 554, 47615 ])
    #expect(result.askedPorts == Set(cameraPorts + eventPorts))
    #expect(result.restricted(to: Set(eventPorts)).openHosts == [ "192.0.2.2", "192.0.2.13" ])
  }

  @Test("Ports removed part-way (recording started) are not asked of the rest, nor caught up")
  func portsRemovedMidSweep() async {
    let network = FakeNetwork()
    let ports = Changing(cameraPorts + eventPorts)
    ports.change(onRead: 2, to: cameraPorts)
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1", "255.255.255.240")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    _ = await scanner.scan(priority: [], portsNow: { ports.read() })
    let asked = network.askedPorts
    let withEventPorts = asked.filter { !Set($0.value).isDisjoint(with: eventPorts) }
    // Only the first batch, before the change.
    #expect(withEventPorts.count == SubnetScanner.pacedBatchSize)
    #expect(asked.values.allSatisfy { Set($0).isSuperset(of: cameraPorts) })
  }

  @Test("A subnet added part-way is swept by the same sweep")
  func subnetAddedMidSweep() async {
    let network = FakeNetwork(open: [ "198.51.100.3": [ 47614 ] ])
    let subnets = Changing([ subnet("192.0.2.1") ])
    subnets.change(onRead: 3, to: [ subnet("192.0.2.1"), subnet("198.51.100.0") ])
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { subnets.read() },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(priority: [], portsNow: { cameraPorts + eventPorts })
    #expect(network.askedPorts.keys.contains("198.51.100.6"))
    #expect(network.askedPorts.count == 5 + 6)
    // Two plans: one per list of subnets, not one per batch.
    #expect(scanner.lastScanPlanBuilds.withLock { $0 } == 2)
    #expect(result.openHosts == [ "198.51.100.3" ])
    #expect(result.subnet == "192.0.2.0/29,198.51.100.0/29")
  }

  @Test("A sweep makes its list of hosts once, not once per batch, while the subnets stay the same")
  func planMadeOncePerSweep() async {
    let network = FakeNetwork(delay: .zero)
    let reads = ProbeCount()
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: {
        _ = reads.next()
        return [subnet("192.0.2.1", "255.255.255.0"), subnet("198.51.100.1", "255.255.255.0")]
      },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(priority: [ "192.0.2.40" ], portsNow: { cameraPorts })
    // Every host of both /24s asked exactly once, the remembered one first.
    #expect(network.askedPorts.count == 253 + 253)
    #expect(network.askedPorts.values.allSatisfy { $0.count == cameraPorts.count })
    #expect(network.hostOrder.first == "192.0.2.40")
    #expect(result.probedCount == 506)
    // The subnets were still read before every batch, but the plan was made once.
    #expect(reads.next() > 100)
    #expect(scanner.lastScanPlanBuilds.withLock { $0 } == 1)
  }

  @Test("Stopping the sweeper ends a sweep still running at its next batch, not after a whole pass")
  func stoppedSweeperEndsItsRunningSweep() async {
    let network = FakeNetwork(delay: .zero)
    let holder = WeakSweeper()
    let probes = ProbeCount()
    // A /24: 253 addresses to ask.
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1", "255.255.255.0")] },
      gapMilliseconds: 0,
      probe: { host, port in
        // Stopped as the first batch is under way: event control joined the camera sweep.
        if probes.next() == 1 { holder.value?.stop() }
        return await network.probe(host, port)
      }
    )
    let sweeper = CameraSweeper(
      ports: cameraPorts,
      scan: { await scanner.scan(priority: $0, portsNow: $1) },
      probeKnown: { await scanner.probeKnown($0, ports: $1) },
      onResult: { _ in }
    )
    holder.value = sweeper
    await sweeper.runSweep()
    // The batch under way finishes; nothing after it is asked.
    #expect(network.askedPorts.count == SubnetScanner.pacedBatchSize)
    #expect(sweeper.sweepCount == 0)
  }

  @Test("No ports wanted at all: nothing is probed")
  func noPorts() async {
    let network = FakeNetwork()
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(priority: [ "192.0.2.3" ], portsNow: { [] })
    #expect(network.probeCount == 0)
    #expect(result.openHosts.isEmpty)
    #expect(result.askedPorts.isEmpty)
  }

  @Test("A remembered address outside the subnets is caught up too when a port is added")
  func knownOutsideSubnetCaughtUp() async {
    let network = FakeNetwork(open: [ "203.0.113.7": [ 47614 ] ])
    let ports = Changing(cameraPorts)
    ports.change(onRead: 2, to: cameraPorts + eventPorts)
    let scanner = SubnetScanner(
      ports: cameraPorts,
      subnets: { [subnet("192.0.2.1")] },
      gapMilliseconds: 0,
      probe: network.probe
    )
    let result = await scanner.scan(priority: [ "203.0.113.7" ], portsNow: { ports.read() })
    #expect(Set(network.askedPorts["203.0.113.7"] ?? []) == Set(cameraPorts + eventPorts))
    #expect(result.portsByHost["203.0.113.7"] == [ 47614 ])
  }
}

@Suite("Camera sweeper while the ports change")
struct CameraSweeperLiveTests {
  private let cameraPorts = [ 554, 8554, 5960 ]
  private let eventPorts = [ 47614, 47615 ]

  /// A sweep that reads its ports twice — before its first batch and before its last — and runs
  /// `between` in the middle, as a toggle flipped part-way through would.
  private final class TwoBatchSweep: @unchecked Sendable {
    private let lock = NSLock()
    private var reads: [[Int]] = []
    var between: @Sendable () -> Void = {}
    var table: [String: Set<Int>] = [:]

    var reported: [[Int]] { lock.withLock { reads } }

    var scan: CameraSweeper.Scan {
      { [self] _, portsNow in
        let first = portsNow()
        between()
        let second = portsNow()
        lock.withLock { reads.append(contentsOf: [ first, second ]) }
        var open: [String: Set<Int>] = [:]
        for (host, ports) in table {
          let answered = ports.intersection(first + second)
          if !answered.isEmpty { open[host] = answered }
        }
        return SubnetScanner.Result(
          openHosts: open.keys.sorted(),
          probedCount: 254,
          subnet: "192.0.2.0/24",
          diagnostic: nil,
          portsByHost: open,
          askedPorts: Set(first + second)
        )
      }
    }
  }

  @Test("Turned on part-way, a participant is served by the running sweep and its request needs no second one")
  func participantOnMidSweep() async throws {
    let fake = TwoBatchSweep()
    fake.table = [ "192.0.2.20": [ 47614 ], "192.0.2.10": [ 554 ] ]
    let participant = FakeParticipant(ports: [])
    let results = SweepResults()
    let sweeper = CameraSweeper(
      ports: cameraPorts,
      scan: fake.scan,
      probeKnown: { _, _ in SubnetScanner.Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: nil) },
      onResult: { results.append($0) }
    )
    sweeper.addParticipant(participant)
    fake.between = { [weak sweeper] in
      participant.setPorts([ 47614, 47615 ])
      sweeper?.sweepSoon()
    }
    // Browsing: a sweep every ten seconds, so only an outright request would bring another sooner.
    sweeper.setBrowsing(true)
    sweeper.start()
    defer { sweeper.stop() }
    #expect(await waitUntil { participant.received.count == 1 })
    #expect(fake.reported.first == cameraPorts)
    #expect(fake.reported.dropFirst().first == cameraPorts + eventPorts)
    #expect(participant.received.first?.openHosts == [ "192.0.2.20" ])
    #expect(results.all.first?.openHosts == [ "192.0.2.10" ])
    #expect(sweeper.diagnostic.contains("extraPorts=1"))
    try await Task.sleep(for: .milliseconds(1_500))
    #expect(sweeper.sweepCount == 1)
  }

  @Test("A request made after the running sweep last read its ports still gets a sweep of its own")
  func requestAfterLastReadSweepsAgain() async {
    let fake = TwoBatchSweep()
    let box = WeakSweeper()
    let once = OnceFlag()
    let sweeper = CameraSweeper(
      ports: cameraPorts,
      scan: { [fake] priority, portsNow in
        let result = await fake.scan(priority, portsNow)
        // After both reads: this sweep cannot have taken it in.
        if once.claim() { box.value?.sweepSoon() }
        return result
      },
      probeKnown: { _, _ in SubnetScanner.Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: nil) },
      onResult: { _ in }
    )
    box.value = sweeper
    sweeper.addParticipant(FakeParticipant(ports: eventPorts))
    sweeper.setBrowsing(true)
    sweeper.start()
    defer { sweeper.stop() }
    #expect(await waitUntil { sweeper.sweepCount >= 2 })
  }

  @Test("A request while a sweep that already carried the event ports runs gets a fresh sweep at once")
  func requestDuringEventSweepSweepsAgain() async {
    let fake = TwoBatchSweep()
    let participant = FakeParticipant(ports: eventPorts)
    let box = WeakSweeper()
    let once = OnceFlag()
    fake.between = {
      // Turned off and on again part-way, as a sign-in or a toggle would: asked between reads.
      if once.claim() { box.value?.sweepSoon() }
    }
    let sweeper = CameraSweeper(
      ports: cameraPorts,
      scan: fake.scan,
      probeKnown: { _, _ in SubnetScanner.Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: nil) },
      onResult: { _ in }
    )
    box.value = sweeper
    sweeper.addParticipant(participant)
    sweeper.setBrowsing(true)
    sweeper.start()
    defer { sweeper.stop() }
    // The addresses the first sweep passed were asked before the request: a second sweep follows
    // straight away rather than after the ten-second gap.
    #expect(await waitUntil(3) { sweeper.sweepCount >= 2 })
  }

  @Test("Recording starting part-way drops the event ports from the rest of the sweep")
  func busyMidSweep() async {
    let fake = TwoBatchSweep()
    let participant = FakeParticipant(ports: eventPorts)
    let sweeper = CameraSweeper(
      ports: cameraPorts,
      scan: fake.scan,
      probeKnown: { _, _ in SubnetScanner.Result(openHosts: [], probedCount: 0, subnet: "", diagnostic: nil) },
      onResult: { _ in }
    )
    sweeper.addParticipant(participant)
    fake.between = { [weak sweeper] in
      sweeper?.setDemand(isBusy: true, anyEnabledCameraMissing: true)
    }
    await sweeper.runSweep()
    #expect(fake.reported == [ cameraPorts + eventPorts, cameraPorts ])
  }
}

private final class OnceFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.withLock {
      defer { claimed = true }
      return !claimed
    }
  }
}

private final class WeakSweeper: @unchecked Sendable {
  weak var value: CameraSweeper?
}

private final class ProbeCount: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  func next() -> Int {
    lock.withLock {
      count += 1
      return count
    }
  }
}
