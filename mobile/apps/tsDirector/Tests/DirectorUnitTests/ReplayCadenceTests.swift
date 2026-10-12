@testable import DirectorMedia
@testable import DirectorPipeline
import Foundation
import Testing

/// A replay shows every picture once, in tape order, at its own moment, whatever the camera's frame
/// rate: a 30 fps camera at full speed is 30 pictures a second, each held two programme ticks.
@Suite("Replay cadence")
struct ReplayCadenceTests {
  @Test("A picture is due at its tape time over the rate, from the anchor")
  func dueAndMedia() {
    let cadence = ReplayCadence(anchorWall: 100, anchorMedia: 20, rate: 0.5)
    #expect(cadence.due(media: 21) == 102)
    #expect(cadence.media(at: 104) == 22)
    #expect(ReplayCadence(anchorWall: 0, anchorMedia: 0, rate: 0).rate == ReplayCadence.minimumRate)
  }

  /// Pumps a replay of `tape` (tape times, in order) every 4 ms with up to `jitter` of timer error, as
  /// the decoder does, handing pictures on `lead` before their moment, into a programme queue picked
  /// on an exact 60 Hz tick; returns the tape time on air at each tick.
  static func run(
    tape: [Double], rate: Double, jitter: Double, seconds: Double, seed: UInt64 = 7,
    phase: Double = 0.006, lead: Double = ReplayCadence.leadSeconds
  ) -> [Double] {
    var generator = SplitMix(seed)
    var queue = ProgrammePictureQueue<Double>(delaySeconds: 1)
    var upcoming = tape[...]
    let first = upcoming.removeFirst()
    // The replay's first moment sits `phase` before a programme tick.
    let start = 1_000.0 + 1 / 60 - phase
    let cadence = ReplayCadence(anchorWall: start, anchorMedia: first, rate: rate)
    queue.add(first, capture: nil, due: start)
    var pump = start
    var tick = 1_000.0 + 2 / 60
    var shown: [Double] = []
    while tick < start + seconds {
      // Only pumps that ran before the tick: what they handed on is what the tick can take.
      while true {
        let next = pump + 0.004 + (generator.unit() - 0.5) * 2 * jitter
        if next >= tick { break }
        pump = next
        let reached = cadence.media(at: pump + lead) + 1e-9
        var chosen: Double?
        while let next = upcoming.first, next <= reached { chosen = upcoming.removeFirst() }
        if let chosen { queue.add(chosen, capture: nil, due: cadence.due(media: chosen)) }
      }
      if let entry = queue.pick(at: tick, period: 1 / 60) { shown.append(entry.picture) }
      tick += 1 / 60
    }
    return shown
  }

  /// How many ticks each picture was on air for, in order, and whether any went back.
  static func holds(_ shown: [Double]) -> (holds: [Int], backwards: Bool) {
    var holds: [Int] = []
    var backwards = false
    for (index, picture) in shown.enumerated() {
      if index > 0, picture == shown[index - 1] { holds[holds.count - 1] += 1; continue }
      if index > 0, picture < shown[index - 1] { backwards = true }
      holds.append(1)
    }
    return (holds, backwards)
  }

  @Test("At full speed a 30 fps camera is 30 pictures a second, each two ticks, none skipped",
        arguments: [ 0.0, 0.001, 0.002 ])
  func thirtyAtFullSpeed(jitter: Double) {
    let tape = (0 ..< 400).map { Double($0) / 30 }
    let shown = Self.run(tape: tape, rate: 1, jitter: jitter, seconds: 10)
    let (holds, backwards) = Self.holds(shown)
    #expect(!backwards)
    // The first and last are cut by the window; everything between is held exactly two ticks.
    #expect(holds.dropFirst().dropLast().allSatisfy { $0 == 2 }, "\(holds)")
    let distinct = Set(shown)
    #expect(distinct.count >= 299, "every picture, in order: \(distinct.count)")
    let ordered = shown.reduce(into: [Double]()) { if $0.last != $1 { $0.append($1) } }
    #expect(zip(ordered, ordered.dropFirst()).allSatisfy { abs($1 - $0 - 1.0 / 30) < 1e-9 }, "no picture skipped")
  }

  @Test("Moments a hair before a tick, as an archive's exact frame grid can put them all: the lead keeps every hold exact",
        arguments: [ 0.0005, 0.002, 0.004 ])
  func phaseNearATick(phase: Double) {
    let thirty = (0 ..< 400).map { Double($0) / 30 }
    let held = Self.holds(Self.run(tape: thirty, rate: 1, jitter: 0.002, seconds: 10, phase: phase)).holds
    #expect(held.dropFirst().dropLast().allSatisfy { $0 == 2 }, "\(held)")
    let sixty = (0 ..< 800).map { Double($0) / 60 }
    let every = Self.holds(Self.run(tape: sixty, rate: 1, jitter: 0.002, seconds: 10, phase: phase)).holds
    #expect(every.dropFirst().dropLast().allSatisfy { $0 == 1 }, "60 fps: every picture, one tick each")
    // Handed on at its moment instead, the same replay is held one tick and three, and loses pictures.
    let late = Self.holds(Self.run(tape: thirty, rate: 1, jitter: 0.002, seconds: 10, phase: phase, lead: 0)).holds
    #expect(late.dropFirst().dropLast().contains { $0 != 2 })
  }

  @Test("Slow motion holds each picture its share of ticks: 60 fps at half speed two, 30 fps at a quarter eight")
  func slowMotion() {
    let sixty = (0 ..< 400).map { Double($0) / 60 }
    let (half, halfBack) = Self.holds(Self.run(tape: sixty, rate: 0.5, jitter: 0.002, seconds: 6))
    #expect(!halfBack)
    #expect(half.dropFirst().dropLast().allSatisfy { $0 == 2 }, "\(half)")
    let thirty = (0 ..< 200).map { Double($0) / 30 }
    let (quarter, quarterBack) = Self.holds(Self.run(tape: thirty, rate: 0.25, jitter: 0.002, seconds: 6))
    #expect(!quarterBack)
    #expect(quarter.dropFirst().dropLast().allSatisfy { $0 == 8 }, "\(quarter)")
  }

  @Test("A camera whose frame rate wandered is shown picture by picture, each for its own interval")
  func wanderingCamera() {
    var generator = SplitMix(11)
    var tape: [Double] = [ 0 ]
    while tape.count < 600 { tape.append(tape.last! + 1 / 60 + generator.unit() * (1 / 20 - 1 / 60)) }
    let shown = Self.run(tape: tape, rate: 1, jitter: 0.002, seconds: 15)
    let (holds, backwards) = Self.holds(shown)
    #expect(!backwards)
    // Each picture is on air from the tick after its moment to the tick after the next one's: its
    // interval, rounded to ticks, never more than one tick off and never skipped.
    let ordered = shown.reduce(into: [Double]()) { if $0.last != $1 { $0.append($1) } }
    let firstIndex = tape.firstIndex(of: ordered[0]) ?? 0
    #expect(Array(tape[firstIndex ..< firstIndex + ordered.count]) == ordered, "every picture, in tape order")
    for (index, hold) in holds.enumerated().dropFirst().dropLast() {
      let interval = tape[firstIndex + index + 1] - tape[firstIndex + index]
      #expect(abs(Double(hold) - interval * 60) <= 1.01, "picture \(index): \(hold) ticks for \(interval * 1_000) ms")
    }
  }

  @Test("A replay picture waits in the programme queue until it is due; a live one by capture plus D")
  func queueTakesDueTimes() {
    var queue = ProgrammePictureQueue<String>(delaySeconds: 1)
    queue.add("replay", capture: nil, due: 10.05)
    #expect(queue.pick(at: 10.0, period: 1 / 60) == nil)
    #expect(queue.pick(at: 10.05, period: 1 / 60)?.picture == "replay")
    queue.add("live", capture: 9.5, due: 99)
    #expect(queue.pick(at: 10.5, period: 1 / 60)?.picture == "live", "a capture time wins over a due time")
    #expect(queue.current?.due == nil)
  }
}

/// SplitMix64, for repeatable jitter.
struct SplitMix {
  private var state: UInt64
  init(_ seed: UInt64) { state = seed }
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  mutating func unit() -> Double { Double(next() >> 11) / Double(1 << 53) }
}
