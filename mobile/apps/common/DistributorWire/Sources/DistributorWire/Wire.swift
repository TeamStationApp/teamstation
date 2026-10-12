import DirectorCore
import DirectorExport
import Foundation

/// The messages TS Director and TS Distributor exchange over the cable. Everything is JSON over
/// HTTP/1.1 except file bodies, which are the files' own bytes.
public enum DistributorProtocol {
  public static let version = 1
  /// TS Director's listener, on loopback; the Mac reaches it through usbmuxd.
  public static let port: UInt16 = 8770
  /// What `/v1/recordings/{id}/still?camera=` takes for the primary output rather than a camera.
  public static let primaryStillCamera = "primary"
}

public struct Hello: Codable, Equatable, Sendable {
  public var deviceName: String
  public var directorVersion: String
  public var protocolVersion: Int
  /// Stable per install of TS Director.
  public var directorID: UUID
  public var isRecording: Bool
  /// Streaming, like recording, keeps TS Distributor from exporting.
  public var isStreaming: Bool
  /// New every time TS Director launches. A different one means the Director restarted, and any
  /// job the Mac handed it is gone.
  public var sessionID: UUID

  public init(
    deviceName: String,
    directorVersion: String,
    protocolVersion: Int = DistributorProtocol.version,
    directorID: UUID,
    isRecording: Bool,
    isStreaming: Bool = false,
    sessionID: UUID
  ) {
    self.deviceName = deviceName
    self.directorVersion = directorVersion
    self.protocolVersion = protocolVersion
    self.directorID = directorID
    self.isRecording = isRecording
    self.isStreaming = isStreaming
    self.sessionID = sessionID
  }

  /// A Director from before streaming was reported says nothing about it; that reads as not
  /// streaming rather than as a Director that cannot be understood.
  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    deviceName = try container.decode(String.self, forKey: .deviceName)
    directorVersion = try container.decode(String.self, forKey: .directorVersion)
    protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    directorID = try container.decode(UUID.self, forKey: .directorID)
    isRecording = try container.decode(Bool.self, forKey: .isRecording)
    isStreaming = try container.decodeIfPresent(Bool.self, forKey: .isStreaming) ?? false
    sessionID = try container.decode(UUID.self, forKey: .sessionID)
  }
}

/// TS Director's promise to record and stream nothing while TS Distributor exports, until the Mac
/// hands it back or goes away.
public struct ExportLockGranted: Codable, Equatable, Sendable {
  public var lockID: UUID

  public init(lockID: UUID) {
    self.lockID = lockID
  }
}

/// One file of an export: the primary output or one camera.
public enum Track: Hashable, Codable, Sendable {
  case primary
  case camera(SourceID)
}

public struct CameraListing: Codable, Equatable, Sendable {
  public var sourceID: SourceID
  /// What the take recorded the camera as, else what the Director calls it now, else its id.
  public var name: String
  /// False when `name` is only the id, because nothing better is known.
  public var isNamed: Bool
  public var bytes: Int64

  public init(sourceID: SourceID, name: String, isNamed: Bool, bytes: Int64) {
    self.sourceID = sourceID
    self.name = name
    self.isNamed = isNamed
    self.bytes = bytes
  }
}

public struct RecordingListing: Codable, Equatable, Sendable {
  public var id: Int64
  public var startedAt: WallClock
  public var endedAt: WallClock?
  public var isLive: Bool
  public var hasPrimary: Bool
  public var cameras: [CameraListing]
  /// Files already stitched on the iPad, which need only downloading.
  public var preparedTracks: [Track]
  /// Seconds by which the programme master's sound falls short of its picture, read back from the
  /// file at Stop. Zero when the master is whole; nil when this take was never checked — which is
  /// every take recorded before the check was kept, and is not the same as whole.
  ///
  /// Here so a damaged master is visible before anybody exports or uploads it. Takes 413 and 414
  /// were 43.9 s and 46.8 s short, the Director said so at Stop, and it said so only to memory.
  /// See `ProgramSoundCheck`.
  public var soundShortfall: Double?
  /// The TeamStation game TS Director filed this take under: the event chosen in its Settings while
  /// the take was recording. What its files are uploaded to, with nobody asked; nil for a take
  /// recorded with no event chosen, and from a TS Director that does not say.
  public var gameId: String?
  /// That game's dated title, `2026-09-20 Mission Trails at Bandits`, which titles its videos.
  public var gameTitle: String?
  /// The take's once-a-second telemetry log (`rec-<id>-telemetry.jsonl` beside the programme
  /// master), when the Director kept one. TS Distributor saves it beside the take's files.
  public var telemetry: RemoteFile?
  /// How far the server's clock was ahead of the iPad's while the take was made, in milliseconds
  /// (`RecordingSummary.serverClockOffsetMs`). TS Distributor sends it with every upload of the take,
  /// so the server places the video on its own clock, where the game's scoring is. Nil for a take
  /// the iPad never measured, and from a TS Director that does not say.
  public var serverClockOffsetMs: Int?

  public init(
    id: Int64,
    startedAt: WallClock,
    endedAt: WallClock?,
    isLive: Bool,
    hasPrimary: Bool,
    cameras: [CameraListing],
    preparedTracks: [Track],
    soundShortfall: Double? = nil,
    gameId: String? = nil,
    gameTitle: String? = nil,
    telemetry: RemoteFile? = nil,
    serverClockOffsetMs: Int? = nil
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.isLive = isLive
    self.hasPrimary = hasPrimary
    self.cameras = cameras
    self.preparedTracks = preparedTracks
    self.soundShortfall = soundShortfall
    self.gameId = gameId
    self.gameTitle = gameTitle
    self.telemetry = telemetry
    self.serverClockOffsetMs = serverClockOffsetMs
  }
}

/// Where a file lives on the iPad. Paths are relative to the root and never leave it.
public enum FileRoot: String, Codable, Sendable {
  case archives
  case program
  case prepared
}

public struct RemoteFile: Codable, Equatable, Sendable {
  public var root: FileRoot
  public var path: String
  public var bytes: Int64

  public init(root: FileRoot, path: String, bytes: Int64) {
    self.root = root
    self.path = path
    self.bytes = bytes
  }
}

/// What the Mac needs to stitch tracks of a recording itself: the index rows, the window every
/// file of this export is cut to, and the files to fetch.
public struct ManifestResponse: Codable, Equatable, Sendable {
  public var manifest: RecordingManifest
  public var window: ExportWindow
  public var files: [RemoteFile]

  public init(manifest: RecordingManifest, window: ExportWindow, files: [RemoteFile]) {
    self.manifest = manifest
    self.window = window
    self.files = files
  }
}

/// Asks the iPad to stitch one track.
public struct JobRequest: Codable, Equatable, Sendable {
  public var recordingID: Int64
  public var track: Track
  public var window: ExportWindow
  public var reprocess: Bool

  public init(recordingID: Int64, track: Track, window: ExportWindow, reprocess: Bool) {
    self.recordingID = recordingID
    self.track = track
    self.window = window
    self.reprocess = reprocess
  }
}

public struct JobAccepted: Codable, Equatable, Sendable {
  public var jobID: UUID

  public init(jobID: UUID) {
    self.jobID = jobID
  }
}

/// One line of the long-lived event stream, newline-delimited JSON.
public enum DistributorEvent: Codable, Equatable, Sendable {
  case jobProgress(jobID: UUID, fraction: Double)
  case jobFinished(jobID: UUID, file: RemoteFile)
  case jobFailed(jobID: UUID, reason: String)
  case recordingsChanged
  case recordingStateChanged(isRecording: Bool)
  case streamingStateChanged(isStreaming: Bool)
  /// The Director is leaving the foreground; its listener goes down until it returns.
  case directorBackgrounded
}

