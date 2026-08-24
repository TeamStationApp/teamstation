import Foundation
import DirectorCore

/// Turns a range of fMP4 segments back into something a decoder will open.
///
/// Segmented `AVAssetWriter` output is an HLS-shaped stream: one initialisation segment
/// carrying the moov box, then media segments that contain no headers at all. A media segment
/// on its own is undecodable.
///
/// Two consumers need two shapes:
/// - **Export** concatenates `init + media…` into one file. ffmpeg and QuickTime accept that.
/// - **Replay** cannot: iOS `AVAssetReader` does not decode `mpeg4AppleHLS` HEVC+AAC concat.
///   Replay therefore copies the same files into a temp directory and writes an HLS playlist
///   (`#EXT-X-MAP`) that `AVPlayer` will play.
///
/// Because every media segment starts on a keyframe, trimming at segment granularity is
/// GOP-rounded by construction rather than by rounding arithmetic.
public struct SegmentAssembler: Sendable {
  private let index: ArchiveIndex

  public init(index: ArchiveIndex) {
    self.index = index
  }

  public struct Assembly: Sendable {
    public var url: URL
    /// Wall clock of the first frame in the assembled file.
    public var startWall: WallClock
    public var duration: TimeInterval
    public var segmentCount: Int
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
    let base = DirectorPaths.archiveDirectory(for: sourceID)
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

  /// HLS playlist covering `from…to`, for on-device replay. `AVPlayer` can decode the
  /// `mpeg4AppleHLS` fragments this writer produces; a concatenated `.mp4` of the same bytes
  /// cannot be opened by `AVAssetReader`.
  public func assemblePlaylist(
    sourceID: SourceID,
    from: WallClock,
    to: WallClock,
    maximumSegments: Int = .max
  ) throws -> Assembly {
    let resolved = try resolve(sourceID: sourceID, from: from, to: to, maximumSegments: maximumSegments)
    let archive = DirectorPaths.archiveDirectory(for: sourceID)
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("replay-\(sourceID.slug)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    // File-based writers emit complete MP4s. HLS with no init MAP cannot play those, so replay
    // the last complete file directly.
    if resolved.initialization == nil, let file = resolved.media.last {
      let name = try stage(file, from: archive, into: directory)
      return assembly(url: directory.appendingPathComponent(name), media: [file])
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
      segmentCount: media.count
    )
  }
}
