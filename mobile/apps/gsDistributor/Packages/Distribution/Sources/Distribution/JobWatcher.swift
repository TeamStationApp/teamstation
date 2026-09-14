import DistributorWire
import Foundation

public enum DistributionError: Error, Equatable, CustomStringConvertible, Sendable {
  case iPadFailed(String)
  /// GS Director went to the background or away, taking its job with it.
  case directorGone
  case nothingToStitch
  case noDestination

  public var description: String {
    switch self {
    case .iPadFailed(let reason): "the iPad could not stitch it: \(reason)"
    case .directorGone: "GS Director went away before it finished"
    case .nothingToStitch: "there was nothing to stitch for that file"
    case .noDestination: "choose a folder to save into in Settings"
    }
  }
}

/// Matches the iPad's job events to whoever is waiting for them. An event that arrives before its
/// waiter, as a fast job's can, is kept until the waiter comes.
public actor JobWatcher {
  private var results: [UUID: Result<RemoteFile, DistributionError>] = [:]
  private var waiters: [UUID: CheckedContinuation<RemoteFile, Error>] = [:]
  private var progress: [UUID: @Sendable (Double) -> Void] = [:]

  public init() {}

  public func handle(_ event: DistributorEvent) {
    switch event {
    case .jobProgress(let id, let fraction):
      progress[id]?(fraction)
    case .jobFinished(let id, let file):
      resolve(id, .success(file))
    case .jobFailed(let id, let reason):
      resolve(id, .failure(.iPadFailed(reason)))
    case .directorBackgrounded:
      abandonAll()
    case .recordingsChanged, .recordingStateChanged:
      break
    }
  }

  public func wait(for id: UUID, progress report: @escaping @Sendable (Double) -> Void) async throws -> RemoteFile {
    if let result = results.removeValue(forKey: id) { return try result.get() }
    progress[id] = report
    return try await withCheckedThrowingContinuation { continuation in
      waiters[id] = continuation
    }
  }

  /// Every job still out fails: the Director is gone, and its jobs with it.
  public func abandonAll() {
    let pending = waiters
    waiters.removeAll()
    progress.removeAll()
    for waiter in pending.values {
      waiter.resume(throwing: DistributionError.directorGone)
    }
  }

  private func resolve(_ id: UUID, _ result: Result<RemoteFile, DistributionError>) {
    progress.removeValue(forKey: id)
    if let waiter = waiters.removeValue(forKey: id) {
      switch result {
      case .success(let file): waiter.resume(returning: file)
      case .failure(let error): waiter.resume(throwing: error)
      }
    } else {
      results[id] = result
    }
  }
}
