import DirectorClient
import Foundation
import Observation

/// Several recordings exported together, taken through each step of an export as one: every file
/// of every recording comes off the iPad first, under one export lock; then the Mac stitches them
/// all, then makes the combined videos that were asked for, then the uploads go.
///
/// So the iPad is needed only for the first step, however many recordings there are, and can be
/// unplugged as soon as `isDoneWithIPad`. An export of one recording is a batch of one.
@MainActor
@Observable
public final class DistributionBatch {
  public enum Step: String, Sendable {
    case fetching, stitching, combining, uploading, finished
  }

  /// In the order they go through each step.
  public let runs: [DistributionRun]
  public private(set) var step: Step = .fetching
  /// Nothing more will be asked of the iPad: every file is off it, or could not be had.
  public private(set) var isDoneWithIPad = false
  public private(set) var isFinished = false
  /// True once `cancel()` was called.
  public private(set) var wasCancelled = false

  /// Nil with no iPad attached, which is enough when every file the batch needs is already here.
  private let connection: DirectorConnection?
  /// How often the export lock is renewed. TS Director drops one left unrenewed for half a minute.
  private let lockRenewal: Duration
  /// Asked before the batch writes anything.
  private let spaceCheck: SpaceCheck
  private var work: Task<Void, Never>?
  /// TS Director's export lock going back, once nothing more is wanted from the iPad. The batch
  /// goes on without waiting for it, and is finished only when it is back.
  private var handBack: Task<Void, Never>?
  /// TS Director dropped the export lock, so it may record or stream at any moment.
  private var lostLock = false

  public init(
    runs: [DistributionRun],
    connection: DirectorConnection?,
    lockRenewal: Duration = .seconds(10),
    spaceCheck: SpaceCheck = .system
  ) {
    self.runs = runs
    self.connection = connection
    self.lockRenewal = lockRenewal
    self.spaceCheck = spaceCheck
    for run in runs { run.batch = self }
  }

  public func run() async {
    // Work the user asked for: macOS neither naps the app nor lets the Mac idle to sleep while an
    // export runs, whether or not the window is in front.
    let activity = ProcessInfo.processInfo.beginActivity(options: .userInitiated, reason: "Exporting recordings")
    defer { ProcessInfo.processInfo.endActivity(activity) }
    if runs.contains(where: \.wasCancelled) { cancel() }
    guard !wasCancelled else {
      finish()
      return
    }
    let work = Task { await self.perform() }
    self.work = work
    await work.value
  }

  /// Stops every export of the batch: stitching, downloads and uploads. Files already saved stay,
  /// and a download stopped part way resumes next time.
  public func cancel() {
    guard !isFinished, !wasCancelled else { return }
    wasCancelled = true
    work?.cancel()
    for run in runs { run.stop() }
  }

  /// This Mac stopped renewing the lock for long enough that TS Director dropped it (a Mac that was
  /// asleep or hung). The batch stops rather than go on alongside a recording or a stream — unless
  /// the lock was already handed back, when the iPad has nothing more to give and nothing to stop.
  private func lockLost() {
    guard !isFinished, !wasCancelled, handBack == nil else { return }
    lostLock = true
    cancel()
  }

  private func finish() {
    let reason = wasCancelled ? (lostLock ? "Stopped: TS Director no longer held off recording" : "Cancelled") : nil
    for run in runs { run.finish(cancelled: reason) }
    isDoneWithIPad = true
    step = .finished
    isFinished = true
  }

  private func perform() async {
    defer { finish() }
    await performSteps()
    await handBack?.value
  }

  private func performSteps() async {
    // Recordings of one day share a folder, so what an export that never finished left there goes
    // before any of this batch's work folders is made.
    for folder in Set(runs.map(\.folder)) { DistributionRun.removeWorkFolders(in: folder) }
    for run in runs { run.prepare() }

    // 1. Everything every export needs from the iPad, onto this Mac.
    for run in runs where !run.needsIPad {
      // Every file is already here, so the combined video and the uploads need only this Mac.
      await run.checkRoomForCombined(spaceCheck)
    }
    let fromIPad = runs.filter(\.needsIPad)
    if !fromIPad.isEmpty {
      if let connection {
        await fetch(fromIPad, connection: connection)
      } else {
        for run in fromIPad { run.failWithoutIPad() }
      }
    }
    isDoneWithIPad = true

    // 2. The files, then the combined videos, on this Mac alone.
    step = .stitching
    for run in runs where !wasCancelled { await run.stitch() }
    step = .combining
    for run in runs where !wasCancelled { await run.makeCombined() }
    // 3. The uploads.
    step = .uploading
    for run in runs where !wasCancelled { await run.upload() }
  }

  /// Fetches what each of `runs` needs from the iPad, holding TS Director's export lock until every
  /// file of every one is in, and hands the lock back.
  private func fetch(_ runs: [DistributionRun], connection: DirectorConnection) async {
    // TS Director records and streams nothing while the batch works with the iPad, and grants none
    // of it while it does either.
    let lock: UUID
    do {
      lock = try await connection.beginExport()
    } catch {
      for run in runs { run.stop(fetching: "\(error)") }
      return
    }
    // Renewed while the batch works with the iPad: TS Director drops a lock left unrenewed, so a
    // Mac that dies mid-export cannot keep it from recording.
    let every = lockRenewal
    let renewing = Task.detached { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: every)
        guard !Task.isCancelled else { return }
        // A refusal, not a failed request: the lock is gone, and the batch must not go on. A
        // request that fails is an iPad that went away, which the downloads hear about themselves.
        if let held = try? await connection.renewExport(lock), !held, !Task.isCancelled {
          await self?.lockLost()
          return
        }
      }
    }
    // Handed back from a task of its own: a cancelled batch's task would have URLSession refuse
    // the request, and TS Director would stay locked until the lease ran out. Not waited for here,
    // so an iPad unplugged the moment its files are in holds nothing up.
    defer {
      renewing.cancel()
      handBack = Task.detached { try? await connection.endExport(lock) }
    }

    // Nothing is written until every export of the batch is known to fit: every recording's
    // segments are on this Mac at once before the first is stitched.
    var measured: [DistributionRun] = []
    var need = DistributionRun.Need()
    for run in runs {
      guard !Task.isCancelled else { return }
      guard let one = await run.measure(connection: connection) else { continue }
      measured.append(run)
      need.trackBytes += one.trackBytes
      need.combinedBytes += one.combinedBytes
    }
    if let first = measured.first, let shortfall = spaceCheck.shortfall(
      trackBytes: need.trackBytes,
      combinedBytes: need.combinedBytes,
      destination: first.folder,
      scratch: first.folder
    ) {
      for run in measured { run.stop(fetching: shortfall) }
      return
    }

    for run in measured {
      guard !Task.isCancelled else { return }
      await run.fetch(connection: connection)
    }
  }
}
