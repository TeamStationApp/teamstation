import Foundation
import DirectorCore

/// Post-event export.
///
/// Export is a **stream copy**: the archive was already encoded to the operator's chosen
/// settings, so re-encoding it would be a second generation of loss for no benefit. Trim
/// boundaries land on segment edges, which are keyframe edges, so the result is GOP-rounded
/// without any frame-accurate cutting.
public struct ExportService: Sendable {
  public struct Result: Sendable, Equatable {
    public var url: URL
    public var startWall: WallClock
    public var duration: TimeInterval
    public var byteCount: Int64
    public var segmentCount: Int
    /// How far the requested start had to move back to reach a keyframe.
    public var startAdjustment: TimeInterval
  }

  private let index: ArchiveIndex
  private let assembler: SegmentAssembler

  public init(index: ArchiveIndex) {
    self.index = index
    self.assembler = SegmentAssembler(index: index)
  }

  public func export(
    sourceID: SourceID,
    displayName: String,
    from: WallClock,
    to: WallClock,
    destinationDirectory: URL = DirectorPaths.exports
  ) throws -> Result {
    try FileManager.default.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)

    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let name = "\(Self.slug(displayName))-\(formatter.string(from: from.date)).mp4"
    let destination = destinationDirectory.appendingPathComponent(name)

    let assembly = try assembler.assemble(
      sourceID: sourceID,
      from: from,
      to: to,
      destination: destination
    )

    let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
    let byteCount = (attributes[.size] as? NSNumber)?.int64Value ?? 0

    return Result(
      url: destination,
      startWall: assembly.startWall,
      duration: assembly.duration,
      byteCount: byteCount,
      segmentCount: assembly.segmentCount,
      startAdjustment: from - assembly.startWall
    )
  }

  public struct ItemProgress: Sendable, Identifiable, Equatable {
    public var id: String
    public var name: String
    public var fraction: Double

    public init(id: String, name: String, fraction: Double) {
      self.id = id
      self.name = name
      self.fraction = fraction
    }
  }

  /// Assembles the chosen cameras and/or programme of one recording into shareable `.mov` files.
  public func exportRecording(
    _ recording: RecordingSummary,
    cameras: [(sourceID: SourceID, name: String)],
    includeProgram: Bool,
    destinationDirectory: URL = DirectorPaths.exports,
    progress: (@Sendable (ItemProgress) -> Void)? = nil
  ) throws -> [URL] {
    try FileManager.default.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)
    var urls: [URL] = []

    if includeProgram, let filename = recording.programFilename {
      let source = DirectorPaths.program.appendingPathComponent(filename)
      if FileManager.default.fileExists(atPath: source.path) {
        let destination = destinationDirectory.appendingPathComponent(
          RecordingExport.programFilename(startedAt: recording.startedAt)
        )
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.copyItem(at: source, to: destination)
        urls.append(destination)
        progress?(ItemProgress(id: "program", name: "Primary output", fraction: 1))
      }
    }

    for camera in cameras {
      let sourceID = camera.sourceID
      let name = camera.name
      guard let bounds = try index.recordingBounds(id: recording.id, sourceID: sourceID)
      else { continue }
      let destination = destinationDirectory.appendingPathComponent(
        RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: name)
      )
      try? FileManager.default.removeItem(at: destination)
      progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: 0))
      _ = try assembler.assemble(
        sourceID: sourceID,
        from: bounds.start,
        to: bounds.end,
        destination: destination,
        progress: { fraction in
          progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: fraction))
        }
      )
      progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: 1))
      urls.append(destination)
    }

    return urls
  }

  public func availableRange(for sourceID: SourceID) throws -> (start: WallClock, end: WallClock)? {
    try index.timelineBounds(for: sourceID)
  }

  private static func slug(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let mapped = value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
    return String(mapped).prefix(40).description
  }
}

/// Roll-off of old archive material.
///
/// Ordering matters: files are unlinked before their index rows are dropped, so a crash
/// mid-sweep leaves rows pointing at missing files — which `ArchiveIndex.reconcile` cleans up
/// at launch — rather than files nothing knows about, which would leak disk forever.
public struct RetentionPolicy: Sendable {
  public struct Sweep: Sendable, Equatable {
    public var removedSegments: Int
    public var removedProxyStills: Int
    public var reclaimedBytes: Int64
    public var triggeredByDiskPressure: Bool
  }

  private let index: ArchiveIndex
  private let clock: DirectorClock

  public init(index: ArchiveIndex, clock: DirectorClock) {
    self.index = index
    self.clock = clock
  }

  @discardableResult
  public func sweep(
    retentionHours: Double,
    minimumFreeDiskBytes: Int64,
    fileManager: FileManager = .default
  ) throws -> Sweep {
    let free = DirectorPaths.freeDiskBytes()
    let underPressure = free < minimumFreeDiskBytes
    // Disk pressure halves the window rather than deleting everything: the operator keeps as
    // much recent timeline as the device can actually hold.
    let effectiveHours = underPressure ? max(0.25, retentionHours / 2) : retentionHours
    let cutoff = clock.now - effectiveHours * 3600

    var reclaimed: Int64 = 0
    var removed = 0
    for segment in try index.expiredSegments(before: cutoff) {
      let url = DirectorPaths.archiveDirectory(for: segment.sourceID)
        .appendingPathComponent(segment.filename)
      try? fileManager.removeItem(at: url)
      try index.deleteSegment(segment.id)
      reclaimed += segment.byteCount
      removed += 1
    }

    for orphan in try index.orphanedInitializationSegments() {
      let url = DirectorPaths.archiveDirectory(for: orphan.sourceID)
        .appendingPathComponent(orphan.filename)
      try? fileManager.removeItem(at: url)
      try index.deleteSegment(orphan.id)
      reclaimed += orphan.byteCount
    }

    let removedStills = try index.deleteProxyStills(before: cutoff)

    return Sweep(
      removedSegments: removed,
      removedProxyStills: removedStills,
      reclaimedBytes: reclaimed,
      triggeredByDiskPressure: underPressure
    )
  }
}
