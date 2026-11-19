@testable import CameramanCapture
import Foundation
@testable import SpeedyCore

/// A scheduler driven by hand: `advance` runs what has come due, in order.
@MainActor
final class StepScheduler: SpeedyScheduler {
  final class Timer: SpeedyTimer {
    let due: Duration
    let work: @MainActor () -> Void
    var cancelled = false
    init(due: Duration, work: @escaping @MainActor () -> Void) {
      self.due = due
      self.work = work
    }
    func cancel() { cancelled = true }
  }

  private(set) var now: Duration = .zero
  private(set) var timers: [Timer] = []

  func after(_ delay: Duration, _ work: @escaping @MainActor () -> Void) -> SpeedyTimer {
    let timer = Timer(due: now + delay, work: work)
    timers.append(timer)
    return timer
  }

  func advance(by step: Duration) {
    now += step
    while let next = timers.filter({ !$0.cancelled && $0.due <= now }).min(by: { $0.due < $1.due }) {
      next.cancelled = true
      next.work()
    }
  }

  var pending: Int { timers.filter { !$0.cancelled }.count }
}

/// Records what the model asks it to play.
@MainActor
final class RecordingPlayer: PhrasePlayer {
  private(set) var played: [[String]] = []
  private(set) var stops = 0
  func play(_ clips: [String]) { played.append(clips) }
  func stop() { stops += 1 }
}

/// A radar the tests set by hand.
@MainActor
final class FakeSpeedyRadar: SpeedyRadar {
  var status = RadarStatus() {
    didSet { onChange?() }
  }
  var onChange: (() -> Void)?
  var onSpeeds: ((Int, Int) -> Void)?
  private(set) var calls: [String] = []

  func start() { calls.append("start") }
  func startPairing() { calls.append("startPairing") }
  func stopPairing() { calls.append("stopPairing") }
  func pair(_ name: String) { calls.append("pair \(name)") }
  func unpair() { calls.append("unpair") }

  func reading(pitch: Int, exit: Int) { onSpeeds?(pitch, exit) }
}

/// A radio the tests drive by hand, as TS Cameraman's radar tests do.
@MainActor
final class FakeRadarRadio: RadarRadio {
  weak var listener: RadarRadioListener?
  var power: RadarPower = .unknown
  private(set) var scanning = false
  private(set) var connects: [String] = []

  func startScan() { scanning = true }
  func stopScan() { scanning = false }
  func connect(_ name: String) { connects.append(name) }
  func disconnect() {}
  func write(_ bytes: [UInt8]) {}

  func setPower(_ next: RadarPower) {
    power = next
    listener?.radioPowerChanged(next)
  }

  /// Advertises and connects, as a radar in range does.
  func bringUp(_ name: String) {
    listener?.radioDiscovered(name)
    listener?.radioConnected()
  }
}

/// A speed packet the way the TAG One sends it: a negative primary speed is a pitch, a positive one
/// an exit, in centimetres per second, with the other side in the extra field.
func radarSpeedPacket(signedCms: Int, extraCms: Int = 0) -> [UInt8] {
  let signed = UInt16(bitPattern: Int16(signedCms))
  let extra = UInt16(extraCms)
  let body: [UInt8] = [
    0x13, 0, 0, 0, 0, 0, 0,
    UInt8(signed >> 8), UInt8(signed & 0xFF),
    UInt8(extra >> 8), UInt8(extra & 0xFF),
    0
  ]
  return [ 0x80, UInt8(body.count) ] + body
}

func freshDefaults() -> UserDefaults {
  UserDefaults(suiteName: "SpeedyTests-\(UUID().uuidString)")!
}
