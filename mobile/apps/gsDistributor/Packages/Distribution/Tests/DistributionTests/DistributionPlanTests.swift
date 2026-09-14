import DirectorCore
import Distribution
import DistributorWire
import Foundation
import Testing

@Suite("Distribution plan")
struct DistributionPlanTests {
  private let four: [Track] = [ .primary, .camera(SourceID("a")), .camera(SourceID("b")), .camera(SourceID("c")) ]

  @Test("First to the Mac, second to the iPad, then whoever is free first: the iPad finishing first")
  func iPadFreeFirst() {
    var plan = DistributionPlan(tracks: four)
    #expect(plan.next(for: .mac) == four[0])
    #expect(plan.next(for: .iPad) == four[1])
    plan.finish(four[1])
    #expect(plan.next(for: .iPad) == four[2])
    plan.finish(four[0])
    #expect(plan.next(for: .mac) == four[3])
    plan.finish(four[2])
    plan.finish(four[3])
    #expect(plan.isComplete)
    #expect(plan.finished == [ four[0]: .mac, four[1]: .iPad, four[2]: .iPad, four[3]: .mac ])
  }

  @Test("The Mac finishing first takes the third")
  func macFreeFirst() {
    var plan = DistributionPlan(tracks: four)
    _ = plan.next(for: .mac)
    _ = plan.next(for: .iPad)
    plan.finish(four[0])
    #expect(plan.next(for: .mac) == four[2])
    plan.finish(four[1])
    #expect(plan.next(for: .iPad) == four[3])
  }

  @Test("A track handed back goes to the front, for the other worker")
  func giveBack() {
    var plan = DistributionPlan(tracks: four)
    _ = plan.next(for: .mac)
    _ = plan.next(for: .iPad)
    #expect(plan.held(by: .iPad) == [ four[1] ])
    plan.giveBack(four[1])
    #expect(plan.held(by: .iPad).isEmpty)
    #expect(plan.next(for: .mac) == four[1])
    #expect(!plan.isComplete)
  }
}

@Suite("Job watcher")
struct JobWatcherTests {
  @Test("A result that arrives before its waiter is kept for it")
  func earlyResult() async throws {
    let watcher = JobWatcher()
    let id = UUID()
    let file = RemoteFile(root: .prepared, path: "rec-1/a.mov", bytes: 3)
    await watcher.handle(.jobFinished(jobID: id, file: file))
    #expect(try await watcher.wait(for: id) { _ in } == file)
  }

  @Test("A waiter hears progress, then the failure")
  func progressThenFailure() async throws {
    let watcher = JobWatcher()
    let id = UUID()
    let heard = Heard()
    let waiting = Task { try await watcher.wait(for: id) { heard.add($0) } }
    for _ in 0..<100 {
      await watcher.handle(.jobProgress(jobID: id, fraction: 0.5))
      if heard.count > 0 { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    await watcher.handle(.jobFailed(jobID: id, reason: "no segments"))
    await #expect(throws: DistributionError.iPadFailed("no segments")) { try await waiting.value }
    #expect(heard.count > 0)
  }

  @Test("The Director going to the background fails every job still out")
  func backgroundAbandons() async throws {
    let watcher = JobWatcher()
    let waiting = Task { try await watcher.wait(for: UUID()) { _ in } }
    try await Task.sleep(for: .milliseconds(50))
    await watcher.handle(.directorBackgrounded)
    await #expect(throws: DistributionError.directorGone) { try await waiting.value }
  }
}

final class Heard: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Double] = []
  func add(_ value: Double) { lock.withLock { values.append(value) } }
  var count: Int { lock.withLock { values.count } }
}
