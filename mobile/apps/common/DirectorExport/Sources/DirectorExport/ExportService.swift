import Foundation
import DirectorCore

/// Post-event export.
///
/// Every camera file is **re-encoded** at the take's raw camera settings: one frame rate, one size,
/// one codec, whatever each camera actually sent. Frame n of every camera file is the same instant,
/// `n / frameRate` into the take, so files cut together line up frame for frame, and a camera that
/// dropped out repeats its last picture as real frames rather than one sample stretched over the
/// hole. The programme master is copied as it was recorded when it is unbroken, and re-encoded the
/// same way as a camera when it is not: see `ProgrammeExport`.
///
/// The settings are the ones the take was recorded with. A take from before they were kept with it
/// uses `fallbackEncoding`, which the app that makes the service provides from its own settings.
public struct ExportService: Sendable {
  public struct Result: Sendable, Equatable {
    public var url: URL
    public var startWall: WallClock
    public var duration: TimeInterval
    public var byteCount: Int64
    public var segmentCount: Int
    /// How far the file's start is from the requested start. Zero: a re-encoded export starts exactly
    /// where it was asked to, keyframe or not.
    public var startAdjustment: TimeInterval
  }

  private let index: ArchiveIndex
  private let assembler: SegmentAssembler
  private let programDirectory: URL
  private let fallbackEncoding: @Sendable () -> TakeEncoding
  /// A phone's programme shows the absence between parts as a hole on the wall clock, black every
  /// frame (`ArchiveRemux.stitch`'s `blankGaps`).
  private let blankProgrammeHoles: Bool

  /// `fallbackEncoding` is asked, at the time of each export, for the encoding of a take that has
  /// none of its own: TS Director answers with its settings as they are then, TS Distributor with the
  /// defaults.
  public init(
    index: ArchiveIndex,
    archives: URL = DirectorPaths.archives,
    programDirectory: URL = DirectorPaths.program,
    fallbackEncoding: @escaping @Sendable () -> TakeEncoding = { AppConfig().takeEncoding },
    blankProgrammeHoles: Bool = false
  ) {
    self.index = index
    self.assembler = SegmentAssembler(index: index, archives: archives)
    self.programDirectory = programDirectory
    self.fallbackEncoding = fallbackEncoding
    self.blankProgrammeHoles = blankProgrammeHoles
  }

  /// The encoding `recording`'s exports are made with.
  public func encoding(of recording: RecordingSummary) -> TakeEncoding {
    recording.encoding ?? fallbackEncoding()
  }

  /// One camera from `from` to `to`, re-encoded at the raw camera settings of the take it belongs to.
  /// The file starts at exactly `from`.
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
    let recordingID = try index.segments(for: sourceID, from: from, to: to).first?.recordingID
    let recorded = try recordingID.flatMap { id in try index.recordings().first { $0.id == id }?.encoding }
    try await ArchiveRemux.stitch(
      files: assembly.files,
      fileDurations: assembly.fileDurations,
      startWalls: assembly.startWalls,
      windowStart: from,
      length: max(0, to - from),
      settings: (recorded ?? fallbackEncoding()).rawCamera,
      destination: destination
    )

    let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
    let byteCount = (attributes[.size] as? NSNumber)?.int64Value ?? 0

    return Result(
      url: destination,
      startWall: from,
      duration: max(0, to - from),
      byteCount: byteCount,
      segmentCount: assembly.segmentCount,
      startAdjustment: 0
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
  ///
  /// `window` cuts every file to a window worked out beforehand, so the parts of one export that
  /// are stitched on different machines come out the same length. Without it, `exportWindow` over
  /// `cameras` decides.
  public func exportRecording(
    _ recording: RecordingSummary,
    cameras: [(sourceID: SourceID, name: String)],
    includeProgram: Bool,
    programDirectory: URL? = nil,
    preparedRoot: URL = DirectorPaths.prepared,
    reprocess: Bool = false,
    window: ExportWindow? = nil,
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
    let window = window ?? exportWindow(recording, sourceIDs: cameras.map(\.sourceID))
    let latestStart = window.start
    let earliestEnd = window.end

    if includeProgram, let filename = recording.programFilename {
      let sources = RecordingExport.programSourceFiles(named: filename, in: programDir)
      if !sources.isEmpty {
        let destination = directory.appendingPathComponent(
          RecordingExport.programFilename(startedAt: recording.startedAt)
        )
        progress?(ItemProgress(id: "program", name: "Primary output", fraction: 0))
        if reprocess || !Self.isUsableFile(destination) {
          try? FileManager.default.removeItem(at: destination)
          try await exportProgramme(
            recording,
            parts: sources,
            windowStart: latestStart,
            // The same window the cameras get, so the programme is the length of the take rather
            // than the length of whatever survived being written.
            windowEnd: earliestEnd ?? duration.map { latestStart + $0 },
            destination: destination,
            progress: progress.map { report in
              { @Sendable fraction in
                report(ItemProgress(id: "program", name: "Primary output", fraction: fraction))
              }
            }
          )
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
        try await ArchiveRemux.stitch(
          files: assembly.files,
          fileDurations: assembly.fileDurations,
          startWalls: assembly.startWalls,
          windowStart: from,
          length: max(0, to - from),
          settings: encoding(of: recording).rawCamera,
          destination: destination,
          progress: progress.map { report in
            { @Sendable fraction in
              report(ItemProgress(id: sourceID.rawValue, name: name, fraction: fraction))
            }
          }
        )
      }
      progress?(ItemProgress(id: sourceID.rawValue, name: name, fraction: 1))
      urls.append(destination)
    }

    return urls
  }

  /// The programme master for the window: copied when `ProgrammeExport.plan` finds it unbroken,
  /// re-encoded at the take's programme settings when it does not.
  ///
  /// Re-encoded parts are placed by wall clock when the programme recorded where it was. Without
  /// anchors they are laid end to end, which is why a stress run found the cameras exact at every
  /// sample and the programme drifting to seven seconds ahead: a writer that died and was recovered
  /// leaves a continuation part, and butting it against its predecessor discards however long the
  /// recovery took. Anchors give each part the wall clock its own timeline starts at, so a part goes
  /// where it happened and the gap it left repeats its last picture.
  private func exportProgramme(
    _ recording: RecordingSummary,
    parts: [URL],
    windowStart: WallClock,
    windowEnd: WallClock?,
    destination: URL,
    progress: (@Sendable (Double) -> Void)?
  ) async throws {
    let settings = encoding(of: recording).programme
    let anchors = (try? index.programAnchors(recordingID: recording.id)) ?? []
    // Only a lone part can be copied, so only a lone part is worth reading through.
    let reading = parts.count == 1 ? try await ProgrammeExport.read(parts[0]) : nil
    let plan = ProgrammeExport.plan(
      partCount: parts.count,
      resumeCount: recording.resumeCount,
      anchors: anchors,
      reading: reading,
      windowStart: windowStart,
      windowEnd: windowEnd,
      frameRate: settings.frameRate
    )
    switch plan {
    case let .copy(partStart):
      try await ArchiveRemux.copyProgramme(
        part: parts[0],
        offset: windowStart - partStart,
        length: windowEnd.map { max(0, $0 - windowStart) },
        destination: destination,
        progress: progress
      )
    case .reencode:
      let partStarts = ArchiveIndex.partStarts(anchors)
      let startWalls = (1 ... parts.count).compactMap { partStarts[$0] }
      let placed = startWalls.count == parts.count
      try await ArchiveRemux.stitch(
        files: parts,
        fileDurations: parts.map { _ in 0 },
        startWalls: placed ? startWalls : [],
        windowStart: placed ? windowStart : nil,
        length: windowEnd.map { max(0, $0 - windowStart) },
        settings: settings,
        destination: destination,
        blankGaps: blankProgrammeHoles,
        progress: progress
      )
    }
  }

  /// The window `exportRecording` cuts every file to: the recording's own span or, for a take that
  /// never recorded its end, out to the last segment any of `sourceIDs` wrote. Giving the same
  /// window to every machine that stitches part of an export keeps their files the same length.
  public func exportWindow(_ recording: RecordingSummary, sourceIDs: [SourceID]) -> ExportWindow {
    var end = recording.endedAt
    if end == nil {
      for sourceID in sourceIDs {
        guard let bounds = try? index.recordingBounds(id: recording.id, sourceID: sourceID)
        else { continue }
        if let current = end {
          if bounds.end > current { end = bounds.end }
        } else {
          end = bounds.end
        }
      }
    }
    return ExportWindow(start: recording.startedAt, end: end)
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
  ///
  /// `freeDiskBytes` is a free-space reading the caller took just before calling, so a caller on
  /// the main thread can take it off that thread (`FreeDiskSpace.measured()`); nil measures here.
  /// After each recording removed, free space is measured again here either way.
  @discardableResult
  public func sweep(
    maximumArchiveBytes: Int64,
    freeDiskFloorBytes: Int64,
    protecting liveRecordingID: Int64? = nil,
    freeDiskBytes measuredFree: Int64? = nil,
    fileManager: FileManager = .default
  ) throws -> Sweep {
    var archived = try index.totalBytes()
    var free = measuredFree ?? DirectorPaths.freeDiskBytes()
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
