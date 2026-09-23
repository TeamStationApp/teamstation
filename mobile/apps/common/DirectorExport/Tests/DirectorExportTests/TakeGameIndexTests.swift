import Foundation
import DirectorCore
import DirectorExport
import Testing

/// The game a take was streamed to, kept with the take.
///
/// This is what lets an upload afterwards need no question asked: the take
/// already knows its event, so pressing Upload sends it there instead of
/// asking somebody to remember, hours later, which of a Saturday's games this
/// one was.
@Suite("The game a take was streamed to")
struct TakeGameIndexTests {
  private func scratch() throws -> URL {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("take-game-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  @Test("A take streamed to a game is read back with it")
  func keepsTheGame() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))

    try index.setGame(id, gameId: "gam_1", title: "2026-09-20 Trosky at Rangers")

    let take = try #require(try index.recordings().first)
    #expect(take.gameId == "gam_1")
    #expect(take.gameTitle == "2026-09-20 Trosky at Rangers")
  }

  @Test("A take recorded with no stream names no game")
  func namesNothingWithoutAStream() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    _ = try index.beginRecording(at: WallClock(seconds: 1_000))

    let take = try #require(try index.recordings().first)
    // Nil rather than empty: this is the take the operator is asked about.
    #expect(take.gameId == nil)
    #expect(take.gameTitle == nil)
  }

  @Test("The first game a take was streamed to is the game it is of")
  func doesNotChangeItsMind() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let id = try index.beginRecording(at: WallClock(seconds: 1_000))

    try index.setGame(id, gameId: "gam_1", title: "2026-09-20 Trosky at Rangers")
    // A redial mid-game, or a second stream started from the same take: the
    // publish is set up again and says so again. What is already written wins.
    try index.setGame(id, gameId: "gam_2", title: "2026-09-20 Someone Else")

    #expect(try index.recordings().first?.gameId == "gam_1")
  }

  @Test("A take of one game leaves the others alone")
  func staysOnItsOwnTake() throws {
    let root = try scratch()
    defer { try? FileManager.default.removeItem(at: root) }
    let index = try ArchiveIndex(url: root.appendingPathComponent("index.sqlite"))
    let streamed = try index.beginRecording(at: WallClock(seconds: 1_000))
    let bench = try index.beginRecording(at: WallClock(seconds: 2_000))

    try index.setGame(streamed, gameId: "gam_1", title: "2026-09-20 Trosky at Rangers")

    let takes = try index.recordings()
    #expect(takes.first { $0.id == streamed }?.gameId == "gam_1")
    #expect(takes.first { $0.id == bench }?.gameId == nil)
  }
}
