import Foundation
import DirectorCore

/// Turns a range of archive files back into something a decoder will open.
///
/// File-based writers emit complete MP4s. Replay stages every file that covers the requested
/// range and plays them in order. Legacy fragmented recordings still use an HLS playlist with
/// `#EXT-X-MAP`, because those media segments have no headers of their own.
///
/// Because every media segment starts on a keyframe, trimming at segment granularity is
/// GOP-rounded by construction rather than by rounding arithmetic.
public struct SegmentAssembler: Sendable {
  private let index: ArchiveIndex
  private let archives: URL

  public init(index: ArchiveIndex, archives: URL = DirectorPaths.archives) {
    self.index = index
    self.archives = archives
  }

  public struct Assembly: Sendable {
    public var url: URL
    /// Wall clock of the first frame in the assembled file.
    public var startWall: WallClock
    public var duration: TimeInterval
    public var segmentCount: Int
    /// Complete MP4s in play order. Empty when `url` is an HLS playlist.
    public var files: [URL] = []
    /// Per-file durations matching `files`, used to skip `startOffset` without opening every asset.
    public var fileDurations: [TimeInterval] = []
    /// Wall clock each staged file starts at, in the same order as `files` — and, for a playlist,
    /// in the same order as the playlist's entries. This is what lets a caller place a segment
    /// where it actually happened instead of where the running total put it.
    public var startWalls: [WallClock] = []
    /// Wall clock the assembly ends at: the last segment's end, not the sum of the durations.
    /// `duration` is media time and is shorter than this by every gap the source left.
    public var endWall: WallClock

    /// The span this assembly covers in real time, gaps included.
    ///
    /// Distinct from `duration` on purpose. A caller asking "is the moment I want inside this?"
    /// means wall clock; a caller asking "how much tape is there?" means `duration`. Answering one
    /// with the other is what made a replay across a gap start too deep in the tape and stop early.
    public var wallSpan: TimeInterval { max(0, endWall - startWall) }

    public init(
      url: URL,
      startWall: WallClock,
      duration: TimeInterval,
      segmentCount: Int,
      files: [URL] = [],
      fileDurations: [TimeInterval] = [],
      startWalls: [WallClock] = [],
      endWall: WallClock
    ) {
      self.url = url
      self.startWall = startWall
      self.duration = duration
      self.segmentCount = segmentCount
      self.files = files
      self.fileDurations = fileDurations
      self.startWalls = startWalls
      self.endWall = endWall
    }

    /// Where `wall` sits in the concatenated media timeline.
    ///
    /// The staged files play back to back with no gap between them, so a wall clock cannot simply
    /// be subtracted from the start: every gap the source left makes real time run ahead of tape
    /// time. This walks the segments and accumulates only tape. A moment inside a gap resolves to
    /// the first frame after it, which is the nearest thing that actually exists.
    public func mediaOffset(forWall wall: WallClock) -> TimeInterval {
      guard !startWalls.isEmpty else { return max(0, wall - startWall) }
      var played: TimeInterval = 0
      for (index, segmentStart) in startWalls.enumerated() {
        let length = index < fileDurations.count ? fileDurations[index] : 0
        if wall < segmentStart { return played }
        if wall < segmentStart + length { return played + (wall - segmentStart) }
        played += length
      }
      return played
    }
  }

  public enum AssemblyError: Error, CustomStringConvertible {
    case noSegments
    case missingInitialization

    public var description: String {
      switch self {
      case .noSegments: "no archived segments cover that time range"
      case .missingInitialization: "the recording's initialisation segment is missing"
      }
    }
  }

  /// Builds a playable file covering `from…to` for one source.
  /// `maximumSegments` bounds work for the replay path, where only the next few seconds matter.
  public func assemble(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    maximumSegments: Int = .max,
    destination: URL? = nil,
    progress: (@Sendable (Double) -> Void)? = nil
  ) throws -> Assembly {
    let resolved = try resolve(sourceID: sourceID, from: from, to: to, maximumSegments: maximumSegments)
    let base = archiveDirectory(for: sourceID)
    let output = destination ?? FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-\(sourceID.slug)-\(UUID().uuidString).mp4")

    try? FileManager.default.removeItem(at: output)
    guard FileManager.default.createFile(atPath: output.path, contents: nil) else {
      throw AssemblyError.noSegments
    }
    let handle = try FileHandle(forWritingTo: output)
    defer { try? handle.close() }

    if let initialization = resolved.initialization {
      try handle.write(contentsOf: Data(contentsOf: base.appendingPathComponent(initialization.filename)))
    } else if resolved.media.count == 1 {
      try handle.write(contentsOf: Data(contentsOf: base.appendingPathComponent(resolved.media[0].filename)))
      return assembly(url: output, media: resolved.media)
    }
    let total = max(resolved.media.count, 1)
    for (index, segment) in resolved.media.enumerated() {
      let url = base.appendingPathComponent(segment.filename)
      guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else { continue }
      try handle.write(contentsOf: data)
      progress?(Double(index + 1) / Double(total))
    }

    return assembly(url: output, media: resolved.media)
  }

  /// Complete MP4s covering `from…to` in play order, without concatenating their bytes.
  public func mediaFiles(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    maximumSegments: Int = .max
  ) throws -> Assembly {
    let resolved = try resolve(sourceID: sourceID, from: from, to: to, maximumSegments: maximumSegments)
    let archive = archiveDirectory(for: sourceID)
    let files = resolved.media.map { archive.appendingPathComponent($0.filename) }
    guard !files.isEmpty else { throw AssemblyError.noSegments }
    let summed = resolved.media.reduce(0) { $0 + $1.duration }
    return Assembly(
      url: files[0],
      startWall: resolved.media[0].startWall,
      duration: summed,
      segmentCount: resolved.media.count,
      files: files,
      fileDurations: resolved.media.map(\.duration),
      startWalls: resolved.media.map(\.startWall),
      endWall: resolved.media.last?.endWall ?? resolved.media[0].startWall
    )
  }

  /// Playlist covering `from…to` for on-device replay. Complete MP4s are staged in order so
  /// `AVAssetReader` can play the whole range; fragmented recordings still get an HLS playlist.
  public func assemblePlaylist(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    maximumSegments: Int = .max
  ) throws -> Assembly {
    let resolved = try resolve(sourceID: sourceID, from: from, to: to, maximumSegments: maximumSegments)
    let archive = archiveDirectory(for: sourceID)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-\(sourceID.slug)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    if resolved.initialization == nil {
      return try stageCompleteFiles(resolved.media, from: archive, into: directory)
    }

    var lines: [String] = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:\(max(1, Int(ceil(resolved.media.map(\.duration).max() ?? 1))))",
      "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-INDEPENDENT-SEGMENTS"
    ]

    let initName = try resolved.initialization.map { try stage($0, from: archive, into: directory) }
    if let initName {
      lines.append("#EXT-X-MAP:URI=\"\(initName)\"")
    }
    for segment in resolved.media {
      let name = try stage(segment, from: archive, into: directory)
      lines.append(String(format: "#EXTINF:%.3f,", max(0.001, segment.duration)))
      lines.append(name)
    }
    lines.append("#EXT-X-ENDLIST")
    lines.append("")

    let playlist = directory.appendingPathComponent("index.m3u8")
    try lines.joined(separator: "\n").write(to: playlist, atomically: true, encoding: .utf8)
    return assembly(url: playlist, media: resolved.media)
  }

  private struct Resolved {
    var initialization: SegmentRecord?
    var media: [SegmentRecord]
  }

  /// Picks the init that belongs to the first media segment, then drops any later media that
  /// was written after a subsequent init (a tier change). Mixing two inits in one file or
  /// playlist is undecodable.
  private func resolve(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    maximumSegments: Int
  ) throws -> Resolved {
    var segments = try index.segments(for: sourceID, from: from, to: to)
    if segments.isEmpty {
      // A scrub can land just past the end of the last segment; fall back to the segment
      // containing the start so the operator sees the nearest real frame rather than an error.
      guard let fallback = try index.segment(for: sourceID, containing: from) else {
        throw AssemblyError.noSegments
      }
      segments = [ fallback ]
    }
    if segments.count > maximumSegments {
      segments = Array(segments.prefix(maximumSegments))
    }

    let initialization = try index.initializationSegment(
      for: sourceID,
      recordingID: segments[0].recordingID,
      beforeSequence: segments[0].sequence
    )
    if initialization == nil {
      let media = segments.filter { !$0.isInitialization }
      guard !media.isEmpty else { throw AssemblyError.noSegments }
      return Resolved(initialization: nil, media: media)
    }
    guard let initialization else { throw AssemblyError.missingInitialization }

    let nextInit = try index.nextInitializationSequence(
      for: sourceID,
      recordingID: initialization.recordingID,
      after: initialization.sequence
    )
    let media = segments.filter { segment in
      segment.recordingID == initialization.recordingID
        && segment.sequence > initialization.sequence
        && nextInit.map { segment.sequence < $0 } ?? true
    }
    guard !media.isEmpty else { throw AssemblyError.noSegments }
    return Resolved(initialization: initialization, media: media)
  }

  private func archiveDirectory(for sourceID: SourceID) -> URL {
    archives.appendingPathComponent(sourceID.slug, isDirectory: true)
  }

  private func stageCompleteFiles(
    _ media: [SegmentRecord],
    from archive: URL,
    into directory: URL
  ) throws -> Assembly {
    guard !media.isEmpty else { throw AssemblyError.noSegments }
    var files: [URL] = []
    files.reserveCapacity(media.count)
    for file in media {
      let name = try stage(file, from: archive, into: directory)
      files.append(directory.appendingPathComponent(name))
    }
    return Assembly(
      url: files[0],
      startWall: media[0].startWall,
      duration: media.reduce(0) { $0 + $1.duration },
      segmentCount: media.count,
      files: files,
      fileDurations: media.map(\.duration),
      startWalls: media.map(\.startWall),
      endWall: media.last?.endWall ?? media[0].startWall
    )
  }

  private func stage(_ segment: SegmentRecord, from archive: URL, into directory: URL) throws -> String {
    let source = archive.appendingPathComponent(segment.filename)
    let name = source.lastPathComponent
    let destination = directory.appendingPathComponent(name)
    do {
      try FileManager.default.linkItem(at: source, to: destination)
    } catch {
      try FileManager.default.copyItem(at: source, to: destination)
    }
    return name
  }

  private func assembly(url: URL, media: [SegmentRecord]) -> Assembly {
    Assembly(
      url: url,
      startWall: media[0].startWall,
      duration: media.reduce(0) { $0 + $1.duration },
      segmentCount: media.count,
      fileDurations: media.map(\.duration),
      startWalls: media.map(\.startWall),
      endWall: media.last?.endWall ?? media[0].startWall
    )
  }
}
