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
  private let programDirectory: URL

  public init(
    index: ArchiveIndex,
    archives: URL = DirectorPaths.archives,
    programDirectory: URL = DirectorPaths.program
  ) {
    self.index = index
    self.assembler = SegmentAssembler(index: index, archives: archives)
    self.programDirectory = programDirectory
  }

  public func export(
    sourceID: SourceID,
    displayName: String,
    from: WallClock,
    to: WallClock,
    destinationDirectory: URL = DirectorPaths.exports
  ) async throws -> Result {
    try FileManager.default.createDirectory(at: destinationDirectory, withIntermediateDirectories: true)

    let formatter = DateFormatter()
    formatter.dateFormat = "yyyyMMdd-HHmmss"
    let name = "\(Self.slug(displayName))-\(formatter.string(from: from.date)).mp4"
    let destination = destinationDirectory.appendingPathComponent(name)

    let assembly = try assembler.mediaFiles(
      sourceID: sourceID,
      from: from,
      to: to
    )
    try await ArchiveRemux.concatenate(
      files: assembly.files,
      fileDurations: assembly.fileDurations,
      targetDuration: max(0, to - from),
      destination: destination
    )

    let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
    let byteCount = (attributes[.size] as? NSNumber)?.int64Value ?? 0

    return Result(
      url: destination,
      startWall: assembly.startWall,
      duration: max(0, to - from),
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
  ///
  /// Results live in `Prepared/rec-{id}/` next to the archive, not a throwaway Exports dump, so a
  /// later share can skip remux. `reprocess` rebuilds those files from the originals.
  public func exportRecording(
    _ recording: RecordingSummary,
    cameras: [(sourceID: SourceID, name: String)],
    includeProgram: Bool,
    programDirectory: URL? = nil,
    preparedRoot: URL = DirectorPaths.prepared,
    reprocess: Bool = false,
    progress: (@Sendable (ItemProgress) -> Void)? = nil
  ) async throws -> [URL] {
    let programDir = programDirectory ?? self.programDirectory
    let directory = RecordingExport.preparedDirectory(recordingID: recording.id, in: preparedRoot)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var urls: [URL] = []
    let duration = recording.endedAt.map { $0 - recording.startedAt }

    // One wall-clock window, the recording's own, for every camera and the programme alike.
    //
    // Each output is now built by placing segments where they happened rather than end to end, so
    // a camera that joined late or dropped out contributes silence where it had nothing instead of
    // dragging its later frames earlier. That makes the recording's span usable directly: every
    // file is the same length, every file maps position to wall clock the same way, and an event
    // 31:30 into the take is 31:30 into all of them.
    //
    // This replaces trimming to the overlap the cameras shared. That trim existed to hide a ~620 ms
    // disagreement at the head, which was a symptom of the running-cursor placement rather than a
    // fact about the footage, and it threw away real material at both ends to do it.
    let latestStart = recording.startedAt
    var earliestEnd = recording.endedAt
    if earliestEnd == nil {
      for camera in cameras {
        guard let bounds = try? index.recordingBounds(id: recording.id, sourceID: camera.sourceID)
        else { continue }
        if let current = earliestEnd {
          if bounds.end > current { earliestEnd = bounds.end }
        } else {
          earliestEnd = bounds.end
        }
      }
    }

    if includeProgram, let filename = recording.programFilename {
      let sources = RecordingExport.programSourceFiles(named: filename, in: programDir)
      if !sources.isEmpty {
        let destination = directory.appendingPathComponent(
          RecordingExport.programFilename(startedAt: recording.startedAt)
        )
        progress?(ItemProgress(id: "program", name: "Primary output", fraction: 0))
        if reprocess || !Self.isUsableFile(destination) {
          try? FileManager.default.removeItem(at: destination)
          if sources.count == 1, duration == nil {
            try FileManager.default.copyItem(at: sources[0], to: destination)
          } else {
            // Placed by wall clock when the programme recorded where it was.
            //
            // Without anchors the parts are laid end to end, which is why a stress run found the
            // cameras exact at every sample and the programme drifting to seven seconds ahead: a
            // writer that died and was recovered leaves a continuation part, and butting it against
            // its predecessor discards however long the recovery took. Anchors give each part the
            // wall clock its own timeline starts at, so a part goes where it happened and the gap
            // it left is held.
            let partStarts = (try? index.programPartStarts(recordingID: recording.id)) ?? [:]
            let startWalls: [WallClock] = partStarts.isEmpty
              ? []
              : (1...sources.count).compactMap { partStarts[$0] }
            try await ArchiveRemux.concatenate(
              files: sources,
              fileDurations: sources.map { _ in 0 },
              // The same window the cameras get, so the programme is the length of the take rather
              // than the length of whatever survived being written.
              targetDuration: earliestEnd.map { max(0, $0 - latestStart) } ?? duration,
              startWalls: startWalls.count == sources.count ? startWalls : [],
              windowStart: startWalls.count == sources.count ? latestStart : nil,
              destination: destination
            )
          }
        }
        urls.append(destination)
        progress?(ItemProgress(id: "program", name: "Primary output", fraction: 1))
      }
    }

    for camera in cameras {
      let sourceID = camera.sourceID
      let name = camera.name
      let from = latestStart
      let to: WallClock
      if let common = earliestEnd, common > latestStart {
        to = common
      } else if let ended = recording.endedAt {
        to = ended
      } else if let bounds = try index.recordingBounds(id: recording.id, sourceID: sourceID) {
        to = bounds.end
      } else {
        continue
      }
      let destination = directory.appendingPathComponent(
        RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: name)
      )
      progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: 0))
      if reprocess || !Self.isUsableFile(destination) {
        try? FileManager.default.removeItem(at: destination)
        let assembly = try assembler.mediaFiles(
          sourceID: sourceID,
          from: from,
          to: to
        )
        try await ArchiveRemux.concatenate(
          files: assembly.files,
          fileDurations: assembly.fileDurations,
          targetDuration: max(0, to - from),
          startWalls: assembly.startWalls,
          windowStart: from,
          destination: destination
        )
      }
      progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: 1))
      urls.append(destination)
    }

    return urls
  }

  /// True when every selected output already has a non-empty remux on disk.
  public func hasPreparedExport(
    _ recording: RecordingSummary,
    cameras: [(sourceID: SourceID, name: String)],
    includeProgram: Bool,
    programDirectory: URL? = nil,
    preparedRoot: URL = DirectorPaths.prepared
  ) -> Bool {
    let planned = plannedDestinations(
      recording,
      cameras: cameras,
      includeProgram: includeProgram,
      programDirectory: programDirectory ?? self.programDirectory,
      preparedRoot: preparedRoot
    )
    guard !planned.isEmpty else { return false }
    return planned.allSatisfy(Self.isUsableFile)
  }

  private func plannedDestinations(
    _ recording: RecordingSummary,
    cameras: [(sourceID: SourceID, name: String)],
    includeProgram: Bool,
    programDirectory: URL,
    preparedRoot: URL
  ) -> [URL] {
    let directory = RecordingExport.preparedDirectory(recordingID: recording.id, in: preparedRoot)
    var urls: [URL] = []
    if includeProgram, let filename = recording.programFilename {
      if !RecordingExport.programSourceFiles(named: filename, in: programDirectory).isEmpty {
        urls.append(
          directory.appendingPathComponent(
            RecordingExport.programFilename(startedAt: recording.startedAt)
          )
        )
      }
    }
    for camera in cameras {
      urls.append(
        directory.appendingPathComponent(
          RecordingExport.cameraFilename(startedAt: recording.startedAt, cameraName: camera.name)
        )
      )
    }
    return urls
  }

  private static func isUsableFile(_ url: URL) -> Bool {
    guard let size = try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber
    else { return false }
    return size.int64Value > 0
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
/// Sized, not timed. Whole recordings go, oldest first, and only once the archive is over its
/// ceiling or the volume is under its floor. A clock-based window discarded a 109-minute game
/// the morning after it was shot — six hours had passed, which said nothing about whether the
/// device needed the space.
///
/// Only the rolling camera archive is reclaimed. The programme master and anything already
/// prepared for export are the operator's deliverables; those go when the operator deletes the
/// recording, never on a sweep.
public struct RetentionPolicy: Sendable {
  public struct Sweep: Sendable, Equatable {
    public var removedRecordings: Int
    public var removedSegments: Int
    public var removedProxyStills: Int
    public var reclaimedBytes: Int64
    public var triggeredByDiskPressure: Bool
    /// True when the archive is still over budget with nothing left that may be swept, so the
    /// caller can say so rather than let the device quietly run out.
    public var exhausted: Bool
  }

  private let index: ArchiveIndex
  private let roots: RecordingFileRoots

  public init(index: ArchiveIndex, roots: RecordingFileRoots = .standard) {
    self.index = index
    self.roots = roots
  }

  /// `protecting` is the take being written right now. It is never swept, however far over
  /// budget the archive has run: dropping the recording out from under the writer would take the
  /// operator's live game away to make room for itself.
  @discardableResult
  public func sweep(
    maximumArchiveBytes: Int64,
    freeDiskFloorBytes: Int64,
    protecting liveRecordingID: Int64? = nil,
    fileManager: FileManager = .default
  ) throws -> Sweep {
    var archived = try index.totalBytes()
    var free = DirectorPaths.freeDiskBytes()
    let startedUnderPressure = free < freeDiskFloorBytes

    var removedRecordings = 0
    var removedSegments = 0
    var removedStills = 0
    var reclaimed: Int64 = 0
    var exhausted = false

    while archived > maximumArchiveBytes || free < freeDiskFloorBytes {
      guard let oldest = try index.oldestRecordingWithSegments() else {
        exhausted = true
        break
      }
      // The live take is the only exemption, and if it is all that is left there is nothing
      // more to reclaim — stop rather than spin.
      if oldest.id == liveRecordingID {
        exhausted = true
        break
      }
      let removed = try index.deleteArchive(
        forRecording: oldest.id,
        roots: roots,
        fileManager: fileManager
      )
      guard removed.segments > 0 else {
        exhausted = true
        break
      }
      removedRecordings += 1
      removedSegments += removed.segments
      removedStills += removed.stills
      reclaimed += removed.bytes
      archived -= removed.bytes
      // Re-read rather than assuming the unlink landed: exports and the programme writer are
      // moving the same volume underneath this loop.
      free = DirectorPaths.freeDiskBytes()
    }

    for orphan in try index.orphanedInitializationSegments() {
      let url = roots.archiveDirectory(for: orphan.sourceID)
        .appendingPathComponent(orphan.filename)
      try? fileManager.removeItem(at: url)
      try index.deleteSegment(orphan.id)
      reclaimed += orphan.byteCount
    }

    return Sweep(
      removedRecordings: removedRecordings,
      removedSegments: removedSegments,
      removedProxyStills: removedStills,
      reclaimedBytes: reclaimed,
      triggeredByDiskPressure: startedUnderPressure,
      exhausted: exhausted
    )
  }
}
