import Foundation
import DirectorCore
import DirectorExport
import Testing

/// The server's clock against the iPad's, kept in the index and read back per take.
///
/// Every upload of a take says how far the server's clock was from the iPad's while the take was
/// made, so the server can put the video on the clock the game's scoring is stamped by.
@Suite("The server's clock in the index")
struct ServerClockIndexTests {
  private func scratch() throws -> (URL, ArchiveIndex) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("server-clock-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return (root, try ArchiveIndex(url: root.appendingPathComponent("index.sqlite")))
  }

  private func sample(_ wall: Double, _ offsetMs: Int, rtt: Int = 40) -> ServerClockRecord {
    ServerClockRecord(wall: WallClock(seconds: wall), offsetMs: offsetMs, rttMs: rtt)
  }

  @Test("Samples are kept with their time, offset and round trip, earliest first")
  func keepsRows() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }

    try index.insertServerClockSample(sample(2_000, 310, rtt: 55))
    try index.insertServerClockSample(sample(1_000, -20, rtt: 90))

    #expect(try index.serverClockSamples() == [ sample(1_000, -20, rtt: 90), sample(2_000, 310, rtt: 55) ])
  }

  @Test("A take's offset is the median of the samples inside it")
  func medianInside() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_300))
    // Outside the take, either side: not counted while there are samples inside.
    try index.insertServerClockSample(sample(900, 9_000))
    try index.insertServerClockSample(sample(1_400, -9_000))
    // Inside: 100, 120, 900 (one slow trip), 110, 105. The median is 110 whatever the outlier says.
    for (wall, offset) in [ (1_000.0, 100), (1_060, 120), (1_120, 900), (1_180, 110), (1_300, 105) ] {
      try index.insertServerClockSample(sample(wall, offset))
    }

    #expect(try index.recordings().first?.serverClockOffsetMs == 110)
  }

  @Test("An even number of samples takes the middle two's mean")
  func evenMedian() {
    let offset = ArchiveIndex.serverClockOffset(
      [ sample(10, 100), sample(20, 103), sample(30, 200), sample(40, 90) ],
      from: WallClock(seconds: 0),
      to: WallClock(seconds: 50)
    )
    // 90 100 103 200: (100 + 103) / 2, rounded.
    #expect(offset == 102)
  }

  @Test("With no sample inside, the nearest one stands in")
  func nearestSample() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    try index.insertServerClockSample(sample(500, 70))   // 500 s before the take
    try index.insertServerClockSample(sample(1_090, 40)) // 30 s after it
    try index.insertServerClockSample(sample(5_000, 10))
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_060))

    #expect(try index.recordings().first?.serverClockOffsetMs == 40)

    // Before a take, by its start.
    #expect(ArchiveIndex.serverClockOffset(
      [ sample(990, 7), sample(1_200, 8) ],
      from: WallClock(seconds: 1_000),
      to: WallClock(seconds: 1_100)
    ) == 7)
  }

  @Test("A take still recording reads every sample since it began")
  func openTake() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    try index.insertServerClockSample(sample(900, 999))
    _ = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.insertServerClockSample(sample(1_010, 30))
    try index.insertServerClockSample(sample(9_000, 50))
    try index.insertServerClockSample(sample(9_060, 40))

    #expect(try index.recordings().first?.serverClockOffsetMs == 40)
    // With nothing since it began, the sample before it.
    #expect(ArchiveIndex.serverClockOffset(
      [ sample(900, 999) ],
      from: WallClock(seconds: 1_000),
      to: nil
    ) == 999)
  }

  @Test("An ended take's offset is final: a nearer sample measured later does not move it")
  func endedTakeIsFinal() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    // A take too short for the minute's schedule to land in: nothing inside it.
    try index.insertServerClockSample(sample(500, 70))
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_030))

    // The first listing after its end uses the only sample there is.
    #expect(try index.recordings().first?.serverClockOffsetMs == 70)

    // A sample after it, nearer than the one used: a camera retried now, or a file sent from the
    // other app, still goes up with the offset the first files had.
    try index.insertServerClockSample(sample(1_040, 4_000))
    #expect(try index.recordings().first?.serverClockOffsetMs == 70)
    // So does a fresh index on the same file, as the next launch opens it.
    let reopened = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    #expect(try reopened.recordings().first?.serverClockOffsetMs == 70)
  }

  @Test("An ended take's median inside it is stored as it was")
  func medianInsideIsKept() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    for (wall, offset) in [ (1_010.0, 100), (1_070, 130), (1_130, 110) ] {
      try index.insertServerClockSample(sample(wall, offset))
    }
    try index.endRecording(take, at: WallClock(seconds: 1_200))

    #expect(try index.recordings().first?.serverClockOffsetMs == 110)
    try index.insertServerClockSample(sample(1_210, -5_000))
    #expect(try index.recordings().first?.serverClockOffsetMs == 110)
  }

  @Test("A take still recording follows each new sample, and freezes once it ends")
  func openTakeFollowsThenFreezes() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.insertServerClockSample(sample(1_010, 30))
    #expect(try index.recordings().first?.serverClockOffsetMs == 30)
    try index.insertServerClockSample(sample(1_070, 50))
    try index.insertServerClockSample(sample(1_130, 60))
    #expect(try index.recordings().first?.serverClockOffsetMs == 50)

    try index.endRecording(take, at: WallClock(seconds: 1_140))
    #expect(try index.recordings().first?.serverClockOffsetMs == 50)
    try index.insertServerClockSample(sample(1_150, 900))
    #expect(try index.recordings().first?.serverClockOffsetMs == 50)
  }

  @Test("An ended take with no sample anywhere stays open until the first one, then freezes on it")
  func nilAtFirstListing() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_060))

    // Never measured: nothing to store, so nothing is.
    #expect(try index.recordings().first?.serverClockOffsetMs == nil)
    // The sign-in after an offline take measures the clock for the first time.
    try index.insertServerClockSample(sample(2_000, 25))
    #expect(try index.recordings().first?.serverClockOffsetMs == 25)
    // And that is final.
    try index.insertServerClockSample(sample(1_070, 8))
    #expect(try index.recordings().first?.serverClockOffsetMs == 25)
  }

  @Test("An index that cannot be written still lists, computing without storing")
  func unwritableIndex() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("server-clock-ro-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try SQLiteStore(url: root.appendingPathComponent("index.sqlite"))
    let index = try ArchiveIndex(store: store)
    try index.insertServerClockSample(sample(500, 70))
    let take = try index.beginRecording(at: WallClock(seconds: 1_000))
    try index.endRecording(take, at: WallClock(seconds: 1_030))
    try store.execute("PRAGMA query_only = ON;")

    #expect(try index.recordings().first?.serverClockOffsetMs == 70)

    // Nothing was kept, so a nearer sample is read the next time, once the index can be written.
    try store.execute("PRAGMA query_only = OFF;")
    try index.insertServerClockSample(sample(1_040, 4_000))
    #expect(try index.recordings().first?.serverClockOffsetMs == 4_000)
  }

  @Test("A take an iPad never measured has no offset")
  func neverMeasured() throws {
    let (root, index) = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    _ = try index.beginRecording(at: WallClock(seconds: 1_000))

    #expect(try index.recordings().first?.serverClockOffsetMs == nil)
  }

  @Test("An index from before the table opens and gains it")
  func olderIndex() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("server-clock-old-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("index.sqlite")
    do {
      let store = try SQLiteStore(url: url)
      try store.execute("""
        CREATE TABLE recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at REAL NOT NULL,
          ended_at REAL,
          program_filename TEXT
        );
        """)
      try store.execute("INSERT INTO recordings (started_at, ended_at) VALUES (1000, 1100);")
    }

    let index = try ArchiveIndex(url: url)
    #expect(try index.recordings().first?.serverClockOffsetMs == nil)
    try index.insertServerClockSample(sample(1_050, 12))
    #expect(try index.recordings().first?.serverClockOffsetMs == 12)
  }
}
