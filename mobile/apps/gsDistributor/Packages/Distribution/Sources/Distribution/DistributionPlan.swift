import DistributorWire

/// The order an export's files are stitched in.
///
/// One worker, so this is a queue: the Mac takes the next track when it is
/// free. It used to hand every other track to the iPad, which sounded like
/// twice the speed and was not — the Mac encodes far faster than the iPad,
/// and a track sent to the iPad also had to be sent back over USB. A track
/// that fails goes to the front, because a failure is usually about the
/// track rather than about the machine.
public struct DistributionPlan: Sendable {
  public private(set) var pending: [Track]
  public private(set) var assigned: Set<Track> = []
  public private(set) var finished: [Track] = []

  public init(tracks: [Track]) {
    pending = tracks
  }

  public mutating func next() -> Track? {
    guard !pending.isEmpty else { return nil }
    let track = pending.removeFirst()
    assigned.insert(track)
    return track
  }

  public mutating func finish(_ track: Track) {
    if assigned.remove(track) != nil { finished.append(track) }
  }

  public mutating func giveBack(_ track: Track) {
    guard assigned.remove(track) != nil else { return }
    pending.insert(track, at: 0)
  }

  public var isComplete: Bool { pending.isEmpty && assigned.isEmpty }
}
