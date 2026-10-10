import Foundation
import Testing
@testable import DirectorCore

/// A measure that counts its calls and reports a figure the test sets.
private final class FakeVolume: @unchecked Sendable {
  private let lock = NSLock()
  private var free: Int64
  private var calls = 0
  private var onMain = 0

  init(free: Int64) { self.free = free }

  func set(_ value: Int64) {
    lock.lock()
    free = value
    lock.unlock()
  }

  var callCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return calls
  }

  var mainThreadCalls: Int {
    lock.lock()
    defer { lock.unlock() }
    return onMain
  }

  func measure() -> Int64 {
    lock.lock()
    defer { lock.unlock() }
    calls += 1
    if Thread.isMainThread { onMain += 1 }
    return free
  }
}

@Suite("Free disk space cache")
struct FreeDiskSpaceTests {
  @Test("Reading the cache never measures")
  func cachedReadDoesNotMeasure() {
    let volume = FakeVolume(free: 42)
    let space = FreeDiskSpace(measure: volume.measure)
    #expect(space.cachedBytes == 0)
    #expect(!space.hasMeasured)
    for _ in 0..<100 { _ = space.cachedBytes }
    #expect(volume.callCount == 0)
  }

  @Test("A refresh measures on the background queue and updates the cache")
  @MainActor
  func refreshRunsOffMain() {
    let volume = FakeVolume(free: 7_000)
    let space = FreeDiskSpace(measure: volume.measure)
    space.refresh()
    space.waitForPendingRefreshes()
    #expect(space.cachedBytes == 7_000)
    #expect(space.hasMeasured)
    #expect(volume.callCount == 1)
    #expect(volume.mainThreadCalls == 0)
  }

  @Test("A caller about to act gets a fresh measure, taken off the main thread")
  @MainActor
  func measuredIsFresh() async {
    let volume = FakeVolume(free: 1)
    let space = FreeDiskSpace(measure: volume.measure)
    space.refresh()
    space.waitForPendingRefreshes()
    volume.set(99)
    #expect(space.cachedBytes == 1)
    let fresh = await space.measured()
    #expect(fresh == 99)
    #expect(space.cachedBytes == 99)
    #expect(volume.mainThreadCalls == 0)
  }

  @Test("The timer measures at once and then on its interval")
  func timerRefreshes() async throws {
    let volume = FakeVolume(free: 5)
    let space = FreeDiskSpace(measure: volume.measure)
    space.startRefreshing(every: 0.05)
    try await Task.sleep(for: .milliseconds(400))
    space.stopRefreshing()
    space.waitForPendingRefreshes()
    let calls = volume.callCount
    #expect(calls >= 3)
    #expect(space.cachedBytes == 5)
    try await Task.sleep(for: .milliseconds(150))
    #expect(volume.callCount == calls)
  }
}
