import DirectorCore
import DirectorExport
import Foundation

/// One take a phone recorded: the local, higher-quality copy of one live stream.
public struct PhoneRecording: Sendable, Equatable {
  public var recordingID: Int64
  public var liveStreamId: String
  public var gameId: String
  public var angleName: String
  public var startedAt: WallClock
  /// Nil while a part is being written, or after a kill that nothing has closed yet.
  public var endedAt: WallClock?
  /// How many programme files the take has: one per part.
  public var parts: Int
  /// The server's upload, once one has been opened. Kept so a killed upload resumes.
  public var uploadId: String?
  /// What the upload was titled, so a resumed upload says the same. Written as the upload starts,
  /// before its export, so it also marks an upload wanted that the server has not opened yet.
  public var uploadTitle: String?
  /// When the server said the upload was ready.
  public var uploadedAt: WallClock?
  public var videoId: String?
  /// A part stopped because the phone ran out of space while the stream carried on.
  public var stoppedForLowStorage: Bool
  /// The stream published at a moment no part was recording.
  public var publishedOutsideParts: Bool
  /// What to add to this phone's clock to read the server's, measured while the take was recorded
  /// (`ServerClock`). A phone's clock wanders by several parts in a million, so an upload hours later
  /// places the take by this one rather than by a reading taken then.
  public var serverClockOffset: Double?

  public init(
    recordingID: Int64,
    liveStreamId: String,
    gameId: String,
    angleName: String,
    startedAt: WallClock,
    endedAt: WallClock? = nil,
    parts: Int = 0,
    uploadId: String? = nil,
    uploadTitle: String? = nil,
    uploadedAt: WallClock? = nil,
    videoId: String? = nil,
    stoppedForLowStorage: Bool = false,
    publishedOutsideParts: Bool = false,
    serverClockOffset: Double? = nil
  ) {
    self.recordingID = recordingID
    self.liveStreamId = liveStreamId
    self.gameId = gameId
    self.angleName = angleName
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.parts = parts
    self.uploadId = uploadId
    self.uploadTitle = uploadTitle
    self.uploadedAt = uploadedAt
    self.videoId = videoId
    self.stoppedForLowStorage = stoppedForLowStorage
    self.publishedOutsideParts = publishedOutsideParts
    self.serverClockOffset = serverClockOffset
  }

  public var isUploaded: Bool { uploadedAt != nil }
  /// An upload was started and has not landed: running, or cut off and waiting to resume, whether
  /// or not the server had opened it (an export cut off by the background's time running out, or by
  /// a kill, has no upload id yet).
  public var hasPendingUpload: Bool { (uploadId != nil || uploadTitle != nil) && uploadedAt == nil }

  /// Whether the recording covers every moment the stream published, so the server may hide the
  /// stream's live copy whatever its coverage test says: no part stopped for low storage, and no
  /// publish outside a part.
  public var coversWholeStream: Bool { !stoppedForLowStorage && !publishedOutsideParts }
}

/// The phone's own facts about its takes, beside `ArchiveIndex`'s rows in the same database: which
/// angle and stream each take is of, and how its upload is going.
///
/// The archive index's `recordings` row carries the game and the live stream as Director's would;
/// this table carries what only a phone has. Every write goes through the one `SQLiteStore`.
public final class PhoneCatalog: @unchecked Sendable {
  private let store: SQLiteStore
  private let index: ArchiveIndex

  public init(store: SQLiteStore, index: ArchiveIndex) throws {
    self.store = store
    self.index = index
    try store.execute("""
      CREATE TABLE IF NOT EXISTS phone_recordings (
        recording_id INTEGER PRIMARY KEY,
        live_stream_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        angle_name TEXT NOT NULL,
        upload_id TEXT,
        upload_title TEXT,
        uploaded_at REAL,
        video_id TEXT,
        low_storage_stop INTEGER NOT NULL DEFAULT 0,
        published_outside_parts INTEGER NOT NULL DEFAULT 0,
        server_clock_offset REAL
      );
      """)
    // A catalog made before the take kept its clock offset.
    let columns = try store.query("PRAGMA table_info(phone_recordings);").map { $0.string(1) }
    if !columns.contains("server_clock_offset") {
      try store.execute("ALTER TABLE phone_recordings ADD COLUMN server_clock_offset REAL;")
    }
    // The stream this phone is on the air with, while it is: what a relaunch after a kill puts back.
    // The live session says whether, and for how long the app was away; this says which.
    try store.execute("""
      CREATE TABLE IF NOT EXISTS phone_live (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        live_stream_id TEXT NOT NULL,
        game_id TEXT NOT NULL,
        angle_name TEXT NOT NULL
      );
      """)
  }

  /// The stream on the air, as `setLive` wrote it.
  public struct LiveContext: Sendable, Equatable {
    public var liveStreamId: String
    public var gameId: String
    public var angleName: String

    public init(liveStreamId: String, gameId: String, angleName: String) {
      self.liveStreamId = liveStreamId
      self.gameId = gameId
      self.angleName = angleName
    }
  }

  public func setLive(_ context: LiveContext) throws {
    try store.execute(
      "INSERT OR REPLACE INTO phone_live (id, live_stream_id, game_id, angle_name) VALUES (1, ?, ?, ?);",
      [ .text(context.liveStreamId), .text(context.gameId), .text(context.angleName) ]
    )
  }

  public func live() throws -> LiveContext? {
    guard let row = try store.query(
      "SELECT live_stream_id, game_id, angle_name FROM phone_live WHERE id = 1;"
    ).first else { return nil }
    return LiveContext(liveStreamId: row.string(0), gameId: row.string(1), angleName: row.string(2))
  }

  public func clearLive() throws {
    try store.execute("DELETE FROM phone_live;")
  }

  /// Files a new take under its stream, on both rows.
  public func add(recordingID: Int64, liveStreamId: String, gameId: String, angleName: String) throws {
    try index.setLiveStreamId(liveStreamId, for: recordingID)
    try index.setGame(recordingID, gameId: gameId, title: angleName)
    try store.execute(
      """
      INSERT OR REPLACE INTO phone_recordings (recording_id, live_stream_id, game_id, angle_name)
      VALUES (?, ?, ?, ?);
      """,
      [ .integer(recordingID), .text(liveStreamId), .text(gameId), .text(angleName) ]
    )
  }

  /// Every take filed under a live stream, newest first.
  public func recordings() throws -> [PhoneRecording] {
    let summaries = Dictionary(
      uniqueKeysWithValues: try index.recordings().map { ($0.id, $0) }
    )
    let rows = try store.query(
      """
      SELECT recording_id, live_stream_id, game_id, angle_name, upload_id, upload_title,
        uploaded_at, video_id, low_storage_stop, published_outside_parts, server_clock_offset
      FROM phone_recordings;
      """
    )
    return rows.compactMap { row -> PhoneRecording? in
      let id = row.int(0)
      guard let summary = summaries[id] else { return nil }
      return PhoneRecording(
        recordingID: id,
        liveStreamId: row.string(1),
        gameId: row.string(2),
        angleName: row.string(3),
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        parts: summary.programFilename.map {
          $0.split(separator: ",").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
        } ?? 0,
        uploadId: Self.optionalText(row, 4),
        uploadTitle: Self.optionalText(row, 5),
        uploadedAt: row.values[6] == .null ? nil : WallClock(seconds: row.double(6)),
        videoId: Self.optionalText(row, 7),
        stoppedForLowStorage: row.int(8) != 0,
        publishedOutsideParts: row.int(9) != 0,
        serverClockOffset: row.values[10] == .null ? nil : row.double(10)
      )
    }
    .sorted { $0.startedAt > $1.startedAt }
  }

  public func recording(_ id: Int64) throws -> PhoneRecording? {
    try recordings().first { $0.recordingID == id }
  }

  /// The take of `liveStreamId` that has not been uploaded, if there is one: the one a later Record
  /// on that stream continues. Once uploaded, the server revokes the stream and the next take on the
  /// angle has a new one.
  public func current(forLiveStream liveStreamId: String) throws -> PhoneRecording? {
    try recordings().first { $0.liveStreamId == liveStreamId && !$0.isUploaded }
  }

  /// The take's angle was renamed while it was on the air: both rows carry the new name.
  public func rename(_ recordingID: Int64, angleName: String) throws {
    guard let row = try store.query(
      "SELECT game_id FROM phone_recordings WHERE recording_id = ?;",
      [ .integer(recordingID) ]
    ).first else { return }
    try index.setGame(recordingID, gameId: row.string(0), title: angleName, replacing: row.string(0))
    try store.execute(
      "UPDATE phone_recordings SET angle_name = ? WHERE recording_id = ?;",
      [ .text(angleName), .integer(recordingID) ]
    )
  }

  public func setUpload(id uploadId: String?, title: String?, for recordingID: Int64) throws {
    try store.execute(
      "UPDATE phone_recordings SET upload_id = ?, upload_title = ? WHERE recording_id = ?;",
      [ uploadId.map { .text($0) } ?? .null, title.map { .text($0) } ?? .null, .integer(recordingID) ]
    )
  }

  public func markUploaded(_ recordingID: Int64, videoId: String, at wall: WallClock) throws {
    try store.execute(
      "UPDATE phone_recordings SET uploaded_at = ?, video_id = ? WHERE recording_id = ?;",
      [ .real(wall.seconds), .text(videoId), .integer(recordingID) ]
    )
  }

  /// Keeps the first clock offset measured for a take; see `PhoneRecording.serverClockOffset`.
  public func setServerClockOffset(_ offset: Double, for recordingID: Int64) throws {
    try store.execute(
      "UPDATE phone_recordings SET server_clock_offset = ? WHERE recording_id = ? AND server_clock_offset IS NULL;",
      [ .real(offset), .integer(recordingID) ]
    )
  }

  public func markStoppedForLowStorage(_ recordingID: Int64) throws {
    try store.execute(
      "UPDATE phone_recordings SET low_storage_stop = 1 WHERE recording_id = ?;",
      [ .integer(recordingID) ]
    )
  }

  public func markPublishedOutsideParts(_ recordingID: Int64) throws {
    try store.execute(
      "UPDATE phone_recordings SET published_outside_parts = 1 WHERE recording_id = ?;",
      [ .integer(recordingID) ]
    )
  }

  /// Opens a stopped take again, so a part added to it is part of the take: its end is written
  /// again when that part stops, and a kill before then leaves it open for the resume to find.
  public func reopen(_ recordingID: Int64) throws {
    try store.execute(
      "UPDATE recordings SET ended_at = NULL WHERE id = ?;",
      [ .integer(recordingID) ]
    )
  }

  /// Closes a take the app never got to close, at the last moment its programme said it reached:
  /// a phone writes no camera segments, so `ArchiveIndex.closeAbandonedRecordings` would close it
  /// at its start.
  public func closeAtLastAnchor(_ recordingID: Int64) throws {
    let last = try index.programAnchors(recordingID: recordingID).map(\.wall.seconds).max()
    guard let summary = try index.recordings().first(where: { $0.id == recordingID }) else { return }
    let end = WallClock(seconds: max(summary.startedAt.seconds, last ?? summary.startedAt.seconds))
    try index.endRecording(recordingID, at: end)
  }

  public func delete(_ recordingID: Int64) throws {
    try store.execute(
      "DELETE FROM phone_recordings WHERE recording_id = ?;",
      [ .integer(recordingID) ]
    )
  }

  private static func optionalText(_ row: SQLiteRow, _ column: Int) -> String? {
    row.values[column] == .null || row.string(column).isEmpty ? nil : row.string(column)
  }
}
