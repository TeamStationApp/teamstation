import Foundation
import os

/// Runs an `AdaptiveBitrateController` against the live server, four times a second.
///
/// The encoder must be at the ceiling whenever `configure` is called; `configure` then says so again
/// itself, after any tick already in flight, so a cut computed against the old session can never be
/// the last word on the new one.
public final class AdaptiveBitrateLoop: @unchecked Sendable {
  public struct Status: Sendable, Equatable, Codable {
    public var enabled: Bool
    public var controller: AdaptiveBitrateController.Status
  }

  /// SCReAM adjusts its rate every 200 ms and belacoder every 200–250 ms. Faster than the encoder can
  /// follow is wasted; slower lets a Wi-Fi burst reach the drop threshold before anything reacts.
  public static let tickInterval: DispatchTimeInterval = .milliseconds(250)

  private let queue = DispatchQueue(label: "co.gamestation.adaptive-bitrate")
  private let sample: @Sendable (@escaping @Sendable (CongestionSample?) -> Void) -> Void
  private let apply: @Sendable (Int) -> Void
  private let published: OSAllocatedUnfairLock<Status>

  // Touched only on `queue`.
  private var controller: AdaptiveBitrateController
  private var enabled = false
  private var timer: DispatchSourceTimer?

  /// `sample` reports the worst playing client's link since it was last asked; `apply` hands a rate
  /// to the encoder. Neither may block. `tuning` is the controller's, kept across `configure`.
  public init(
    ceiling: Int,
    floor: Int? = nil,
    tuning: AdaptiveBitrateController.Tuning = .init(),
    sample: @escaping @Sendable (@escaping @Sendable (CongestionSample?) -> Void) -> Void,
    apply: @escaping @Sendable (Int) -> Void
  ) {
    self.sample = sample
    self.apply = apply
    controller = AdaptiveBitrateController(ceiling: ceiling, floor: floor, tuning: tuning)
    published = OSAllocatedUnfairLock(initialState: Status(enabled: false, controller: controller.status))
  }

  public var status: Status { published.withLock { $0 } }

  /// A new ceiling or floor, or adaptation switched on or off. Either way the rate goes back to the
  /// ceiling. `floor` defaults to half the ceiling.
  public func configure(ceiling: Int, floor: Int? = nil, enabled: Bool) {
    queue.async { [self] in
      controller.reset(ceiling: ceiling, floor: floor)
      self.enabled = enabled
      if enabled { startTimer() } else { stopTimer() }
      apply(ceiling)
      publish()
    }
  }

  public func stop() {
    queue.async { [self] in
      stopTimer()
      enabled = false
      publish()
    }
  }

  private func startTimer() {
    guard timer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.tickInterval, repeating: Self.tickInterval, leeway: .milliseconds(20))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    self.timer = timer
  }

  private func stopTimer() {
    timer?.cancel()
    timer = nil
  }

  private func tick() {
    sample { [weak self] sample in
      guard let self else { return }
      queue.async { [self] in
        // Switched off, or reconfigured, while the sample was being taken.
        guard enabled else { return }
        if let bitrate = controller.update(sample, now: ProcessInfo.processInfo.systemUptime) {
          apply(bitrate)
        }
        publish()
      }
    }
  }

  private func publish() {
    let next = Status(enabled: enabled, controller: controller.status)
    published.withLock { $0 = next }
  }
}
