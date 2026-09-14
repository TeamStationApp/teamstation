import CoreGraphics
import Foundation

public enum Quadrant: String, Codable, CaseIterable, Sendable {
  case topLeading
  case topTrailing
  case bottomLeading
  case bottomTrailing

  public var row: Int { self == .topLeading || self == .topTrailing ? 0 : 1 }
  public var column: Int { self == .topLeading || self == .bottomLeading ? 0 : 1 }

  public static func at(row: Int, column: Int) -> Quadrant {
    switch (row, column) {
    case (0, 0): .topLeading
    case (0, _): .topTrailing
    case (_, 0): .bottomLeading
    default: .bottomTrailing
    }
  }

  /// Reading order: top left, top right, bottom left, bottom right.
  public static let readingOrder: [Quadrant] = [ .topLeading, .topTrailing, .bottomLeading, .bottomTrailing ]
}

/// Which way the one video of a three-camera layout slides: along its column or along its row.
public enum SoloAxis: String, Codable, Sendable {
  case vertical
  case horizontal
}

/// The third video of a three-camera layout, slid part of the way into the empty quadrant.
public struct SoloPlacement: Codable, Equatable, Sendable {
  public var camera: String
  public var axis: SoloAxis
  /// 0 is its own quadrant, 1 the empty one, 0.5 centred between them.
  public var position: Double

  public init(camera: String, axis: SoloAxis, position: Double) {
    self.camera = camera
    self.axis = axis
    self.position = position
  }
}

public struct QuadrantPlacement: Codable, Equatable, Sendable {
  public var camera: String
  public var quadrant: Quadrant

  public init(camera: String, quadrant: Quadrant) {
    self.camera = camera
    self.quadrant = quadrant
  }
}

/// The combined video's remembered arrangement, keyed by camera name.
public struct CombinedLayoutSettings: Codable, Equatable, Sendable {
  /// Cameras toggled into the combined video last time.
  public var included: [String]
  /// Most recent first. When two names claim one quadrant, the earlier entry wins. A list rather
  /// than a map, because JSON does not keep an object's key order.
  public var placements: [QuadrantPlacement]
  public var solo: SoloPlacement?
  public var audioCamera: String?

  public init(
    included: [String] = [],
    placements: [QuadrantPlacement] = [],
    solo: SoloPlacement? = nil,
    audioCamera: String? = nil
  ) {
    self.included = included
    self.placements = placements
    self.solo = solo
    self.audioCamera = audioCamera
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    included = try container.decodeIfPresent([String].self, forKey: .included) ?? []
    placements = try container.decodeIfPresent([QuadrantPlacement].self, forKey: .placements) ?? []
    solo = try container.decodeIfPresent(SoloPlacement.self, forKey: .solo)
    audioCamera = try container.decodeIfPresent(String.self, forKey: .audioCamera)
  }
}

public enum CombinedLayoutRules {
  public static let maximumCameras = 4
  /// What the layout calls the primary output when it is one of the combined video's four. Its
  /// place and sound are remembered under this name, as a camera's are under its own.
  public static let primaryOutputName = "Primary output"
  /// Each camera is recorded at about 4 Mb/s, so the combined video gets that much per camera.
  public static let bitsPerSecondPerCamera = 4_000_000

  public static func bitsPerSecond(cameraCount: Int) -> Int {
    bitsPerSecondPerCamera * max(0, min(cameraCount, maximumCameras))
  }

  /// The cameras toggled in when the export sheet opens: last time's, as far as this export has
  /// them, else the first four.
  public static func initialInclusion(exported: [String], saved: CombinedLayoutSettings) -> [String] {
    let remembered = exported.filter { saved.included.contains($0) }
    return Array((remembered.isEmpty ? exported : remembered).prefix(maximumCameras))
  }

  /// `processVid.ts`'s fixed order, used for names it knew when nothing has been saved for them.
  private static let familiarQuadrants: [String: Quadrant] = [
    "mound": .topTrailing,
    "3rd": .bottomLeading,
    "1st": .bottomTrailing
  ]

  /// Where each of `cameras` goes: its remembered quadrant, else a familiar one, else the first
  /// free quadrant in reading order.
  public static func assign(_ cameras: [String], saved: CombinedLayoutSettings) -> [String: Quadrant] {
    let cameras = Array(cameras.prefix(maximumCameras))
    var assignment: [String: Quadrant] = [:]
    var taken = Set<Quadrant>()
    for placement in saved.placements where cameras.contains(placement.camera) {
      guard assignment[placement.camera] == nil, !taken.contains(placement.quadrant) else { continue }
      assignment[placement.camera] = placement.quadrant
      taken.insert(placement.quadrant)
    }
    for camera in cameras where assignment[camera] == nil {
      let key = camera.trimmingCharacters(in: .whitespaces).lowercased()
      if let quadrant = familiarQuadrants[key], !taken.contains(quadrant) {
        assignment[camera] = quadrant
        taken.insert(quadrant)
      }
    }
    for camera in cameras where assignment[camera] == nil {
      guard let quadrant = Quadrant.readingOrder.first(where: { !taken.contains($0) }) else { break }
      assignment[camera] = quadrant
      taken.insert(quadrant)
    }
    return assignment
  }

  /// Saves a new arrangement ahead of the old one. Names this export did not have keep their
  /// entries, behind the new ones.
  public static func remember(
    _ assignment: [String: Quadrant],
    included: [String],
    solo: SoloPlacement?,
    audioCamera: String?,
    in saved: CombinedLayoutSettings
  ) -> CombinedLayoutSettings {
    let fresh = Quadrant.readingOrder.compactMap { quadrant in
      assignment.first { $0.value == quadrant }.map { QuadrantPlacement(camera: $0.key, quadrant: quadrant) }
    }
    let kept = saved.placements.filter { assignment[$0.camera] == nil }
    return CombinedLayoutSettings(
      included: included,
      placements: fresh + kept,
      solo: solo,
      audioCamera: audioCamera ?? saved.audioCamera
    )
  }

  /// The camera whose sound the combined video carries: the remembered one if it is in and has
  /// sound, else the first included camera that has sound.
  public static func audioCamera(included: [String], withAudio: Set<String>, saved: String?) -> String? {
    if let saved, included.contains(saved), withAudio.contains(saved) { return saved }
    return included.first { withAudio.contains($0) }
  }
}

/// Where each camera sits on the combined video's canvas.
public enum CombinedGeometry {
  /// 4K, so a 1080p camera fills its quadrant pixel for pixel.
  public static let canvas = CGSize(width: 3840, height: 2160)

  /// The rectangle each camera is fitted into. Four cameras take the quadrants. Three take theirs,
  /// with the solo slid along its axis. Two sit side by side, centred vertically. One or none
  /// makes no combined video.
  public static func frames(
    assignment: [String: Quadrant],
    solo: SoloPlacement?,
    canvas: CGSize = canvas
  ) -> [String: CGRect] {
    let width = canvas.width / 2
    let height = canvas.height / 2
    func rect(_ quadrant: Quadrant) -> CGRect {
      CGRect(x: CGFloat(quadrant.column) * width, y: CGFloat(quadrant.row) * height, width: width, height: height)
    }

    switch assignment.count {
    case 4:
      return assignment.mapValues(rect)
    case 3:
      var frames = assignment.mapValues(rect)
      let placement = effectiveSolo(assignment: assignment, saved: solo)
      guard let placement, let quadrant = assignment[placement.camera] else { return frames }
      let travel = placement.position.clamped
      var frame = rect(quadrant)
      switch placement.axis {
      case .vertical:
        frame.origin.y = quadrant.row == 0 ? travel * height : height - travel * height
      case .horizontal:
        frame.origin.x = quadrant.column == 0 ? travel * width : width - travel * width
      }
      frames[placement.camera] = frame
      return frames
    case 2:
      let ordered = assignment.sorted {
        Quadrant.readingOrder.firstIndex(of: $0.value)! < Quadrant.readingOrder.firstIndex(of: $1.value)!
      }
      let top = (canvas.height - height) / 2
      return [
        ordered[0].key: CGRect(x: 0, y: top, width: width, height: height),
        ordered[1].key: CGRect(x: width, y: top, width: width, height: height)
      ]
    default:
      return [:]
    }
  }

  /// With three quadrants filled, the two cameras beside the empty one: the one sharing its column
  /// slides vertically, the one sharing its row horizontally.
  public static func soloCandidates(assignment: [String: Quadrant]) -> [(camera: String, axis: SoloAxis)] {
    guard assignment.count == 3,
          let empty = Quadrant.allCases.first(where: { !assignment.values.contains($0) })
    else { return [] }
    let columnMate = Quadrant.at(row: 1 - empty.row, column: empty.column)
    let rowMate = Quadrant.at(row: empty.row, column: 1 - empty.column)
    var candidates: [(camera: String, axis: SoloAxis)] = []
    if let camera = assignment.first(where: { $0.value == columnMate })?.key {
      candidates.append((camera, .vertical))
    }
    if let camera = assignment.first(where: { $0.value == rowMate })?.key {
      candidates.append((camera, .horizontal))
    }
    return candidates
  }

  /// The saved solo if it still fits the arrangement, else the column-mate centred.
  public static func effectiveSolo(assignment: [String: Quadrant], saved: SoloPlacement?) -> SoloPlacement? {
    let candidates = soloCandidates(assignment: assignment)
    if let saved, candidates.contains(where: { $0.camera == saved.camera && $0.axis == saved.axis }) {
      return saved
    }
    return candidates.first.map { SoloPlacement(camera: $0.camera, axis: $0.axis, position: 0.5) }
  }

  /// Where a camera dragged across the canvas lands when it is let go. `pointer` is where it was
  /// let go and `origin` the dragged picture's top-left corner, both in `canvas`'s points.
  ///
  /// With three cameras, the one beside the empty quadrant let go in its own column (or row) slides
  /// along it, snapping to the centre. Otherwise a camera let go over another swaps places with it,
  /// and one let go anywhere else takes the quadrant under the pointer.
  public static func drop(
    _ camera: String,
    pointer: CGPoint,
    origin: CGPoint,
    assignment: [String: Quadrant],
    solo: SoloPlacement?,
    canvas: CGSize
  ) -> (assignment: [String: Quadrant], solo: SoloPlacement?) {
    guard let from = assignment[camera], canvas.width > 0, canvas.height > 0 else { return (assignment, solo) }
    let width = canvas.width / 2
    let height = canvas.height / 2
    let point = CGPoint(
      x: Swift.min(Swift.max(pointer.x, 0), canvas.width - 0.001),
      y: Swift.min(Swift.max(pointer.y, 0), canvas.height - 0.001)
    )
    let column = point.x < width ? 0 : 1
    let row = point.y < height ? 0 : 1

    if let lane = soloCandidates(assignment: assignment).first(where: { $0.camera == camera }),
       lane.axis == .vertical ? column == from.column : row == from.row {
      let travel = lane.axis == .vertical ? height : width
      let offset = lane.axis == .vertical
        ? (from.row == 0 ? origin.y : height - origin.y)
        : (from.column == 0 ? origin.x : width - origin.x)
      let position = snapped(Double(offset / travel), travel: Double(travel))
      return (assignment, SoloPlacement(camera: camera, axis: lane.axis, position: position))
    }

    let shown = frames(assignment: assignment, solo: solo, canvas: canvas)
    let target = shown.first { $0.key != camera && $0.value.contains(point) }.flatMap { assignment[$0.key] }
      ?? Quadrant.at(row: row, column: column)
    guard target != from else { return (assignment, solo) }
    var next = assignment
    if let occupant = next.first(where: { $0.value == target })?.key { next[occupant] = from }
    next[camera] = target
    return (next, next.count == 3 ? effectiveSolo(assignment: next, saved: solo) : nil)
  }

  /// Snaps a solo position to the centre when it is within `threshold` points of it, `travel`
  /// being how many on-screen points the whole slide covers. Exactly `threshold` away still snaps;
  /// the tolerance keeps floating-point rounding from deciding that.
  public static func snapped(_ position: Double, travel: Double, threshold: Double = 2) -> Double {
    let position = position.clamped
    return abs(position - 0.5) * travel <= threshold + 1e-9 ? 0.5 : position
  }
}

private extension Double {
  var clamped: Double { Swift.min(Swift.max(self, 0), 1) }
}
