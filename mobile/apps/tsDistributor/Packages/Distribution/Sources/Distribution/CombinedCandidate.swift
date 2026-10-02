import CoreGraphics
import DirectorCore
import DistributorWire

/// One video the combined video can take: a camera of the export, or its primary output.
public struct CombinedCandidate: Hashable, Sendable {
  public let name: String
  public let track: Track
  /// What the still route calls it.
  public let stillSource: SourceID

  public init(name: String, track: Track, stillSource: SourceID) {
    self.name = name
    self.track = track
    self.stillSource = stillSource
  }

  /// The primary output first, when it is exported, then the exported cameras in the take's order.
  public static func all(for recording: RecordingListing, tracks: [Track]) -> [CombinedCandidate] {
    var candidates: [CombinedCandidate] = []
    if recording.hasPrimary, tracks.contains(.primary) {
      candidates.append(CombinedCandidate(
        name: CombinedLayoutRules.primaryOutputName,
        track: .primary,
        stillSource: SourceID(DistributorProtocol.primaryStillCamera)
      ))
    }
    for camera in recording.cameras where tracks.contains(.camera(camera.sourceID)) {
      candidates.append(CombinedCandidate(name: camera.name, track: .camera(camera.sourceID), stillSource: camera.sourceID))
    }
    return candidates
  }
}

public extension CombinedPlan {
  /// The combined video an export makes when nobody lays it out: up to four of `tracks`' videos,
  /// the primary output first, placed as the saved layout places them. `include` narrows which go
  /// in, by name, and `audioCamera` says whose sound it carries. Nil when fewer than two can go in.
  static func automatic(
    for recording: RecordingListing,
    tracks: [Track],
    saved: CombinedLayoutSettings,
    include: [String]? = nil,
    audioCamera: String? = nil
  ) -> CombinedPlan? {
    let candidates = CombinedCandidate.all(for: recording, tracks: tracks)
      .filter { candidate in include.map { $0.contains(candidate.name) } ?? true }
    let included = Array(candidates.map(\.name).prefix(CombinedLayoutRules.maximumCameras))
    guard included.count >= 2 else { return nil }
    let assignment = CombinedLayoutRules.assign(included, saved: saved)
    let solo = included.count == 3 ? CombinedGeometry.effectiveSolo(assignment: assignment, saved: saved.solo) : nil
    return CombinedPlan(
      inputs: candidates.filter { included.contains($0.name) }.map { (name: $0.name, track: $0.track) },
      frames: CombinedGeometry.frames(assignment: assignment, solo: solo),
      audioCamera: CombinedLayoutRules.audioCamera(
        included: included,
        withAudio: Set(included),
        saved: audioCamera ?? saved.audioCamera
      )
    )
  }
}
