import Foundation
import ProducerCore

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

  public var endWall: WallClock { startWall + duration }
}

public struct RecordingSummary: Sendable, Equatable, Identifiable {
  public var id: Int64
  public var startedAt: WallClock
  public var endedAt: WallClock?
  public var programFilename: String?
  public var sourceIDs: [SourceID]

  public var duration: TimeInterval {
    (endedAt ?? WallClock(seconds: Date().timeIntervalSince1970)) - startedAt
  }

  public init(
    id: Int64,
    startedAt: WallClock,
    endedAt: WallClock?,
    programFilename: String?,
    sourceIDs: [SourceID]
  ) {
    self.id = id
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.programFilename = programFilename
    self.sourceIDs = sourceIDs
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

  public convenience init(url: URL = ProducerPaths.indexDatabase) throws {
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
  }

  // MARK: - Recordings

  public func beginRecording(at wall: WallClock) throws -> Int64 {
    try store.execute(
      "INSERT INTO recordings (started_at) VALUES (?);",
      [ .real(wall.seconds) ]
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

  public func recordings() throws -> [RecordingSummary] {
    let rows = try store.query(
      """
      SELECT id, started_at, ended_at, program_filename
      FROM recordings
      ORDER BY started_at DESC;
      """
    )
    return try rows.map { row in
      let id = row.int(0)
      let started = WallClock(seconds: row.double(1))
      let ended: WallClock? = row.values[2] == .null ? nil : WallClock(seconds: row.double(2))
      let program = row.values[3] == .null || row.string(3).isEmpty ? nil : row.string(3)
      return RecordingSummary(
        id: id,
        startedAt: started,
        endedAt: ended,
        programFilename: program,
        sourceIDs: try sourceIDs(in: id)
      )
    }
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
    firstFrameID: UInt64?
  ) throws -> Int64 {
    try store.execute(
      """
      INSERT OR REPLACE INTO segments
        (recording_id, source_id, sequence, filename, is_initialization,
         start_wall, duration, byte_count, first_frame_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
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
        firstFrameID.map { .integer(Int64($0)) } ?? .null
      ]
    )
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

  /// Drops index rows whose files are gone and reports files that exist but are unindexed.
  /// Run at launch so a mid-segment kill cannot leave the index describing a fiction.
  @discardableResult
  public func reconcile(with fileManager: FileManager = .default) throws -> (removed: Int, orphans: [URL]) {
    let rows = try store.query(
      "SELECT \(Self.segmentColumns) FROM segments ORDER BY id ASC;"
    ).map(Self.segment(from:))

    var removed = 0
    var indexed: Set<String> = []
    for record in rows {
      let url = ProducerPaths.archiveDirectory(for: record.sourceID)
        .appendingPathComponent(record.filename)
      if fileManager.fileExists(atPath: url.path) {
        indexed.insert(url.standardizedFileURL.path)
      } else {
        try store.execute("DELETE FROM segments WHERE id = ?;", [ .integer(record.id) ])
        removed += 1
      }
    }

    var orphans: [URL] = []
    if let enumerator = fileManager.enumerator(
      at: ProducerPaths.archives,
      includingPropertiesForKeys: nil
    ) {
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
  /// a media segment is only indexed when its file closes (default 6 s), and T3 writes no segments
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
  public func expiredSegments(before cutoff: WallClock) throws -> [SegmentRecord] {
    try store.query(
      """
      SELECT \(Self.segmentColumns) FROM segments
      WHERE is_initialization = 0 AND start_wall + duration < ?
      ORDER BY start_wall ASC;
      """,
      [ .real(cutoff.seconds) ]
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

  public func totalBytes() throws -> Int64 {
    try store.query("SELECT COALESCE(SUM(byte_count), 0) FROM segments;").first?.int(0) ?? 0
  }

  // MARK: - Row mapping

  private static let segmentColumns = """
    id, recording_id, source_id, sequence, filename, is_initialization,
    start_wall, duration, byte_count, first_frame_id
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
      firstFrameID: row.values[9] == .null ? nil : UInt64(row.int(9))
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
