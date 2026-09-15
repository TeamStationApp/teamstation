import DistributorWire

/// Who stitches which file of an export.
///
/// Each track that still needs stitching is handed out in order: the first to the Mac, the second
/// to the iPad, and each after that to whichever becomes free first. The iPad counts as free as
/// soon as its stitch finishes; downloading what it made goes on alongside. A track a worker could
/// not do goes back to the front of the queue for the other.
public struct DistributionPlan: Sendable {
  public enum Worker: String, Sendable, CaseIterable {
    case mac
    case iPad
  }

  public private(set) var pending: [Track]
  public private(set) var assigned: [Track: Worker] = [:]
  public private(set) var finished: [Track: Worker] = [:]

  public init(tracks: [Track]) {
    pending = tracks
  }

  public mutating func next(for worker: Worker) -> Track? {
    guard !pending.isEmpty else { return nil }
    let track = pending.removeFirst()
    assigned[track] = worker
    return track
  }

  public mutating func finish(_ track: Track) {
    if let worker = assigned.removeValue(forKey: track) {
      finished[track] = worker
    }
  }

  public mutating func giveBack(_ track: Track) {
    guard assigned.removeValue(forKey: track) != nil else { return }
    pending.insert(track, at: 0)
  }

  /// Tracks the other worker still holds, which may yet come back.
  public func held(by worker: Worker) -> [Track] {
    assigned.filter { $0.value == worker }.map(\.key)
  }

  public var isComplete: Bool { pending.isEmpty && assigned.isEmpty }
}
