import DirectorCore
import DirectorExport
import Foundation

/// The messages GS Director and GS Distributor exchange over the cable. Everything is JSON over
/// HTTP/1.1 except file bodies, which are the files' own bytes.
public enum DistributorProtocol {
  public static let version = 1
  /// GS Director's listener, on loopback; the Mac reaches it through usbmuxd.
  public static let port: UInt16 = 8770
  /// What `/v1/recordings/{id}/still?camera=` takes for the primary output rather than a camera.
  public static let primaryStillCamera = "primary"
}

public struct Hello: Codable, Equatable, Sendable {
  public var deviceName: String
  public var directorVersion: String
  public var protocolVersion: Int
  /// Stable per install of GS Director.
  public var directorID: UUID
  public var isRecording: Bool
  /// New every time GS Director launches. A different one means the Director restarted, and any
  /// job the Mac handed it is gone.
  public var sessionID: UUID

  public init(
    deviceName: String,
    directorVersion: String,
    protocolVersion: Int = DistributorProtocol.version,
    directorID: UUID,
    isRecording: Bool,
    sessionID: UUID
  ) {
    self.deviceName = deviceName
    self.directorVersion = directorVersion
    self.protocolVersion = protocolVersion
    self.directorID = directorID
    self.isRecording = isRecording
    self.sessionID = sessionID
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

  public init(
    id: Int64,
    startedAt: WallClock,
    endedAt: WallClock?,
    isLive: Bool,
    hasPrimary: Bool,
    cameras: [CameraListing],
    preparedTracks: [Track]
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.isLive = isLive
    self.hasPrimary = hasPrimary
    self.cameras = cameras
    self.preparedTracks = preparedTracks
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
  /// The Director is leaving the foreground; its listener goes down until it returns.
  case directorBackgrounded
}

public struct PeerTubeSignIn: Codable, Equatable, Sendable {
  public var host: String
  public var username: String
  public var password: String
  public var otp: String?

  public init(host: String, username: String, password: String, otp: String? = nil) {
    self.host = host
    self.username = username
    self.password = password
    self.otp = otp
  }
}

public enum PeerTubeSignInResult: Codable, Equatable, Sendable {
  case signedIn(account: String)
  /// The account has two-factor sign-in: send the same again with the code.
  case otpRequired
}

/// A short-lived access token the iPad hands the Mac; the refresh token never leaves the iPad.
/// The Mac reads channels and privacy settings, and uploads, with it itself.
public struct PeerTubeToken: Codable, Equatable, Sendable {
  public var host: String
  public var username: String
  public var accessToken: String
  public var expiresAt: Date

  public init(host: String, username: String, accessToken: String, expiresAt: Date) {
    self.host = host
    self.username = username
    self.accessToken = accessToken
    self.expiresAt = expiresAt
  }
}
