import DistributorWire
import Foundation
import LoopbackHTTP

// What the API sends and takes. Dates are ISO 8601; a file of a recording is named by its track:
// "primary", or "camera:<source id>", and wherever a track is asked for a camera's name will do.

/// The iPad as the Distributor sees it.
public struct APIIPad: Codable, Equatable, Sendable {
  /// "attached", "waitingForDirector" (an iPad is on the cable but TS Director is not answering),
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
  public var teamStation: APITeamStation

  public init(iPad: APIIPad, destination: String?, run: APIRun?, teamStation: APITeamStation) {
    self.iPad = iPad
    self.destination = destination
    self.run = run
    self.teamStation = teamStation
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
  /// What it is stitched from is kept on this Mac, so it can be stitched again (`reprocess`) with
  /// no iPad attached.
  public var segmentsOnMac: Bool

  public init(
    track: String,
    name: String,
    onMac: String,
    bytesOnMac: Int64?,
    path: String?,
    preparedOnIPad: Bool,
    segmentsOnMac: Bool = false
  ) {
    self.track = track
    self.name = name
    self.onMac = onMac
    self.bytesOnMac = bytesOnMac
    self.path = path
    self.preparedOnIPad = preparedOnIPad
    self.segmentsOnMac = segmentsOnMac
  }
}

/// What `DELETE /api/v1/recordings/{id}/segments` did.
public struct APISegmentsDeleted: Codable, Equatable, Sendable {
  public var recording: Int64
  /// False when there were none to remove.
  public var removed: Bool
  /// What removing them gave back.
  public var bytes: Int64

  public init(recording: Int64, removed: Bool, bytes: Int64) {
    self.recording = recording
    self.removed = removed
    self.bytes = bytes
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
  /// The TeamStation game TS Director filed this take under, which its uploads go to unless a
  /// request names another; nil when it names none.
  public var gameId: String?
  /// That game's dated title, which its videos are called.
  public var gameTitle: String?

  public init(
    id: Int64,
    startedAt: Date,
    endedAt: Date?,
    isLive: Bool,
    files: [APIFile],
    combined: APIFile,
    folder: String?,
    gameId: String? = nil,
    gameTitle: String? = nil
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.isLive = isLive
    self.files = files
    self.combined = combined
    self.folder = folder
    self.gameId = gameId
    self.gameTitle = gameTitle
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
  /// The chosen files onto the Mac, every one off the iPad before any is stitched; nothing else.
  case download
  /// The files, then the combined video as the settings say, then the uploads to the game TS
  /// Director filed the take under when this Mac is signed in to TeamStation — unless the request
  /// says otherwise.
  case export
  /// The combined video, made from the files, fetching any that are not here yet.
  case combined
  /// Uploads to TeamStation, fetching first any file they send that is not on this Mac yet, and
  /// making the combined video first when it goes up and is not here.
  case upload
  /// Exactly what the request lists.
  case custom
}

/// `combined` in a request: `false` for no combined video whatever the settings say, `true` for one
/// laid out as the settings lay it out, or what goes in it.
public struct APICombinedRequest: Codable, Equatable, Sendable {
  /// False when the request says `"combined": false`.
  public var wanted: Bool
  /// Which videos go in, by name ("Primary output" for the primary output); nil for up to four,
  /// the primary output first.
  public var include: [String]?
  /// Whose sound it carries; nil for the one last chosen.
  public var audioCamera: String?

  public init(wanted: Bool = true, include: [String]? = nil, audioCamera: String? = nil) {
    self.wanted = wanted
    self.include = include
    self.audioCamera = audioCamera
  }

  /// No combined video.
  public static let off = APICombinedRequest(wanted: false)

  enum CodingKeys: String, CodingKey { case include, audioCamera }

  public init(from decoder: Decoder) throws {
    if let wanted = try? decoder.singleValueContainer().decode(Bool.self) {
      self.init(wanted: wanted)
      return
    }
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.init(
      include: try container.decodeIfPresent([String].self, forKey: .include),
      audioCamera: try container.decodeIfPresent(String.self, forKey: .audioCamera)
    )
  }

  public func encode(to encoder: Encoder) throws {
    guard wanted else {
      var single = encoder.singleValueContainer()
      try single.encode(false)
      return
    }
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(include, forKey: .include)
    try container.encodeIfPresent(audioCamera, forKey: .audioCamera)
  }
}

public struct APIUploadRequest: Codable, Equatable, Sendable {
  /// "primary", "combined", "camera:<name>" or a camera's name; nil for the files the settings
  /// upload.
  public var tracks: [String]?
  /// The TeamStation game every file of this upload belongs to, as
  /// `/api/v1/teamstation` lists them. Nil for the game TS Director filed the
  /// take under; a take filed under none needs one named here.
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
  /// The one recording this run exports. A run of several names them in `recordings` or `takes`
  /// instead.
  public var recording: Int64?
  /// The recordings a run of several exports, each as the rest of the request says.
  public var recordings: [Int64]?
  /// The recordings a run of several exports, each with what it does differently from the rest
  /// of the request — its own game, say.
  public var takes: [APITakeRequest]?
  /// The files to have on the Mac first; nil for every file of the recording.
  public var tracks: [String]?
  /// Stitch again even what is already saved.
  public var reprocess: Bool?
  public var combined: APICombinedRequest?
  public var upload: APIUploadRequest?

  public init(
    kind: APIRunKind? = nil,
    recording: Int64? = nil,
    recordings: [Int64]? = nil,
    takes: [APITakeRequest]? = nil,
    tracks: [String]? = nil,
    reprocess: Bool? = nil,
    combined: APICombinedRequest? = nil,
    upload: APIUploadRequest? = nil
  ) {
    self.kind = kind
    self.recording = recording
    self.recordings = recordings
    self.takes = takes
    self.tracks = tracks
    self.reprocess = reprocess
    self.combined = combined
    self.upload = upload
  }

  /// The request as one request of one recording per take, in the order given: each take's own
  /// `tracks`, `combined` and `upload` fields in place of the request's, field by field for
  /// `upload`. Exactly one of `recording`, `recordings` and `takes` is given, and no recording is
  /// named twice.
  public func perTake() throws(HTTPError) -> [APIRunRequest] {
    let named = [ recording != nil, recordings != nil, takes != nil ].filter { $0 }.count
    guard named == 1 else {
      throw HTTPError.badRequest("name the recordings with one of recording, recordings or takes")
    }
    let takes = self.takes ?? (recordings ?? recording.map { [ $0 ] } ?? []).map { APITakeRequest(recording: $0) }
    guard !takes.isEmpty else { throw HTTPError.badRequest("recordings is empty") }
    var seen = Set<Int64>()
    for take in takes where !seen.insert(take.recording).inserted {
      throw HTTPError.badRequest("recording \(take.recording) is named twice")
    }
    return takes.map { take in
      var upload = upload
      if let own = take.upload {
        upload = APIUploadRequest(
          tracks: own.tracks ?? upload?.tracks,
          game: own.game ?? upload?.game,
          title: own.title ?? upload?.title
        )
      }
      return APIRunRequest(
        kind: kind,
        recording: take.recording,
        tracks: take.tracks ?? tracks,
        reprocess: reprocess,
        combined: take.combined ?? combined,
        upload: upload
      )
    }
  }
}

/// One recording of a run of several, and what it does differently from the rest of the request.
/// What it leaves out is the request's.
public struct APITakeRequest: Codable, Equatable, Sendable {
  public var recording: Int64
  public var tracks: [String]?
  public var combined: APICombinedRequest?
  /// Its own game, files to send or title; each field left out is the request's.
  public var upload: APIUploadRequest?

  public init(recording: Int64, tracks: [String]? = nil, combined: APICombinedRequest? = nil, upload: APIUploadRequest? = nil) {
    self.recording = recording
    self.tracks = tracks
    self.combined = combined
    self.upload = upload
  }
}

/// One part of a run and where it has got to.
public struct APIRunStep: Codable, Equatable, Sendable {
  /// A file's track, "combined", or an upload's track.
  public var track: String
  public var name: String
  /// "queued", "fetching", "fetched" (off the iPad, waiting to be stitched), "stitching",
  /// "downloading", "uploading", "finishing" (every byte is up and the server is making a video of
  /// it), "done" or "failed".
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

/// One recording of a run: each of its files, its combined video and its uploads.
public struct APIRunTake: Codable, Equatable, Sendable {
  public var recording: Int64
  public var folder: String
  public var files: [APIRunStep]
  public var combined: APIRunStep?
  public var uploads: [APIRunStep]

  public init(recording: Int64, folder: String, files: [APIRunStep], combined: APIRunStep?, uploads: [APIRunStep]) {
    self.recording = recording
    self.folder = folder
    self.files = files
    self.combined = combined
    self.uploads = uploads
  }
}

public struct APIRun: Codable, Equatable, Sendable {
  public var id: UUID
  /// The first take's, as are `folder`, `files`, `combined` and `uploads`: all there is to a run of
  /// one recording. A run of several lists every one in `takes`.
  public var recording: Int64
  public var folder: String
  public var isFinished: Bool
  public var wasCancelled: Bool
  /// What every take is at, as one: "fetching" (off the iPad), "stitching", "combining",
  /// "uploading", then "finished".
  public var step: String
  /// Nothing more will be asked of the iPad: it can be unplugged and the run carries on.
  public var isDoneWithIPad: Bool
  public var files: [APIRunStep]
  public var combined: APIRunStep?
  public var uploads: [APIRunStep]
  /// Every recording of the run, in the order each step takes them.
  public var takes: [APIRunTake]

  public init(
    id: UUID,
    isFinished: Bool,
    wasCancelled: Bool,
    step: String,
    isDoneWithIPad: Bool,
    takes: [APIRunTake]
  ) {
    let first = takes.first
    self.id = id
    self.recording = first?.recording ?? 0
    self.folder = first?.folder ?? ""
    self.isFinished = isFinished
    self.wasCancelled = wasCancelled
    self.step = step
    self.isDoneWithIPad = isDoneWithIPad
    self.files = first?.files ?? []
    self.combined = first?.combined
    self.uploads = first?.uploads ?? []
    self.takes = takes
  }
}

/// The TeamStation account this Mac uploads with, and the games it may
/// upload to.
public struct APITeamStation: Codable, Equatable, Sendable {
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
  public var upload: APIUploadSettingsPatch?

  public init(destination: String? = nil, createCombined: Bool? = nil, upload: APIUploadSettingsPatch? = nil) {
    self.destination = destination
    self.createCombined = createCombined
    self.upload = upload
  }
}

/// `upload` in a settings change.
public struct APIUploadSettingsPatch: Codable, Equatable, Sendable {
  public var choice: APIUploadChoicePatch?

  public init(choice: APIUploadChoicePatch? = nil) {
    self.choice = choice
  }
}

/// Which files an upload sends when a request does not list them; what is left out stays.
public struct APIUploadChoicePatch: Codable, Equatable, Sendable {
  public var primary: Bool?
  /// Camera names.
  public var cameras: [String]?
  /// Whether the combined video goes up. On, an `upload` run makes one to send when none is saved.
  public var combined: Bool?

  public init(primary: Bool? = nil, cameras: [String]? = nil, combined: Bool? = nil) {
    self.primary = primary
    self.cameras = cameras
    self.combined = combined
  }

  /// `choice` with what this changes changed.
  public func applied(to choice: UploadChoice) -> UploadChoice {
    UploadChoice(
      primary: primary ?? choice.primary,
      cameras: cameras ?? choice.cameras,
      combined: combined ?? choice.combined
    )
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
