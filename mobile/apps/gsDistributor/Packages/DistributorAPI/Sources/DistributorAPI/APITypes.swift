import DistributorWire
import Foundation

// What the API sends and takes. Dates are ISO 8601; a file of a recording is named by its track:
// "primary", or "camera:<source id>", and wherever a track is asked for a camera's name will do.

/// The iPad as the Distributor sees it.
public struct APIIPad: Codable, Equatable, Sendable {
  /// "attached", "waitingForDirector" (an iPad is on the cable but GS Director is not answering),
  /// "none", or "failed".
  public var state: String
  public var name: String?
  public var directorVersion: String?
  public var isRecording: Bool
  public var isStreaming: Bool
  /// What to do about it, when anything needs doing.
  public var message: String?

  public init(state: String, name: String? = nil, directorVersion: String? = nil, isRecording: Bool = false, isStreaming: Bool = false, message: String? = nil) {
    self.state = state
    self.name = name
    self.directorVersion = directorVersion
    self.isRecording = isRecording
    self.isStreaming = isStreaming
    self.message = message
  }
}

public struct APIStatus: Codable, Equatable, Sendable {
  public var iPad: APIIPad
  /// This Mac's export folder; nil until one is chosen.
  public var destination: String?
  /// The export under way, or the last one, until it is put away.
  public var run: APIRun?
  public var gameStation: APIGameStation

  public init(iPad: APIIPad, destination: String?, run: APIRun?, gameStation: APIGameStation) {
    self.iPad = iPad
    self.destination = destination
    self.run = run
    self.gameStation = gameStation
  }
}

/// One file of a recording and where it has got to.
public struct APIFile: Codable, Equatable, Sendable {
  public var track: String
  public var name: String
  /// "saved", "interrupted" (a download or render cut off part way), or "missing".
  public var onMac: String
  public var bytesOnMac: Int64?
  /// Where it is, or will be, on this Mac.
  public var path: String?
  /// Already stitched on the iPad, so it needs only downloading.
  public var preparedOnIPad: Bool

  public init(track: String, name: String, onMac: String, bytesOnMac: Int64?, path: String?, preparedOnIPad: Bool) {
    self.track = track
    self.name = name
    self.onMac = onMac
    self.bytesOnMac = bytesOnMac
    self.path = path
    self.preparedOnIPad = preparedOnIPad
  }
}

public struct APIRecording: Codable, Equatable, Sendable {
  public var id: Int64
  public var startedAt: Date
  public var endedAt: Date?
  public var isLive: Bool
  public var files: [APIFile]
  public var combined: APIFile
  /// This recording's folder on the Mac; nil until an export folder is chosen.
  public var folder: String?

  public init(id: Int64, startedAt: Date, endedAt: Date?, isLive: Bool, files: [APIFile], combined: APIFile, folder: String?) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.isLive = isLive
    self.files = files
    self.combined = combined
    self.folder = folder
  }
}

public struct APIRecordingList: Codable, Equatable, Sendable {
  /// "iPad" for the attached iPad's list, "cache" for the last list seen from an iPad that is away.
  public var source: String
  public var iPadName: String?
  /// For a cached list, when it was read from the iPad.
  public var savedAt: Date?
  public var recordings: [APIRecording]

  public init(source: String, iPadName: String?, savedAt: Date?, recordings: [APIRecording]) {
    self.source = source
    self.iPadName = iPadName
    self.savedAt = savedAt
    self.recordings = recordings
  }
}

/// Which run a request starts. Each is one export run with different parts in it.
public enum APIRunKind: String, Codable, Sendable {
  /// The chosen files onto the Mac, stitched on the Mac and the iPad; nothing else.
  case download
  /// The files, then the combined video and the uploads as the settings say, unless the request
  /// says otherwise.
  case export
  /// The combined video, made from the files, fetching any that are not here yet.
  case combined
  /// Uploads of files already on the Mac.
  case upload
  /// Exactly what the request lists.
  case custom
}

public struct APICombinedRequest: Codable, Equatable, Sendable {
  /// Which videos go in, by name ("Primary output" for the primary output); nil for up to four,
  /// the primary output first.
  public var include: [String]?
  /// Whose sound it carries; nil for the one last chosen.
  public var audioCamera: String?

  public init(include: [String]? = nil, audioCamera: String? = nil) {
    self.include = include
    self.audioCamera = audioCamera
  }
}

public struct APIUploadRequest: Codable, Equatable, Sendable {
  /// "primary", "combined", "camera:<name>" or a camera's name; nil for the files the settings
  /// upload.
  public var tracks: [String]?
  /// The GameStation game every file of this upload belongs to, as
  /// `/api/v1/gamestation` lists them. Required: a recording with no game
  /// named has nowhere to go.
  public var game: String?
  /// What the videos are called; each file adds its camera's name, or
  /// "combined". Nil for the game's own dated title, which is what the app
  /// uses and what the library reads.
  public var title: String?

  public init(tracks: [String]? = nil, game: String? = nil, title: String? = nil) {
    self.tracks = tracks
    self.game = game
    self.title = title
  }
}

public struct APIRunRequest: Codable, Equatable, Sendable {
  public var kind: APIRunKind?
  public var recording: Int64?
  /// The files to have on the Mac first; nil for every file of the recording.
  public var tracks: [String]?
  /// Stitch again even what is already saved.
  public var reprocess: Bool?
  public var combined: APICombinedRequest?
  public var upload: APIUploadRequest?

  public init(kind: APIRunKind? = nil, recording: Int64? = nil, tracks: [String]? = nil, reprocess: Bool? = nil, combined: APICombinedRequest? = nil, upload: APIUploadRequest? = nil) {
    self.kind = kind
    self.recording = recording
    self.tracks = tracks
    self.reprocess = reprocess
    self.combined = combined
    self.upload = upload
  }
}

/// One part of a run and where it has got to.
public struct APIRunStep: Codable, Equatable, Sendable {
  /// A file's track, "combined", or an upload's track.
  public var track: String
  public var name: String
  /// "queued", "fetching", "stitching", "downloading", "uploading",
  /// "finishing" (every byte is up and the server is making a video of it),
  /// "done" or "failed".
  public var state: String
  /// How far along, 0 to 1, when that is known.
  public var fraction: Double?
  /// Why it failed, or who is stitching it.
  public var detail: String?
  /// The saved file, or the uploaded video's page.
  public var result: String?

  public init(track: String, name: String, state: String, fraction: Double? = nil, detail: String? = nil, result: String? = nil) {
    self.track = track
    self.name = name
    self.state = state
    self.fraction = fraction
    self.detail = detail
    self.result = result
  }
}

public struct APIRun: Codable, Equatable, Sendable {
  public var id: UUID
  public var recording: Int64
  public var folder: String
  public var isFinished: Bool
  public var wasCancelled: Bool
  public var files: [APIRunStep]
  public var combined: APIRunStep?
  public var uploads: [APIRunStep]

  public init(id: UUID, recording: Int64, folder: String, isFinished: Bool, wasCancelled: Bool, files: [APIRunStep], combined: APIRunStep?, uploads: [APIRunStep]) {
    self.id = id
    self.recording = recording
    self.folder = folder
    self.isFinished = isFinished
    self.wasCancelled = wasCancelled
    self.files = files
    self.combined = combined
    self.uploads = uploads
  }
}

/// The GameStation account this Mac uploads with, and the games it may
/// upload to.
public struct APIGameStation: Codable, Equatable, Sendable {
  /// "signedIn" or "signedOut". Signing in is done in the app: it takes a code
  /// from an e-mail, which no API call can read.
  public var state: String
  public var email: String?
  /// The games already played that this account runs, latest first — the ones
  /// an upload can name.
  public var games: [APIGame]
  public var detail: String?

  public init(state: String, email: String? = nil, games: [APIGame] = [], detail: String? = nil) {
    self.state = state
    self.email = email
    self.games = games
    self.detail = detail
  }
}

/// One game an upload can be sent to.
public struct APIGame: Codable, Equatable, Sendable {
  public var id: String
  public var title: String
  public var startAt: Date
  public var venue: String?

  public init(id: String, title: String, startAt: Date, venue: String?) {
    self.id = id
    self.title = title
    self.startAt = startAt
    self.venue = venue
  }
}

/// The settings the API changes; what is left out stays as it is.
public struct APISettingsPatch: Codable, Equatable, Sendable {
  public var destination: String?
  public var createCombined: Bool?

  public init(destination: String? = nil, createCombined: Bool? = nil) {
    self.destination = destination
    self.createCombined = createCombined
  }
}

/// A line of `/api/v1/events`: the status, whenever it changes.
public struct APIEvent: Codable, Equatable, Sendable {
  public var at: Date
  public var status: APIStatus

  public init(at: Date, status: APIStatus) {
    self.at = at
    self.status = status
  }
}

public struct APIRoute: Codable, Equatable, Sendable {
  public var method: String
  public var path: String
  public var summary: String
}

public struct APIIndex: Codable, Equatable, Sendable {
  public var name: String
  public var about: String
  public var routes: [APIRoute]
}
