import Foundation
import DirectorCore

public struct SegmentRecord: Sendable, Equatable, Codable {
  public var id: Int64
  public var recordingID: Int64
  public var sourceID: SourceID
  public var sequence: Int
  public var filename: String
  /// fMP4 initialisation segments carry the moov box and no media. Every media segment needs
  /// one prepended before it can be decoded, which is why the index tracks them explicitly
  /// instead of treating segment 0 as special by convention.
  public var isInitialization: Bool
  public var startWall: WallClock
  public var duration: TimeInterval
  public var byteCount: Int64
  public var firstFrameID: UInt64?
  /// Which transport delivered this segment, so a misplaced angle can be attributed to one after
  /// the fact. Nil on rows written before the column existed.
  public var transport: String?
  /// The clock correction applied to this segment's capture times, in seconds. Recorded so an
  /// export can be re-derived if the offset later proves wrong, rather than being unrecoverable.
  public var appliedClockOffset: Double?
  /// Frames per second this segment was actually written at, which is not always the camera's
  /// nominal rate: an encoder under pressure archives at half rate rather than dropping frames at
  /// random. A verifier comparing against a flat tolerance needs this to know what "one frame" is.
  public var archiveRate: Double?

  public var endWall: WallClock { startWall + duration }
}

public struct RecordingSummary: Sendable, Equatable, Identifiable {
  public var id: Int64
  public var startedAt: WallClock
  public var endedAt: WallClock?
  public var programFilename: String?
  public var sourceIDs: [SourceID]
  /// End of the last media segment written for this recording. Stands in for `endedAt` on a take
  /// the app never got to close.
  public var lastSegmentEnd: WallClock?
  /// How many times this take has been picked up again after the app stopped running. Zero for a
  /// take that recorded straight through, which is every take made before resuming existed.
  public var resumeCount: Int
  /// The raw camera and programme encoding the take was recorded with, which its exports use. Nil
  /// for a take recorded before encodings were kept with their takes.
  public var encoding: TakeEncoding?
  /// What each programme part's sound track turned out to hold, read back from the file at Stop.
  /// Empty for a take recorded before this was kept, which means *unknown* and not *fine*.
  public var soundChecks: [ProgramSoundCheck]

  /// Whether this take's programme sound is known good, known short, or was never checked.
  ///
  /// Three states on purpose. Collapsing "not checked" into "fine" is what let two games be
  /// exported and uploaded before anyone noticed, so a take with no verdict has to say so.
  public enum SoundVerdict: Sendable, Equatable {
    case unchecked
    case complete
    /// Sound falls short of picture by this many seconds, in the worst part.
    case short(seconds: Double)
  }

  public var soundVerdict: SoundVerdict {
    guard !soundChecks.isEmpty else { return .unchecked }
    let worst = soundChecks.filter(\.isShort).map(\.shortfall).max()
    return worst.map { .short(seconds: $0) } ?? .complete
  }

  /// The game this take was streamed to, if it was streamed to one.
  public var gameId: String?
  /// The dated title that upload uses, kept so a take can name its game with
  /// no network and no list to look it up in.
  public var gameTitle: String?

  /// How long the take is, from what was actually written.
  ///
  /// This used to fall back to *now* when `endedAt` was nil, which is right for the take that is
  /// rolling and wrong for every take a crash left open: the row counted up one second per second
  /// forever, so a 74-minute recording read as six hours. A live take's running length is the
  /// view's business, since only the view knows which recording is live.
  public var duration: TimeInterval {
    ((endedAt ?? lastSegmentEnd) ?? startedAt) - startedAt
  }

  /// The app died before `endRecording` ran, so the take was closed from its segments.
  public var wasInterrupted: Bool { endedAt == nil }

  public init(
    id: Int64,
    startedAt: WallClock,
    endedAt: WallClock?,
    programFilename: String?,
    sourceIDs: [SourceID],
    lastSegmentEnd: WallClock? = nil,
    resumeCount: Int = 0,
    encoding: TakeEncoding? = nil,
    soundChecks: [ProgramSoundCheck] = [],
    gameId: String? = nil,
    gameTitle: String? = nil
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.programFilename = programFilename
    self.sourceIDs = sourceIDs
    self.lastSegmentEnd = lastSegmentEnd
    self.resumeCount = resumeCount
    self.encoding = encoding
    self.soundChecks = soundChecks
    self.gameId = gameId
    self.gameTitle = gameTitle
  }
}

/// Directories holding a recording's segment files, programme master, and proxy chunks.
/// Tests pass a temp tree; production uses `DirectorPaths`.
public struct RecordingFileRoots: Sendable {
  public var archives: URL
  public var program: URL
  public var proxies: URL
  public var prepared: URL

  public init(archives: URL, program: URL, proxies: URL, prepared: URL) {
    self.archives = archives
    self.program = program
    self.proxies = proxies
    self.prepared = prepared
  }

  public static var standard: RecordingFileRoots {
    RecordingFileRoots(
      archives: DirectorPaths.archives,
      program: DirectorPaths.program,
      proxies: DirectorPaths.proxies,
      prepared: DirectorPaths.prepared
    )
  }

  public func preparedDirectory(for recordingID: Int64) -> URL {
    prepared.appendingPathComponent("rec-\(recordingID)", isDirectory: true)
  }

  public func archiveDirectory(for source: SourceID) -> URL {
    archives.appendingPathComponent(source.slug, isDirectory: true)
  }

  public func proxyDirectory(for source: SourceID) -> URL {
    proxies.appendingPathComponent(source.slug, isDirectory: true)
  }
}

public struct ProxyStillRecord: Sendable, Equatable, Codable {
  public var id: Int64
  public var sourceID: SourceID
  public var wall: WallClock
  public var chunk: String
  public var offset: Int64
  public var length: Int64
}

/// The wall-clock index over everything the DVR has written.
///
/// Scrubbing asks it two questions and nothing else: "which proxy still is nearest this
/// instant" while the finger is down, and "which segment contains this instant" on release.
/// I5: every write goes through one `SQLiteStore`, whose single connection serialises them.
public final class ArchiveIndex: @unchecked Sendable {
  private let store: SQLiteStore

  public init(store: SQLiteStore) throws {
    self.store = store
    try createSchema()
  }

  public convenience init(url: URL = DirectorPaths.indexDatabase) throws {
    try self.init(store: SQLiteStore(url: url))
  }

  private func createSchema() throws {
    try store.execute("""
      CREATE TABLE IF NOT EXISTS recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at REAL NOT NULL,
        ended_at REAL,
        program_filename TEXT
      );
      """)
    // Existing installs created recordings without a program column.
    try? store.execute("ALTER TABLE recordings ADD COLUMN program_filename TEXT;")
    // How often the app came back to this take, and the grid it was recording with. The snapshot
    // is what stops a take being resumed against a different set of cameras than it started on:
    // the selection store is shared with every later launch, and an operator who reconfigured
    // between the crash and the relaunch would otherwise silently change the take.
    try? store.execute("ALTER TABLE recordings ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;")
    try? store.execute("ALTER TABLE recordings ADD COLUMN last_resumed_at REAL;")
    try? store.execute("ALTER TABLE recordings ADD COLUMN selections_json TEXT;")
    // The encoding the take was recorded with, so its exports come out as it was set up rather than
    // as Settings say on the day of the export.
    try? store.execute("ALTER TABLE recordings ADD COLUMN encoding_json TEXT;")
    // What each programme part's sound track turned out to hold, one `ProgramSoundCheck` per part.
    // See `ProgramSoundCheck`: the Director noticed a 46.8 s shortfall at Stop on two consecutive
    // weekends and reported it only to memory, so nobody read it until the games had been uploaded.
    try? store.execute("ALTER TABLE recordings ADD COLUMN sound_checks_json TEXT;")
    // The game this take was streamed to, where it was streamed to one. An
    // upload then needs no question asked: the take already knows where it
    // belongs. Null for a take recorded without a claimed event — a bare RTSP
    // publish, or no stream at all — and that is the take an operator is asked
    // about.
    try? store.execute("ALTER TABLE recordings ADD COLUMN game_id TEXT;")
    // The title that upload is given — dated, as the picker composes it — so
    // a take can say where it belongs with no network and no list.
    try? store.execute("ALTER TABLE recordings ADD COLUMN game_title TEXT;")
    try store.execute("""
      CREATE TABLE IF NOT EXISTS segments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        filename TEXT NOT NULL,
        is_initialization INTEGER NOT NULL DEFAULT 0,
        start_wall REAL NOT NULL,
        duration REAL NOT NULL,
        byte_count INTEGER NOT NULL,
        first_frame_id INTEGER
      );
      """)
    // Provenance, added later: how a segment was made, so a wrong placement can be attributed and
    // an export re-derived. Existing archives get them as NULL, which reads as "not recorded".
    try? store.execute("ALTER TABLE segments ADD COLUMN transport TEXT;")
    try? store.execute("ALTER TABLE segments ADD COLUMN applied_clock_offset REAL;")
    try? store.execute("ALTER TABLE segments ADD COLUMN archive_rate REAL;")
    // What each source was *meant* to do this recording. A camera past the archive encode budget
    // previews and cuts to programme but writes no segments at all, which at export is
    // indistinguishable from a camera nobody selected. Recording the intent is what lets an export
    // say "not recorded, by budget" instead of quietly leaving an angle out.
    try store.execute("""
      CREATE TABLE IF NOT EXISTS recording_sources (
        recording_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        transport TEXT,
        archiving INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        PRIMARY KEY (recording_id, source_id)
      );
      """)
    // The camera's name when it joined the take, rewritten if it was renamed during it. A source id
    // is a camera's UUID, so a camera the Director has since forgotten would otherwise come back as
    // that UUID; the name is what the operator, and TS Distributor, know it by.
    try? store.execute("ALTER TABLE recording_sources ADD COLUMN camera_name TEXT;")
    // Where the programme was in real time, sampled as it was written.
    //
    // A camera records the wall clock of every segment; the programme had exactly two facts for a
    // whole take, its start and its end, which is why its drift stayed invisible until somebody
    // compared it against a camera frame by frame. One row every few seconds makes the programme as
    // re-timeable as the cameras, and turns "the programme holds wall clock" into something a test
    // can assert rather than infer.
    try store.execute("""
      CREATE TABLE IF NOT EXISTS program_anchors (
        recording_id INTEGER NOT NULL,
        part INTEGER NOT NULL,
        program_seconds REAL NOT NULL,
        wall REAL NOT NULL
      );
      """)
    try store.execute(
      "CREATE INDEX IF NOT EXISTS program_anchors_lookup ON program_anchors(recording_id, part, program_seconds);"
    )
    try store.execute(
      "CREATE UNIQUE INDEX IF NOT EXISTS segments_unique ON segments(recording_id, source_id, sequence);"
    )
    try store.execute(
      "CREATE INDEX IF NOT EXISTS segments_lookup ON segments(source_id, start_wall);"
    )
    try store.execute("""
      CREATE TABLE IF NOT EXISTS proxy_stills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        wall REAL NOT NULL,
        chunk TEXT NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL
      );
      """)
    try store.execute(
      "CREATE INDEX IF NOT EXISTS proxy_lookup ON proxy_stills(source_id, wall);"
    )
    // What the app was doing when it was last alive, and when that was.
    //
    // One row, or none at all when the app is idle. `last_alive` is a heartbeat rather than a
    // stop time because the two are only the same when the app was shut down properly: after a
    // crash nothing gets to write a stop time, and the last segment on disk is not a substitute
    // (cameras that dropped out twenty minutes before the crash would make a two-minute outage
    // read as twenty-two). The heartbeat is the only measurement of how long the app itself was
    // away.
    try store.execute("""
      CREATE TABLE IF NOT EXISTS live_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        recording_id INTEGER,
        streaming INTEGER NOT NULL DEFAULT 0,
        started_at REAL NOT NULL,
        last_alive REAL NOT NULL
      );
      """)
    // Every cut the programme made, as it was made. The preference store holds one camera — the
    // last one cut to — which is enough to put the programme back where it was and nothing else.
    // A resumed take needs to know what was on air at each moment, and an export or an edit list
    // wants the same thing, so the cuts are kept rather than overwritten.
    try store.execute("""
      CREATE TABLE IF NOT EXISTS program_cuts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id INTEGER NOT NULL,
        wall REAL NOT NULL,
        source_id TEXT NOT NULL,
        intended INTEGER NOT NULL DEFAULT 1
      );
      """)
    try store.execute(
      "CREATE INDEX IF NOT EXISTS program_cuts_lookup ON program_cuts(recording_id, wall);"
    )
  }

  // MARK: - Recordings

  public func beginRecording(at wall: WallClock) throws -> Int64 {
    try store.execute(
      "INSERT INTO recordings (started_at) VALUES (?);",
      [ .real(wall.seconds) ]
    )
  }

  /// Writes down the game a take is of.
  ///
  /// Called when a take starts with a TeamStation event chosen, and when an
  /// event is picked while a take is recording. Written only over a take with
  /// no game, or over `replacing`: the event picker passes the game it linked
  /// the same take to earlier, so correcting a wrong pick moves the take,
  /// while a game written any other way is never overwritten.
  public func setGame(
    _ id: Int64,
    gameId: String,
    title: String,
    replacing: String? = nil
  ) throws {
    _ = try store.execute(
      """
      UPDATE recordings SET game_id = ?, game_title = ?
      WHERE id = ? AND (game_id IS NULL OR game_id = '' OR game_id = ?);
      """,
      [ .text(gameId), .text(title), .integer(id), replacing.map { .text($0) } ?? .null ]
    )
  }

  public func endRecording(_ id: Int64, at wall: WallClock) throws {
    try store.execute(
      "UPDATE recordings SET ended_at = ? WHERE id = ?;",
      [ .real(wall.seconds), .integer(id) ]
    )
  }

  public func setProgramFilename(_ filename: String, for id: Int64) throws {
    try store.execute(
      "UPDATE recordings SET program_filename = ? WHERE id = ?;",
      [ .text(filename), .integer(id) ]
    )
  }

  // MARK: - The live session

  /// What the app was doing when it was last alive.
  ///
  /// `recordingID` is the take that is still rolling; nil means the app was streaming only.
  /// `lastAlive` is the heartbeat, and the age of it is how long the app has been away.
  public struct LiveSession: Sendable, Equatable {
    public var recordingID: Int64?
    public var streaming: Bool
    public var startedAt: WallClock
    public var lastAlive: WallClock

    public init(recordingID: Int64?, streaming: Bool, startedAt: WallClock, lastAlive: WallClock) {
      self.recordingID = recordingID
      self.streaming = streaming
      self.startedAt = startedAt
      self.lastAlive = lastAlive
    }

    /// Nothing to resume. The row should not exist in this state; deleting it is how the two
    /// halves stopping independently is handled without either needing to know about the other.
    public var isEmpty: Bool { recordingID == nil && !streaming }
  }

  /// Opens the live session, or updates the half named by whichever argument is given.
  ///
  /// Called from both `startRecording` and `startStreaming`, which can happen in either order and
  /// independently, so this must never clobber the half it was not asked about.
  public func openLiveSession(
    recordingID: Int64? = nil,
    streaming: Bool? = nil,
    at wall: WallClock
  ) throws {
    let existing = try liveSession()
    let recording = recordingID ?? existing?.recordingID
    let isStreaming = streaming ?? existing?.streaming ?? false
    let startedAt = existing?.startedAt ?? wall
    try store.execute(
      """
      INSERT OR REPLACE INTO live_session (id, recording_id, streaming, started_at, last_alive)
      VALUES (1, ?, ?, ?, ?);
      """,
      [
        recording.map { .integer($0) } ?? .null,
        .integer(isStreaming ? 1 : 0),
        .real(startedAt.seconds),
        .real(wall.seconds)
      ]
    )
  }

  /// Clears one half of the live session and deletes the row once both are off. The operator
  /// stopping the last of the two is what says "there is nothing to come back to".
  public func closeLiveSession(recording: Bool = false, streaming: Bool = false) throws {
    guard let existing = try liveSession() else { return }
    var next = existing
    if recording { next.recordingID = nil }
    if streaming { next.streaming = false }
    if (!recording && !streaming) || next.isEmpty {
      try store.execute("DELETE FROM live_session;")
      return
    }
    try store.execute(
      "UPDATE live_session SET recording_id = ?, streaming = ? WHERE id = 1;",
      [
        next.recordingID.map { .integer($0) } ?? .null,
        .integer(next.streaming ? 1 : 0)
      ]
    )
  }

  /// Moves the heartbeat forward. Never backwards: a test clock or a system clock correction
  /// must not be able to make the app look like it has been away longer than it has.
  public func heartbeat(at wall: WallClock) throws {
    try store.execute(
      "UPDATE live_session SET last_alive = ? WHERE id = 1 AND last_alive < ?;",
      [ .real(wall.seconds), .real(wall.seconds) ]
    )
  }

  public func liveSession() throws -> LiveSession? {
    guard let row = try store.query(
      "SELECT recording_id, streaming, started_at, last_alive FROM live_session WHERE id = 1;"
    ).first else { return nil }
    return LiveSession(
      recordingID: row.values[0] == .null ? nil : row.int(0),
      streaming: row.int(1) == 1,
      startedAt: WallClock(seconds: row.double(2)),
      lastAlive: WallClock(seconds: row.double(3))
    )
  }

  /// The take the live session names, if it is still open.
  ///
  /// A session naming a take that has since been closed is stale — the app stopped properly and
  /// something else went wrong — so the pointer is cleared rather than being allowed to resume a
  /// finished recording.
  public func liveRecording() throws -> RecordingSummary? {
    guard let session = try liveSession(), let id = session.recordingID else { return nil }
    guard let summary = try recordings().first(where: { $0.id == id }) else {
      try closeLiveSession(recording: true)
      return nil
    }
    guard summary.endedAt == nil else {
      try closeLiveSession(recording: true)
      return nil
    }
    return summary
  }

  public func noteResumed(_ id: Int64, at wall: WallClock) throws {
    try store.execute(
      "UPDATE recordings SET resume_count = resume_count + 1, last_resumed_at = ? WHERE id = ?;",
      [ .real(wall.seconds), .integer(id) ]
    )
  }

  // MARK: - The grid a take was recording with

  public func saveSelections(_ json: Data, for id: Int64) throws {
    try store.execute(
      "UPDATE recordings SET selections_json = ? WHERE id = ?;",
      [ .text(String(decoding: json, as: UTF8.self)), .integer(id) ]
    )
  }

  public func selections(for id: Int64) throws -> Data? {
    guard let row = try store.query(
      "SELECT selections_json FROM recordings WHERE id = ?;",
      [ .integer(id) ]
    ).first else { return nil }
    guard row.values[0] != .null else { return nil }
    let text = row.string(0)
    return text.isEmpty ? nil : Data(text.utf8)
  }

  // MARK: - The encoding a take was recorded with

  public func saveEncoding(_ encoding: TakeEncoding, for id: Int64) throws {
    let json = try JSONEncoder().encode(encoding)
    try store.execute(
      "UPDATE recordings SET encoding_json = ? WHERE id = ?;",
      [ .text(String(decoding: json, as: UTF8.self)), .integer(id) ]
    )
  }

  public func encoding(for id: Int64) throws -> TakeEncoding? {
    guard let row = try store.query(
      "SELECT encoding_json FROM recordings WHERE id = ?;",
      [ .integer(id) ]
    ).first else { return nil }
    return Self.takeEncoding(row.values[0] == .null ? nil : row.string(0))
  }

  /// Nil for a missing or unreadable value: an export falls back to Settings rather than failing.
  private static func takeEncoding(_ text: String?) -> TakeEncoding? {
    guard let text, !text.isEmpty else { return nil }
    return try? JSONDecoder().decode(TakeEncoding.self, from: Data(text.utf8))
  }

  // MARK: - What each programme part's sound turned out to hold

  /// Records one part's verdict, replacing any earlier verdict for the same part.
  ///
  /// Read-modify-write rather than a row per part: a take has one part unless a writer died, so the
  /// list is almost always a single element, and keeping it on the take's own row means every
  /// reader that already loads a `RecordingSummary` gets it for nothing.
  public func recordSoundCheck(_ check: ProgramSoundCheck, for id: Int64) throws {
    var checks = try soundChecks(for: id).filter { $0.part != check.part }
    checks.append(check)
    checks.sort { $0.part < $1.part }
    let json = try JSONEncoder().encode(checks)
    try store.execute(
      "UPDATE recordings SET sound_checks_json = ? WHERE id = ?;",
      [ .text(String(decoding: json, as: UTF8.self)), .integer(id) ]
    )
  }

  public func soundChecks(for id: Int64) throws -> [ProgramSoundCheck] {
    guard let row = try store.query(
      "SELECT sound_checks_json FROM recordings WHERE id = ?;",
      [ .integer(id) ]
    ).first else { return [] }
    return Self.soundChecks(row.values[0] == .null ? nil : row.string(0))
  }

  /// Empty for a missing or unreadable value: a take recorded before this existed has no verdict,
  /// which is not the same as a verdict of "fine" and must not read as one. See
  /// `RecordingSummary.soundVerdict`.
  static func soundChecks(_ text: String?) -> [ProgramSoundCheck] {
    guard let text, !text.isEmpty else { return [] }
    return (try? JSONDecoder().decode([ProgramSoundCheck].self, from: Data(text.utf8))) ?? []
  }

  // MARK: - Programme cuts

  public struct ProgramCut: Sendable, Equatable {
    public var wall: WallClock
    public var sourceID: SourceID
    /// The operator chose this camera. False when the app picked one because the chosen camera
    /// was not live — a fallback should not become the take's preference.
    public var intended: Bool
  }

  @discardableResult
  public func insertProgramCut(
    recordingID: Int64,
    wall: WallClock,
    sourceID: SourceID,
    intended: Bool
  ) throws -> Int64 {
    try store.execute(
      "INSERT INTO program_cuts (recording_id, wall, source_id, intended) VALUES (?, ?, ?, ?);",
      [
        .integer(recordingID),
        .real(wall.seconds),
        .text(sourceID.rawValue),
        .integer(intended ? 1 : 0)
      ]
    )
  }

  public func programCuts(forRecording id: Int64) throws -> [ProgramCut] {
    try store.query(
      """
      SELECT wall, source_id, intended FROM program_cuts
      WHERE recording_id = ? ORDER BY wall ASC, id ASC;
      """,
      [ .integer(id) ]
    ).map { row in
      ProgramCut(
        wall: WallClock(seconds: row.double(0)),
        sourceID: SourceID(row.string(1)),
        intended: row.int(2) == 1
      )
    }
  }

  /// The camera the operator last chose for programme in this take.
  public func lastIntendedProgramSource(forRecording id: Int64) throws -> SourceID? {
    try store.query(
      """
      SELECT source_id FROM program_cuts
      WHERE recording_id = ? AND intended = 1 ORDER BY wall DESC, id DESC LIMIT 1;
      """,
      [ .integer(id) ]
    ).first.map { SourceID($0.string(0)) }
  }

  // MARK: - Programme parts

  /// The part number a resumed programme encoder should open: one past the highest part this take
  /// has anchored, or one when it has anchored nothing yet.
  ///
  /// Read from the anchors rather than from the files, because a part is only useful to an export
  /// once it has said where it sits on the wall clock. A part that opened and died before its first
  /// anchor is still on disk under that number; the encoder steps over a name that is taken, so
  /// nothing is overwritten either way.
  public func nextProgramPart(forRecording id: Int64) throws -> Int {
    let row = try store.query(
      "SELECT MAX(part) FROM program_anchors WHERE recording_id = ?;",
      [ .integer(id) ]
    ).first
    guard let row, row.values[0] != .null else { return 1 }
    return Int(row.int(0)) + 1
  }

  /// Takes with no end: the one being picked back up, and any a crash left behind.
  public func openRecordingIDs() throws -> Set<Int64> {
    Set(try store.query("SELECT id FROM recordings WHERE ended_at IS NULL;").map { $0.int(0) })
  }

  public func recordings() throws -> [RecordingSummary] {
    let rows = try store.query(
      """
      SELECT r.id, r.started_at, r.ended_at, r.program_filename,
        (SELECT MAX(s.start_wall + s.duration) FROM segments s
          WHERE s.recording_id = r.id AND s.is_initialization = 0),
        r.resume_count, r.encoding_json, r.sound_checks_json, r.game_id, r.game_title
      FROM recordings r
      ORDER BY r.started_at DESC;
      """
    )
    return try rows.map { row in
      let id = row.int(0)
      let started = WallClock(seconds: row.double(1))
      let ended: WallClock? = row.values[2] == .null ? nil : WallClock(seconds: row.double(2))
      let program = row.values[3] == .null || row.string(3).isEmpty ? nil : row.string(3)
      let lastSegment: WallClock? = row.values[4] == .null ? nil : WallClock(seconds: row.double(4))
      return RecordingSummary(
        id: id,
        startedAt: started,
        endedAt: ended,
        programFilename: program,
        sourceIDs: try sourceIDs(in: id),
        lastSegmentEnd: lastSegment,
        resumeCount: Int(row.int(5)),
        encoding: Self.takeEncoding(row.values[6] == .null ? nil : row.string(6)),
        soundChecks: Self.soundChecks(row.values[7] == .null ? nil : row.string(7)),
        gameId: row.values[8] == .null || row.string(8).isEmpty ? nil : row.string(8),
        gameTitle: row.values[9] == .null || row.string(9).isEmpty ? nil : row.string(9)
      )
    }
  }

  public func segments(forRecording id: Int64) throws -> [SegmentRecord] {
    try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments
      WHERE recording_id = ?
      ORDER BY start_wall ASC;
      """,
      [ .integer(id) ]
    ).map(Self.segment(from:))
  }

  /// Unlink this recording's files and drop its index rows. `liveID` is skipped so an in-progress
  /// take cannot be deleted from Recordings.
  public func deleteRecordings(
    ids: [Int64],
    skipping liveID: Int64? = nil,
    roots: RecordingFileRoots = .standard,
    fileManager: FileManager = .default
  ) throws {
    for id in ids {
      if let liveID, id == liveID { continue }
      try deleteRecording(id, roots: roots, fileManager: fileManager)
    }
  }

  public func deleteRecording(
    _ id: Int64,
    roots: RecordingFileRoots = .standard,
    fileManager: FileManager = .default
  ) throws {
    let summaries = try recordings()
    guard let summary = summaries.first(where: { $0.id == id }) else { return }
    let segments = try segments(forRecording: id)
    let from = summary.startedAt
    let to = summary.endedAt ?? segments.map(\.endWall).max() ?? from

    var files: [URL] = []
    for segment in segments {
      files.append(
        roots.archiveDirectory(for: segment.sourceID).appendingPathComponent(segment.filename)
      )
    }
    if let program = summary.programFilename {
      files.append(contentsOf: RecordingExport.programSourceFiles(named: program, in: roots.program))
    }
    files.append(roots.preparedDirectory(for: id))

    let sources = Set(summary.sourceIDs + segments.map(\.sourceID))
    for sourceID in sources {
      let stills = try proxyStills(for: sourceID, from: from, to: to)
      let chunks = Set(stills.map(\.chunk))
      try store.execute(
        "DELETE FROM proxy_stills WHERE source_id = ? AND wall >= ? AND wall <= ?;",
        [ .text(sourceID.rawValue), .real(from.seconds), .real(to.seconds) ]
      )
      for chunk in chunks {
        let remaining = try store.query(
          "SELECT COUNT(*) FROM proxy_stills WHERE source_id = ? AND chunk = ?;",
          [ .text(sourceID.rawValue), .text(chunk) ]
        ).first?.int(0) ?? 0
        if remaining == 0 {
          files.append(roots.proxyDirectory(for: sourceID).appendingPathComponent(chunk))
        }
      }
    }

    try store.execute("DELETE FROM segments WHERE recording_id = ?;", [ .integer(id) ])
    try store.execute("DELETE FROM recording_sources WHERE recording_id = ?;", [ .integer(id) ])
    try store.execute("DELETE FROM program_cuts WHERE recording_id = ?;", [ .integer(id) ])
    try store.execute("DELETE FROM program_anchors WHERE recording_id = ?;", [ .integer(id) ])
    try store.execute(
      "UPDATE live_session SET recording_id = NULL WHERE recording_id = ?;",
      [ .integer(id) ]
    )
    try store.execute("DELETE FROM recordings WHERE id = ?;", [ .integer(id) ])

    for url in files {
      try? fileManager.removeItem(at: url)
    }
  }

  /// Drops one recording's rolling camera archive — its segments and scrubbing proxies — and
  /// leaves the recording itself listed.
  ///
  /// Retention reclaims the archive only. The programme master and anything already prepared for
  /// export are the operator's deliverables, so they go when the operator deletes the recording
  /// and not before; a sweep that quietly took the master would be the same mistake as the
  /// clock-based window, just more expensive.
  @discardableResult
  public func deleteArchive(
    forRecording id: Int64,
    roots: RecordingFileRoots = .standard,
    fileManager: FileManager = .default
  ) throws -> (segments: Int, stills: Int, bytes: Int64) {
    let segments = try allSegments(forRecording: id)
    guard !segments.isEmpty else { return (0, 0, 0) }
    let from = segments.map(\.startWall).min() ?? segments[0].startWall
    let to = segments.map(\.endWall).max() ?? from

    var files: [URL] = []
    var bytes: Int64 = 0
    for segment in segments {
      files.append(
        roots.archiveDirectory(for: segment.sourceID).appendingPathComponent(segment.filename)
      )
      bytes += segment.byteCount
    }

    var stills = 0
    for sourceID in Set(segments.map(\.sourceID)) {
      let existing = try proxyStills(for: sourceID, from: from, to: to)
      stills += existing.count
      let chunks = Set(existing.map(\.chunk))
      try store.execute(
        "DELETE FROM proxy_stills WHERE source_id = ? AND wall >= ? AND wall <= ?;",
        [ .text(sourceID.rawValue), .real(from.seconds), .real(to.seconds) ]
      )
      for chunk in chunks {
        let remaining = try store.query(
          "SELECT COUNT(*) FROM proxy_stills WHERE source_id = ? AND chunk = ?;",
          [ .text(sourceID.rawValue), .text(chunk) ]
        ).first?.int(0) ?? 0
        if remaining == 0 {
          files.append(roots.proxyDirectory(for: sourceID).appendingPathComponent(chunk))
        }
      }
    }

    // Files before rows: a crash mid-sweep leaves rows describing missing files, which
    // `reconcile` clears at launch, rather than files nothing knows about, which leak forever.
    for url in files { try? fileManager.removeItem(at: url) }
    try store.execute("DELETE FROM segments WHERE recording_id = ?;", [ .integer(id) ])
    return (segments.count, stills, bytes)
  }

  public func sourceIDs(in recordingID: Int64) throws -> [SourceID] {
    try store.query(
      """
      SELECT DISTINCT source_id FROM segments
      WHERE recording_id = ?
      ORDER BY source_id;
      """,
      [ .integer(recordingID) ]
    ).map { SourceID($0.string(0)) }
  }

  public func recordingBounds(
    id recordingID: Int64,
    sourceID: SourceID
  ) throws -> (start: WallClock, end: WallClock)? {
    let rows = try store.query(
      """
      SELECT MIN(start_wall), MAX(start_wall + duration) FROM segments
      WHERE recording_id = ? AND source_id = ? AND is_initialization = 0;
      """,
      [ .integer(recordingID), .text(sourceID.rawValue) ]
    )
    guard let row = rows.first, row.values[0] != .null else { return nil }
    return (WallClock(seconds: row.double(0)), WallClock(seconds: row.double(1)))
  }

  // MARK: - Segments

  @discardableResult
  public func insertSegment(
    recordingID: Int64,
    sourceID: SourceID,
    sequence: Int,
    filename: String,
    isInitialization: Bool,
    startWall: WallClock,
    duration: TimeInterval,
    byteCount: Int64,
    firstFrameID: UInt64?,
    transport: String? = nil,
    appliedClockOffset: Double? = nil,
    archiveRate: Double? = nil
  ) throws -> Int64 {
    try store.execute(
      """
      INSERT OR REPLACE INTO segments
        (recording_id, source_id, sequence, filename, is_initialization,
         start_wall, duration, byte_count, first_frame_id,
         transport, applied_clock_offset, archive_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      """,
      [
        .integer(recordingID),
        .text(sourceID.rawValue),
        .integer(Int64(sequence)),
        .text(filename),
        .integer(isInitialization ? 1 : 0),
        .real(startWall.seconds),
        .real(duration),
        .integer(byteCount),
        firstFrameID.map { .integer(Int64($0)) } ?? .null,
        transport.map { .text($0) } ?? .null,
        appliedClockOffset.map { .real($0) } ?? .null,
        archiveRate.map { .real($0) } ?? .null
      ]
    )
  }

  /// Records what a source was meant to do for one recording.
  ///
  /// `archiving: false` with a reason is the case that matters: the source was live and on air but
  /// nothing was written for it, and an export that simply omitted the angle would look identical
  /// to one where the operator never chose it.
  ///
  /// `cameraName` is what the camera was called when it joined; noting the source again without
  /// one keeps the name already stored.
  @discardableResult
  public func noteSource(
    recordingID: Int64,
    sourceID: SourceID,
    transport: String?,
    archiving: Bool,
    reason: String? = nil,
    cameraName: String? = nil
  ) throws -> Int64 {
    try store.execute(
      """
      INSERT INTO recording_sources
        (recording_id, source_id, transport, archiving, reason, camera_name)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (recording_id, source_id) DO UPDATE SET
        transport = excluded.transport,
        archiving = excluded.archiving,
        reason = excluded.reason,
        camera_name = COALESCE(excluded.camera_name, recording_sources.camera_name);
      """,
      [
        .integer(recordingID),
        .text(sourceID.rawValue),
        transport.map { .text($0) } ?? .null,
        .integer(archiving ? 1 : 0),
        reason.map { .text($0) } ?? .null,
        cameraName.map { .text($0) } ?? .null
      ]
    )
  }

  /// Records a camera's new name against a take it is part of, for a rename made mid-take.
  public func nameSource(recordingID: Int64, sourceID: SourceID, cameraName: String) throws {
    try store.execute(
      "UPDATE recording_sources SET camera_name = ? WHERE recording_id = ? AND source_id = ?;",
      [ .text(cameraName), .integer(recordingID), .text(sourceID.rawValue) ]
    )
  }

  public struct ProgramAnchor: Sendable, Equatable, Codable {
    /// Which output file, 1-based. A writer that died mid-take leaves a continuation part.
    public var part: Int
    /// Seconds from the start of that part's own timeline.
    public var programSeconds: Double
    /// What time it was when that moment was written.
    public var wall: WallClock

    /// Wall clock this part's timeline begins at, which is what places it in an export.
    public var partStartWall: WallClock { wall - programSeconds }

    public init(part: Int, programSeconds: Double, wall: WallClock) {
      self.part = part
      self.programSeconds = programSeconds
      self.wall = wall
    }
  }

  @discardableResult
  public func insertProgramAnchor(
    recordingID: Int64,
    part: Int,
    programSeconds: Double,
    wall: WallClock
  ) throws -> Int64 {
    try store.execute(
      "INSERT INTO program_anchors (recording_id, part, program_seconds, wall) VALUES (?, ?, ?, ?);",
      [
        .integer(recordingID),
        .integer(Int64(part)),
        .real(programSeconds),
        .real(wall.seconds)
      ]
    )
  }

  public func programAnchors(recordingID: Int64) throws -> [ProgramAnchor] {
    try store.query(
      """
      SELECT part, program_seconds, wall FROM program_anchors
      WHERE recording_id = ? ORDER BY part ASC, program_seconds ASC;
      """,
      [ .integer(recordingID) ]
    ).map {
      ProgramAnchor(
        part: Int($0.int(0)),
        programSeconds: $0.double(1),
        wall: WallClock(seconds: $0.double(2))
      )
    }
  }

  /// The wall clock each programme part's own timeline starts at, earliest anchor per part.
  /// Where each part's timeline begins on the wall clock: where its earliest anchors agree.
  ///
  /// Every anchor restates the part's start, and they disagree by however wrong the capture time
  /// behind each one was. Those errors run one way: a picture whose capture time under-reports its
  /// age -- a phone's, before its own capture time was carried through the delay line -- anchors
  /// late, and nothing anchors early. rec-351's first anchor was such a phone picture and alone put
  /// the first 41 minutes of its programme 0.47 s behind the cameras; a plain median fared no
  /// better, because most of its anchors were phone pictures too. So a part starts at the median of
  /// the anchors within a quarter of a second of its earliest tenth -- on a take whose anchors are
  /// all honest, that is nearly all of them.
  public func programPartStarts(recordingID: Int64) throws -> [Int: WallClock] {
    Self.partStarts(try programAnchors(recordingID: recordingID))
  }

  /// `programPartStarts` over anchors already read.
  public static func partStarts(_ anchors: [ProgramAnchor]) -> [Int: WallClock] {
    var starts: [Int: [Double]] = [:]
    for anchor in anchors {
      starts[anchor.part, default: []].append(anchor.partStartWall.seconds)
    }
    return starts.compactMapValues { values in
      partStart(implied: values).map { WallClock(seconds: $0.seconds) }
    }
  }

  /// Where one part starts, from the start each of its anchors implies, and how many of those
  /// anchors agree with it; nil for no anchors.
  ///
  /// The median of the anchors within `anchorAgreementSeconds` of the earliest tenth. The count is
  /// how many were within it, which is every anchor on a take whose anchors all tell the same story.
  static func partStart(implied values: [Double]) -> (seconds: Double, agreeing: Int)? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let floor = sorted[sorted.count / 10]
    let agreeing = sorted.filter { $0 <= floor + Self.anchorAgreementSeconds }
    let middle = agreeing.count / 2
    let median = agreeing.count % 2 == 1
      ? agreeing[middle]
      : (agreeing[middle - 1] + agreeing[middle]) / 2
    return (median, agreeing.count)
  }

  /// How far apart anchors may be and still count as agreeing about where their part starts.
  static let anchorAgreementSeconds: Double = 0.25

  public struct RecordingSource: Sendable, Equatable {
    public var sourceID: SourceID
    public var transport: String?
    public var archiving: Bool
    public var reason: String?
    public var cameraName: String?
  }

  /// Every source this recording knew about, whether or not it wrote anything.
  public func sources(forRecording recordingID: Int64) throws -> [RecordingSource] {
    try store.query(
      """
      SELECT source_id, transport, archiving, reason, camera_name FROM recording_sources
      WHERE recording_id = ? ORDER BY source_id ASC;
      """,
      [ .integer(recordingID) ]
    ).map { row in
      RecordingSource(
        sourceID: SourceID(row.string(0)),
        transport: row.values[1] == .null ? nil : row.string(1),
        archiving: row.int(2) == 1,
        reason: row.values[3] == .null ? nil : row.string(3),
        cameraName: row.values[4] == .null ? nil : row.string(4)
      )
    }
  }

  /// The names a recording's cameras had, as far as the index knows: the name stored when each
  /// joined the take, or was renamed during it, else the name in the grid snapshot saved while it
  /// recorded. A camera with neither is absent, and the caller decides what to show for it.
  public func recordedCameraNames(recordingID: Int64) throws -> [SourceID: String] {
    var names: [SourceID: String] = [:]
    if let snapshot = try selections(for: recordingID),
       let grid = try? JSONDecoder().decode([RecordedSelection].self, from: snapshot) {
      for entry in grid {
        if let name = entry.name { names[entry.id] = name }
      }
    }
    for source in try sources(forRecording: recordingID) {
      if let name = Self.nonEmpty(source.cameraName) { names[source.sourceID] = name }
    }
    return names
  }

  /// Just enough of a grid entry to read a camera's name back out of a take's snapshot. The keys
  /// are those of TS Director's `SourceSelection`, which wrote it.
  private struct RecordedSelection: Decodable {
    var id: SourceID
    var advertisedName: String?
    var customName: String?

    var name: String? { ArchiveIndex.nonEmpty(customName) ?? ArchiveIndex.nonEmpty(advertisedName) }
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  public func segments(
    for sourceID: SourceID,
    from: WallClock? = nil,
    to: WallClock? = nil,
    includeInitialization: Bool = false
  ) throws -> [SegmentRecord] {
    var sql = "SELECT \(Self.segmentColumns) FROM segments WHERE source_id = ?"
    var bindings: [SQLiteValue] = [ .text(sourceID.rawValue) ]
    if !includeInitialization { sql += " AND is_initialization = 0" }
    if let from {
      sql += " AND start_wall + duration > ?"
      bindings.append(.real(from.seconds))
    }
    if let to {
      sql += " AND start_wall < ?"
      bindings.append(.real(to.seconds))
    }
    sql += " ORDER BY start_wall ASC;"
    return try store.query(sql, bindings).map(Self.segment(from:))
  }

  /// The media segment covering `wall`, or the last one before it when `wall` falls in a gap.
  /// Returning the earlier segment rather than nothing is what makes a scrub land on real
  /// content instead of a black frame at the edge of a recording.
  public func segment(for sourceID: SourceID, containing wall: WallClock) throws -> SegmentRecord? {
    let rows = try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments
      WHERE source_id = ? AND is_initialization = 0 AND start_wall <= ?
      ORDER BY start_wall DESC LIMIT 1;
      """,
      [ .text(sourceID.rawValue), .real(wall.seconds) ]
    )
    return rows.first.map(Self.segment(from:))
  }

  public func initializationSegment(
    for sourceID: SourceID,
    recordingID: Int64,
    beforeSequence sequence: Int = .max
  ) throws -> SegmentRecord? {
    let rows = try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments
      WHERE source_id = ? AND recording_id = ? AND is_initialization = 1 AND sequence <= ?
      ORDER BY sequence DESC LIMIT 1;
      """,
      [ .text(sourceID.rawValue), .integer(recordingID), .integer(Int64(sequence)) ]
    )
    return rows.first.map(Self.segment(from:))
  }

  public func maxSequence(for sourceID: SourceID, recordingID: Int64) throws -> Int {
    let rows = try store.query(
      "SELECT COALESCE(MAX(sequence), -1) FROM segments WHERE source_id = ? AND recording_id = ?;",
      [ .text(sourceID.rawValue), .integer(recordingID) ]
    )
    return Int(rows.first?.int(0) ?? -1)
  }

  public func nextInitializationSequence(
    for sourceID: SourceID,
    recordingID: Int64,
    after sequence: Int
  ) throws -> Int? {
    let rows = try store.query(
      """
      SELECT sequence FROM segments
      WHERE source_id = ? AND recording_id = ? AND is_initialization = 1 AND sequence > ?
      ORDER BY sequence ASC LIMIT 1;
      """,
      [ .text(sourceID.rawValue), .integer(recordingID), .integer(Int64(sequence)) ]
    )
    guard let row = rows.first else { return nil }
    return Int(row.int(0))
  }

  public func timelineBounds(for sourceID: SourceID) throws -> (start: WallClock, end: WallClock)? {
    let rows = try store.query(
      """
      SELECT MIN(start_wall), MAX(start_wall + duration) FROM segments
      WHERE source_id = ? AND is_initialization = 0;
      """,
      [ .text(sourceID.rawValue) ]
    )
    guard let row = rows.first, case .real = row.values[0] else { return nil }
    return (WallClock(seconds: row.double(0)), WallClock(seconds: row.double(1)))
  }

  public func segmentCount(for sourceID: SourceID? = nil) throws -> Int {
    if let sourceID {
      let rows = try store.query(
        "SELECT COUNT(*) FROM segments WHERE source_id = ? AND is_initialization = 0;",
        [ .text(sourceID.rawValue) ]
      )
      return Int(rows.first?.int(0) ?? 0)
    }
    let rows = try store.query("SELECT COUNT(*) FROM segments WHERE is_initialization = 0;")
    return Int(rows.first?.int(0) ?? 0)
  }

  /// Closes takes nobody is going to write to again, at the end of the media they actually
  /// wrote. The take being resumed, if there is one, is left open.
  ///
  /// A take left open is not merely cosmetic: its length counts up in the Recordings list
  /// forever, and the export path skips any recording without an end, so the footage cannot be
  /// got at. Runs at launch, before anything reads the timeline and before a new take can begin.
  /// The one row it must not touch is the one the app is about to pick up again, which is what
  /// `live` names — every other open row belongs to a take that ended when the app did.
  @discardableResult
  public func closeAbandonedRecordings(except live: Int64? = nil) throws -> Int {
    let rows = try store.query(
      """
      SELECT r.id,
        (SELECT MAX(s.start_wall + s.duration) FROM segments s
          WHERE s.recording_id = r.id AND s.is_initialization = 0)
      FROM recordings r
      WHERE r.ended_at IS NULL;
      """
    )
    var closed = 0
    for row in rows {
      let id = row.int(0)
      if let live, id == live { continue }
      // A take with no segments never wrote anything, so it ends where it started rather than
      // being given a length invented from the clock.
      let endedAt: Double
      if row.values[1] == .null {
        let started = try store.query(
          "SELECT started_at FROM recordings WHERE id = ?;",
          [ .integer(id) ]
        )
        guard let first = started.first else { continue }
        endedAt = first.double(0)
      } else {
        endedAt = row.double(1)
      }
      try store.execute(
        "UPDATE recordings SET ended_at = ? WHERE id = ? AND ended_at IS NULL;",
        [ .real(endedAt), .integer(id) ]
      )
      closed += 1
    }
    return closed
  }

  /// Drops rows whose file is gone and reports files no row describes, so a mid-segment kill
  /// cannot leave the index describing a fiction.
  ///
  /// `recordings` limits it to those takes: their rows, and their `rec-<id>` folder under each
  /// camera. Only a take that was still open when the app died can have been cut off mid-segment,
  /// and one take is a few hundred files where the whole archive is tens of thousands — too many
  /// to stat on the launch path inside the watchdog's allowance. `nil` checks the whole archive.
  @discardableResult
  public func reconcile(
    recordings ids: Set<Int64>? = nil,
    archivesRoot: URL = DirectorPaths.archives,
    with fileManager: FileManager = .default
  ) throws -> (removed: Int, orphans: [URL]) {
    let rows: [SegmentRecord]
    if let ids {
      guard !ids.isEmpty else { return (0, []) }
      let placeholders = Array(repeating: "?", count: ids.count).joined(separator: ", ")
      rows = try store.query(
        "SELECT \(Self.segmentColumns) FROM segments WHERE recording_id IN (\(placeholders)) ORDER BY id ASC;",
        ids.sorted().map { .integer($0) }
      ).map(Self.segment(from:))
    } else {
      rows = try store.query(
        "SELECT \(Self.segmentColumns) FROM segments ORDER BY id ASC;"
      ).map(Self.segment(from:))
    }

    var removed = 0
    var indexed: Set<String> = []
    for record in rows {
      let url = archivesRoot.appendingPathComponent(record.sourceID.slug, isDirectory: true)
        .appendingPathComponent(record.filename)
      if fileManager.fileExists(atPath: url.path) {
        indexed.insert(url.standardizedFileURL.path)
      } else {
        try store.execute("DELETE FROM segments WHERE id = ?;", [ .integer(record.id) ])
        removed += 1
      }
    }

    let searched: [URL]
    if let ids {
      let cameras = (try? fileManager.contentsOfDirectory(
        at: archivesRoot,
        includingPropertiesForKeys: nil
      )) ?? []
      searched = cameras.flatMap { camera in
        ids.sorted().map { camera.appendingPathComponent("rec-\($0)", isDirectory: true) }
      }
    } else {
      searched = [archivesRoot]
    }
    var orphans: [URL] = []
    for folder in searched {
      guard let enumerator = fileManager.enumerator(at: folder, includingPropertiesForKeys: nil) else {
        continue
      }
      for case let url as URL in enumerator where url.pathExtension == "mp4" {
        if !indexed.contains(url.standardizedFileURL.path) { orphans.append(url) }
      }
    }
    return (removed, orphans)
  }

  // MARK: - Proxy stills

  @discardableResult
  public func insertProxyStill(
    sourceID: SourceID,
    wall: WallClock,
    chunk: String,
    offset: Int64,
    length: Int64
  ) throws -> Int64 {
    try store.execute(
      "INSERT INTO proxy_stills (source_id, wall, chunk, offset, length) VALUES (?, ?, ?, ?, ?);",
      [
        .text(sourceID.rawValue),
        .real(wall.seconds),
        .text(chunk),
        .integer(offset),
        .integer(length)
      ]
    )
  }

  /// Wall-clock span of stills written at or after `floor`. The scrub gesture uses this, not
  /// completed archive segments: stills land at 1 fps from the first second of a recording, while
  /// a media segment is only indexed when its file closes (default 3 s), and T3 writes no segments
  /// at all.
  public func proxyTimelineBounds(
    for sourceID: SourceID,
    after floor: WallClock
  ) throws -> (start: WallClock, end: WallClock)? {
    let rows = try store.query(
      """
      SELECT MIN(wall), MAX(wall) FROM proxy_stills
      WHERE source_id = ? AND wall >= ?;
      """,
      [ .text(sourceID.rawValue), .real(floor.seconds) ]
    )
    guard let row = rows.first, case .real = row.values[0] else { return nil }
    return (WallClock(seconds: row.double(0)), WallClock(seconds: row.double(1)))
  }

  public func proxyStill(for sourceID: SourceID, nearest wall: WallClock) throws -> ProxyStillRecord? {
    let before = try store.query(
      """
      SELECT id, source_id, wall, chunk, offset, length FROM proxy_stills
      WHERE source_id = ? AND wall <= ? ORDER BY wall DESC LIMIT 1;
      """,
      [ .text(sourceID.rawValue), .real(wall.seconds) ]
    ).first.map(Self.proxyStill(from:))

    let after = try store.query(
      """
      SELECT id, source_id, wall, chunk, offset, length FROM proxy_stills
      WHERE source_id = ? AND wall > ? ORDER BY wall ASC LIMIT 1;
      """,
      [ .text(sourceID.rawValue), .real(wall.seconds) ]
    ).first.map(Self.proxyStill(from:))

    switch (before, after) {
    case let (before?, after?):
      return abs(before.wall - wall) <= abs(after.wall - wall) ? before : after
    case let (before?, nil):
      return before
    case let (nil, after?):
      return after
    default:
      return nil
    }
  }

  public func proxyStills(
    for sourceID: SourceID,
    from: WallClock,
    to: WallClock
  ) throws -> [ProxyStillRecord] {
    try store.query(
      """
      SELECT id, source_id, wall, chunk, offset, length FROM proxy_stills
      WHERE source_id = ? AND wall >= ? AND wall <= ? ORDER BY wall ASC;
      """,
      [ .text(sourceID.rawValue), .real(from.seconds), .real(to.seconds) ]
    ).map(Self.proxyStill(from:))
  }

  public func proxyStillCount(for sourceID: SourceID? = nil) throws -> Int {
    if let sourceID {
      let rows = try store.query(
        "SELECT COUNT(*) FROM proxy_stills WHERE source_id = ?;",
        [ .text(sourceID.rawValue) ]
      )
      return Int(rows.first?.int(0) ?? 0)
    }
    return Int(try store.query("SELECT COUNT(*) FROM proxy_stills;").first?.int(0) ?? 0)
  }

  // MARK: - Retention

  /// Returns the segments and proxy rows that fall entirely before `cutoff`, oldest first, so
  /// the caller can delete files before dropping the rows.
  /// The recording whose media starts earliest, and the wall-clock window it covers.
  ///
  /// Retention drops whole recordings rather than the leading segments of one, so a take that
  /// survives a sweep is still a take: an operator exporting a game gets all of it or none of it,
  /// never a game missing its first twenty minutes.
  public func oldestRecordingWithSegments() throws -> (id: Int64, start: WallClock, end: WallClock)? {
    let rows = try store.query(
      """
      SELECT recording_id, MIN(start_wall), MAX(start_wall + duration) FROM segments
      WHERE is_initialization = 0
      GROUP BY recording_id
      ORDER BY MIN(start_wall) ASC
      LIMIT 1;
      """
    )
    guard let row = rows.first else { return nil }
    return (row.int(0), WallClock(seconds: row.double(1)), WallClock(seconds: row.double(2)))
  }

  /// Every segment belonging to one recording, initialisation segments included, so a caller
  /// deleting the recording can unlink all of its files.
  public func allSegments(forRecording id: Int64) throws -> [SegmentRecord] {
    try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments
      WHERE recording_id = ?
      ORDER BY start_wall ASC;
      """,
      [ .integer(id) ]
    ).map(Self.segment(from:))
  }

  public func deleteSegment(_ id: Int64) throws {
    try store.execute("DELETE FROM segments WHERE id = ?;", [ .integer(id) ])
  }

  public func deleteProxyStills(before cutoff: WallClock) throws -> Int {
    let rows = try store.query(
      "SELECT COUNT(*) FROM proxy_stills WHERE wall < ?;",
      [ .real(cutoff.seconds) ]
    )
    try store.execute("DELETE FROM proxy_stills WHERE wall < ?;", [ .real(cutoff.seconds) ])
    return Int(rows.first?.int(0) ?? 0)
  }

  /// Initialisation segments for recordings with no media left are dead weight; drop them and
  /// report their files so the caller can unlink them.
  public func orphanedInitializationSegments() throws -> [SegmentRecord] {
    try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments AS init
      WHERE init.is_initialization = 1
        AND NOT EXISTS (
          SELECT 1 FROM segments AS media
          WHERE media.is_initialization = 0
            AND media.recording_id = init.recording_id
            AND media.source_id = init.source_id
        );
      """
    ).map(Self.segment(from:))
  }

  /// Archived bytes per recording and camera, in one pass over the index.
  public func bytesBySource() throws -> [Int64: [SourceID: Int64]] {
    var totals: [Int64: [SourceID: Int64]] = [:]
    for row in try store.query(
      "SELECT recording_id, source_id, SUM(byte_count) FROM segments GROUP BY recording_id, source_id;"
    ) {
      totals[row.int(0), default: [:]][SourceID(row.string(1))] = row.int(2)
    }
    return totals
  }

  public func totalBytes() throws -> Int64 {
    try store.query("SELECT COALESCE(SUM(byte_count), 0) FROM segments;").first?.int(0) ?? 0
  }

  // MARK: - Manifests

  /// The rows an export of `sourceIDs` from recording `recordingID` reads, or nil when the index
  /// has no such recording.
  public func manifest(recordingID: Int64, sourceIDs: [SourceID]) throws -> RecordingManifest? {
    guard let row = try store.query(
      "SELECT started_at, ended_at, program_filename, encoding_json FROM recordings WHERE id = ?;",
      [ .integer(recordingID) ]
    ).first else { return nil }
    return RecordingManifest(
      recordingID: recordingID,
      startedAt: WallClock(seconds: row.double(0)),
      endedAt: row.values[1] == .null ? nil : WallClock(seconds: row.double(1)),
      programFilename: row.values[2] == .null ? nil : row.string(2),
      segments: try allSegments(forRecording: recordingID).filter { sourceIDs.contains($0.sourceID) },
      programAnchors: try programAnchors(recordingID: recordingID),
      encoding: Self.takeEncoding(row.values[3] == .null ? nil : row.string(3))
    )
  }

  /// Loads `manifest` under the recording's own id, in one transaction, replacing whatever this
  /// index already held for that recording. Meant for an empty scratch index on the machine doing
  /// the stitching; the segment ids are the originals, which are unique across the source index.
  public func importManifest(_ manifest: RecordingManifest) throws {
    try store.transaction { transaction in
      let id = SQLiteValue.integer(manifest.recordingID)
      try transaction.execute("DELETE FROM segments WHERE recording_id = ?;", [ id ])
      try transaction.execute("DELETE FROM program_anchors WHERE recording_id = ?;", [ id ])
      try transaction.execute(
        """
        INSERT OR REPLACE INTO recordings (id, started_at, ended_at, program_filename, encoding_json)
        VALUES (?, ?, ?, ?, ?);
        """,
        [
          id,
          .real(manifest.startedAt.seconds),
          manifest.endedAt.map { .real($0.seconds) } ?? .null,
          manifest.programFilename.map { .text($0) } ?? .null,
          (try manifest.encoding.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) })
            .map { .text($0) } ?? .null
        ]
      )
      for segment in manifest.segments {
        try transaction.execute(
          """
          INSERT INTO segments (\(Self.segmentColumns))
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
          """,
          [
            .integer(segment.id),
            id,
            .text(segment.sourceID.rawValue),
            .integer(Int64(segment.sequence)),
            .text(segment.filename),
            .integer(segment.isInitialization ? 1 : 0),
            .real(segment.startWall.seconds),
            .real(segment.duration),
            .integer(segment.byteCount),
            segment.firstFrameID.map { .integer(Int64(clamping: $0)) } ?? .null,
            segment.transport.map { .text($0) } ?? .null,
            segment.appliedClockOffset.map { .real($0) } ?? .null,
            segment.archiveRate.map { .real($0) } ?? .null
          ]
        )
      }
      for anchor in manifest.programAnchors {
        try transaction.execute(
          "INSERT INTO program_anchors (recording_id, part, program_seconds, wall) VALUES (?, ?, ?, ?);",
          [ id, .integer(Int64(anchor.part)), .real(anchor.programSeconds), .real(anchor.wall.seconds) ]
        )
      }
    }
  }

  // MARK: - Row mapping

  private static let segmentColumns = """
    id, recording_id, source_id, sequence, filename, is_initialization,
    start_wall, duration, byte_count, first_frame_id,
    transport, applied_clock_offset, archive_rate
    """

  private static func segment(from row: SQLiteRow) -> SegmentRecord {
    SegmentRecord(
      id: row.int(0),
      recordingID: row.int(1),
      sourceID: SourceID(row.string(2)),
      sequence: Int(row.int(3)),
      filename: row.string(4),
      isInitialization: row.int(5) == 1,
      startWall: WallClock(seconds: row.double(6)),
      duration: row.double(7),
      byteCount: row.int(8),
      firstFrameID: row.values[9] == .null ? nil : UInt64(row.int(9)),
      transport: row.values[10] == .null ? nil : row.string(10),
      appliedClockOffset: row.values[11] == .null ? nil : row.double(11),
      archiveRate: row.values[12] == .null ? nil : row.double(12)
    )
  }

  private static func proxyStill(from row: SQLiteRow) -> ProxyStillRecord {
    ProxyStillRecord(
      id: row.int(0),
      sourceID: SourceID(row.string(1)),
      wall: WallClock(seconds: row.double(2)),
      chunk: row.string(3),
      offset: row.int(4),
      length: row.int(5)
    )
  }
}
