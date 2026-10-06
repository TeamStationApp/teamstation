import DirectorCore
import Foundation

/// One second of a take, as `TakeTelemetryLog` writes it: what the iPad was doing, in one line of
/// JSON. Three defects of the first games could not be diagnosed because none of this was kept: why
/// one live stream started losing ticks partway through, why one programme recording froze
/// for 38 s, and why several files lost sound within 2 s of each other.
public struct TakeTelemetryLine: Codable, Equatable, Sendable {
  public struct Camera: Codable, Equatable, Sendable {
    public var tile: Int
    public var name: String
    /// Pictures arriving per second, and pictures that reached the tile's display.
    public var receivedFps: Double
    public var shownFps: Double
    public var playoutMs: Double
    public var captureAgeMs: Double
    public var clockSteps: UInt64
    /// This camera's sound on its timeline; empty state when it is not mixed.
    public var soundState: String
    public var soundHeldMs: Double
    public var soundFades: UInt64
    public var soundConcealedMs: Double
    public var soundDriftPpm: Double
    public var soundSteps: UInt64
    public var soundTimelines: UInt64
    public var soundReanchors: UInt64
    public var soundGaps: UInt64
    public var soundErrorMs: Double
  }

  /// Wall clock, seconds since 1970, and the take.
  public var t: Double
  public var recording: Int64
  public var thermal: String
  /// The programme clock: its worst lateness over the last second, and ticks it has missed.
  public var tickLatenessMaxMs: Double
  public var missedTicks: UInt64
  public var composedFps: Double
  public var programmeLatePictures: UInt64
  public var programmeSkippedPictures: UInt64
  /// The stream's encoder and socket.
  public var streaming: Bool
  public var streamPendingEncodes: Int
  public var streamDroppedPackets: UInt64
  public var streamQueuedBytes: Int
  public var streamDisconnects: UInt64
  /// D: how long after capture the live mix plays a camera's sound.
  public var liveSoundDelayMs: Double
  public var liveMixFades: UInt64
  public var liveMixConcealedSeconds: Double
  public var recordingMixFades: UInt64
  public var recordingMixConcealedSeconds: Double
  public var cameras: [Camera]

  public init(snapshot: TelemetrySnapshot, recording: Int64, at wall: Double) {
    t = (wall * 1_000).rounded() / 1_000
    self.recording = recording
    thermal = snapshot.thermalState
    tickLatenessMaxMs = snapshot.programmeTickLatenessMaxMilliseconds
    missedTicks = snapshot.programmeMissedTicks
    composedFps = snapshot.composedFramesPerSecond
    programmeLatePictures = snapshot.programmeLatePictures
    programmeSkippedPictures = snapshot.programmeSkippedPictures
    streaming = snapshot.isStreaming
    streamPendingEncodes = snapshot.streamPendingEncodes
    streamDroppedPackets = snapshot.streamDroppedPackets
    streamQueuedBytes = snapshot.streamQueuedBytes
    streamDisconnects = snapshot.streamDisconnects
    liveSoundDelayMs = snapshot.liveSoundDelayMilliseconds
    liveMixFades = snapshot.audioMixFades
    liveMixConcealedSeconds = snapshot.audioMixConcealedSeconds
    recordingMixFades = snapshot.recordingMixFades
    recordingMixConcealedSeconds = snapshot.recordingMixConcealedSeconds
    cameras = snapshot.tiles.compactMap { tile in
      guard tile.sourceID != nil else { return nil }
      return Camera(
        tile: tile.index,
        name: tile.displayName ?? tile.sourceID ?? "",
        receivedFps: tile.framesPerSecond,
        shownFps: tile.displayedFramesPerSecond,
        playoutMs: tile.playoutMilliseconds,
        captureAgeMs: tile.correctedCaptureAgeMilliseconds,
        clockSteps: tile.cameraClockSteps,
        soundState: tile.soundState,
        soundHeldMs: tile.soundHeldMilliseconds,
        soundFades: tile.soundFades,
        soundConcealedMs: tile.soundConcealedMilliseconds,
        soundDriftPpm: tile.soundDriftPartsPerMillion,
        soundSteps: tile.soundSteps,
        soundTimelines: tile.soundTimelines,
        soundReanchors: tile.soundReanchors,
        soundGaps: tile.soundGaps,
        soundErrorMs: tile.soundErrorMilliseconds
      )
    }
  }
}

/// Appends a `TakeTelemetryLine` once a second to the take's `rec-<id>-telemetry.jsonl` beside its
/// programme master, while a take is recording; TS Distributor fetches it with the take.
///
/// Driven by whatever polls telemetry: `note` is called with the take that is recording, or nil,
/// and opens, writes, switches and closes the file accordingly. A take picked up again after the
/// app stopped carries on in the same file.
public final class TakeTelemetryLog: @unchecked Sendable {
  public static let intervalSeconds = 1.0

  public static func filename(for recording: Int64) -> String { "rec-\(recording)-telemetry.jsonl" }

  private let directory: URL
  private let lock = NSLock()
  private var handle: FileHandle?
  private var recording: Int64?
  private var lastWrite: Double?
  /// The programme clock's worst lateness over the notes since the last line: the telemetry is
  /// polled faster than the log is written, and each poll reads the worst since the one before.
  private var latenessSinceWrite: Double = 0
  private let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .sortedKeys ]
    return encoder
  }()

  public init(directory: URL) {
    self.directory = directory
  }

  /// The file for `recording`.
  public func url(for recording: Int64) -> URL {
    directory.appendingPathComponent(Self.filename(for: recording))
  }

  /// The take now recording, if any, and the telemetry as it is. Writes when a second has passed.
  public func note(recording: Int64?, snapshot: TelemetrySnapshot, at wall: Double) {
    lock.lock()
    defer { lock.unlock() }
    if recording != self.recording { closeLocked() }
    guard let recording else { return }
    latenessSinceWrite = max(latenessSinceWrite, snapshot.programmeTickLatenessMaxMilliseconds)
    if let lastWrite, wall - lastWrite < Self.intervalSeconds - 0.001 { return }
    if handle == nil {
      let url = url(for: recording)
      try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
      }
      handle = try? FileHandle(forWritingTo: url)
      _ = try? handle?.seekToEnd()
      self.recording = recording
    }
    var line = TakeTelemetryLine(snapshot: snapshot, recording: recording, at: wall)
    line.tickLatenessMaxMs = latenessSinceWrite
    guard let handle, var data = try? encoder.encode(line) else { return }
    data.append(0x0A)
    try? handle.write(contentsOf: data)
    lastWrite = wall
    latenessSinceWrite = 0
  }

  /// Whether a file is open: a take is being logged.
  public var isOpen: Bool {
    lock.lock()
    defer { lock.unlock() }
    return handle != nil
  }

  public func close() {
    lock.lock()
    closeLocked()
    lock.unlock()
  }

  private func closeLocked() {
    try? handle?.close()
    handle = nil
    recording = nil
    lastWrite = nil
    latenessSinceWrite = 0
  }
}
