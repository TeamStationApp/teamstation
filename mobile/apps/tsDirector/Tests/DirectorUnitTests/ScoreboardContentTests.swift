import CoreGraphics
import DirectorCore
import Foundation
import Testing

private let sample = URL(string: "https://ts.example/scoreboard-sample")!
private let live = URL(string: "https://ts.example/scoreboard/g1?quiet=1")!
private let canvas = CGSize(width: 1920, height: 1080)

private func overlay(_ kind: ProgramOverlayKind, showInLive: Bool = true) -> ProgramOverlay {
  ProgramOverlay(
    kind: kind, originX: 0.1, originY: 0.1, width: 0.2, height: 0.1,
    placement: .centerQuarter, showInRewind: false, showInLive: showInLive
  )
}

@Suite("Scoreboard content")
struct ScoreboardContentTests {
  @Test func showsTheSampleWhileTheEditorIsOpenAndNothingIsCapturing() {
    for liveURL in [ live, nil ] as [URL?] {
      #expect(
        ScoreboardOverlaySource.url(live: liveURL, sample: sample, editorOpen: true, capturing: false)
          == sample
      )
    }
  }

  @Test func showsTheLiveBoardOtherwiseAndNothingWithoutOne() {
    #expect(
      ScoreboardOverlaySource.url(live: live, sample: sample, editorOpen: true, capturing: true)
        == live
    )
    #expect(
      ScoreboardOverlaySource.url(live: nil, sample: sample, editorOpen: true, capturing: true)
        == nil
    )
    for capturing in [ false, true ] {
      #expect(
        ScoreboardOverlaySource.url(
          live: live, sample: sample, editorOpen: false, capturing: capturing
        ) == live
      )
      #expect(
        ScoreboardOverlaySource.url(
          live: nil, sample: sample, editorOpen: false, capturing: capturing
        ) == nil
      )
    }
  }

  @Test func webAndScoreboardAreWebBacked() {
    #expect(ProgramOverlayKind.web.isWebBacked)
    #expect(ProgramOverlayKind.scoreboard.isWebBacked)
    #expect(!ProgramOverlayKind.image.isWebBacked)
    #expect(!ProgramOverlayKind.text.isWebBacked)
  }

  @Test(arguments: [ ProgramOverlayKind.scoreboard, .web ])
  func aResizeSetsTheScaleTheNextSnapshotKeeps(kind: ProgramOverlayKind) {
    var board = overlay(kind)
    board.nativeWidth = 800
    board.nativeHeight = 200
    board.scale = 0.5
    board.hasLaidOut = true
    let resized = OverlayLayout.applyResize(
      board,
      to: CGRect(x: 0.05, y: 0.7, width: 0.25, height: 0.3),
      canvas: canvas
    )
    #expect(abs(resized.scale - 0.6) < 1e-9)
    #expect(resized.originX == 0.05)
    #expect(resized.originY == 0.7)
    #expect(abs(resized.width - 0.25) < 1e-9)
    // The height follows the page's shape, not the drag.
    #expect(abs(resized.height - 120.0 / 1080) < 1e-9)

    // What `fitWebOverlay` does with the next snapshot of the same page.
    let native = CGSize(width: 800, height: 200)
    let saved = CGSize(width: resized.nativeWidth, height: resized.nativeHeight)
    let resolved = OverlayLayout.resolveWebNative(
      incoming: native, saved: saved, pending: nil, now: Date()
    )
    #expect(resolved.applyLayout)
    let scale = OverlayLayout.scalePreservingDisplay(
      scale: resized.scale, from: saved, to: resolved.native
    )
    let size = OverlayLayout.scaledNormalized(native: resolved.native, scale: scale, canvas: canvas)
    #expect(abs(size.width - resized.width) < 1e-9)
    #expect(abs(size.height - resized.height) < 1e-9)
  }

  @Test func aResizeOfAnythingElseKeepsItsRect() {
    var text = overlay(.text)
    text.hugText = true
    let resized = OverlayLayout.applyResize(
      text, to: CGRect(x: 0.2, y: 0.3, width: 5, height: 0.001), canvas: canvas
    )
    #expect(resized.width == 4)
    #expect(resized.height == 0.02)
    #expect(resized.hasLaidOut)
    #expect(resized.hugText == false)
    // A page not yet measured has no scale to set.
    let unmeasured = OverlayLayout.applyResize(
      overlay(.scoreboard), to: CGRect(x: 0, y: 0, width: 0.3, height: 0.2), canvas: canvas
    )
    #expect(unmeasured.width == 0.3)
    #expect(unmeasured.scale == 1)
  }

  @Test func aScoreboardRoundTripsThroughTheStore() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("scoreboard-store-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = OverlayStore(root: root)
    var board = overlay(.scoreboard)
    board.showInRewind = true
    let template = OverlayTemplate(name: "game", overlays: [ board, overlay(.web) ])
    store.save(OverlayManifest(templates: [ template ], activeTemplateID: template.id))

    let loaded = store.loadManifest()
    #expect(loaded.templates[0].overlays == template.overlays)
    #expect(loaded.templates[0].overlays[0].kind == .scoreboard)
    #expect(loaded.templates[0].overlays[0].url.isEmpty)

    // A manifest from before scoreboards existed still loads as it was.
    let plain = OverlayTemplate(name: "old", overlays: [ overlay(.web) ])
    store.save(OverlayManifest(templates: [ plain ], activeTemplateID: plain.id))
    #expect(store.loadManifest().templates[0].overlays == plain.overlays)
  }

  @Test func addsOneScoreboardInTheCentreQuarter() throws {
    let empty = OverlayTemplate(name: "game", overlays: [ overlay(.web) ])
    let added = try #require(empty.addingScoreboard(canvas: canvas))
    let board = try #require(added.overlays.last)
    #expect(added.overlays.count == 2)
    #expect(board.kind == .scoreboard)
    #expect(board.url.isEmpty)
    #expect(board.showInLive)
    #expect(!board.showInRewind)
    #expect(board.placement == .centerQuarter)
    let rect = OverlayLayout.centerQuarter(native: ScoreboardOverlaySource.boardSize, canvas: canvas)
    let expected = OverlayLayout.normalized(rect, canvas: canvas)
    #expect(board.originX == expected.originX)
    #expect(board.originY == expected.originY)
    #expect(board.width == expected.width)
    #expect(board.height == expected.height)
    #expect(abs(board.width - 0.25) < 1e-9)
    // Laid out from its page already, so its page's first measure does not place it.
    #expect(board.hasLaidOut)
    #expect(board.nativeWidth == 607)
    #expect(board.nativeHeight == 247)
    #expect(board.scale == 480.0 / 607)

    #expect(added.addingScoreboard(canvas: canvas) == nil)
  }

  @Test func assumesBoardSizeB() {
    // SCOREBOARD_BOARD_SIZE in src/common/scoreboard.ts: 1.0's board drawn
    // with the sample in a 1920 × 1080 window, 606.53 × 247, rounded up.
    #expect(ScoreboardOverlaySource.boardSize == CGSize(width: 607, height: 247))
  }

  @Test func dropsOnlyAScoreboardWithNoPage() {
    let all = [ overlay(.web), overlay(.image), overlay(.text), overlay(.scoreboard) ]
    #expect(OverlayComposition.drawable(all, scoreboardURL: nil).map(\.kind) == [ .web, .image, .text ])
    #expect(OverlayComposition.drawable(all, scoreboardURL: live) == all)
  }

  @Test func aLiveOnlyScoreboardCollapsesDuringRewindAsAWebOverlayDoes() {
    let board = overlay(.scoreboard)
    let web = overlay(.web)
    let rewinding = OverlayLayout.displayRects(
      overlays: [ board, web ], canvas: canvas, programIsOffLive: true
    )
    #expect(rewinding[board.id]?.size == .zero)
    #expect(rewinding[web.id]?.size == .zero)
    let live = OverlayLayout.displayRects(
      overlays: [ board ], canvas: canvas, programIsOffLive: false
    )
    #expect(live[board.id] == OverlayLayout.pixelRect(board, canvas: canvas))
  }

}

// MARK: - Snapshots

/// A web overlay as `AppEnvironment.addWebOverlay` makes it.
private func newWebOverlay(placement: OverlayPlacement = .centerQuarter) -> ProgramOverlay {
  let rect = OverlayLayout.centerQuarter(native: CGSize(width: 800, height: 450), canvas: canvas)
  let placed = OverlayLayout.normalized(rect, canvas: canvas)
  return ProgramOverlay(
    kind: .web, url: "https://ts.example/scoreboard-sample",
    originX: placed.originX, originY: placed.originY, width: placed.width, height: placed.height,
    placement: placement
  )
}

/// A scoreboard as the Add menu makes it.
private func newScoreboard() throws -> ProgramOverlay {
  let template = try #require(OverlayTemplate(name: "", overlays: []).addingScoreboard(canvas: canvas))
  return try #require(template.overlays.first)
}

/// Runs snapshots of the given page sizes, `gap` seconds apart, through the
/// layout `AppEnvironment.fitWebOverlay` applies, as it keeps `pending`.
private func snapshots(
  _ overlay: ProgramOverlay,
  _ sizes: [CGSize],
  gap: TimeInterval = 1
) -> ProgramOverlay {
  var current = overlay
  var pending: OverlayLayout.PendingWebNative?
  let start = Date(timeIntervalSince1970: 1_000)
  for (index, size) in sizes.enumerated() {
    let fit = OverlayLayout.fitWebSnapshot(
      current, native: size, canvas: canvas, pending: pending,
      now: start.addingTimeInterval(Double(index) * gap)
    )
    pending = fit.pending
    if fit.applied {
      current = fit.overlay
    } else {
      #expect(fit.overlay == current)
    }
  }
  return current
}

private let board = ScoreboardOverlaySource.boardSize
private let boardInPixels = CGSize(width: board.width * 2, height: board.height * 2)
/// The scale that fits the board to a quarter of the 1920-wide canvas.
private let quarterScale = 480.0 / 607
/// The board's height in the centre quarter, in canvas pixels.
private let quarterHeight = 247 * quarterScale
/// The page before the board mounts: an empty `#root` filling the web view,
/// which `measureContent` lays out at 1920 × 2160.
private let emptyPage = CGSize(width: 1920, height: 2160)

private func isCentreQuarter(_ overlay: ProgramOverlay) -> Bool {
  abs(overlay.width - 0.25) < 1e-6
    && abs(overlay.originX - 0.375) < 1e-6
    && abs(overlay.height - quarterHeight / 1080) < 1e-6
    && abs(overlay.originY - (1080.0 - quarterHeight) / 2 / 1080) < 1e-6
}

@Suite("Scoreboard and web overlay snapshots")
struct ScoreboardSnapshotTests {
  @Test func aNewWebOverlayMeasuredAsTheBoardFillsTheCentreQuarter() {
    let placed = snapshots(newWebOverlay(), [ board, board ])
    #expect(isCentreQuarter(placed))
    #expect(abs(placed.scale - quarterScale) < 1e-9)
    #expect(placed.hasLaidOut)
  }

  @Test func aPageThatSettlesSmallerFollowsThatSizeAtTheScaleItWasPlacedWith() {
    // Placed from a 2× measure, then the page reports the real size. The scale
    // stays, so the box shrinks with the page instead of holding the 2× box.
    let placed = snapshots(newWebOverlay(), [ boardInPixels, board, board, board ], gap: 1.5)
    let firstScale = OverlayLayout.scaleFittingQuarter(native: boardInPixels, canvas: canvas)
    let size = OverlayLayout.scaledNormalized(native: board, scale: firstScale, canvas: canvas)
    #expect(placed.nativeWidth == 607)
    #expect(placed.nativeHeight == 247)
    #expect(abs(placed.scale - firstScale) < 1e-9)
    #expect(abs(placed.width - size.width) < 1e-9)
    #expect(abs(placed.height - size.height) < 1e-9)
  }

  @Test func aNewWebOverlayMeasuredAsAnEmptyPageFirstIsPlacedFromIt() {
    // What a web overlay has always done, and still does, with a page that
    // measures the whole web view before its content mounts: placed from
    // that measure, and keeping its scale when the content arrives.
    let placed = snapshots(newWebOverlay(), [ emptyPage, board, board, board ], gap: 1.5)
    #expect(abs(placed.scale - 0.125) < 1e-9)
    #expect(abs(placed.width - 607 * 0.125 / 1920) < 1e-9)
    #expect(placed.originX == 0.4375)
    #expect(placed.originY == 0.375)
  }

  @Test(arguments: [
    [ board ],
    [ boardInPixels, board ],
    [ emptyPage, board ],
    [ emptyPage, emptyPage, board, board, board ],
  ])
  func aNewScoreboardKeepsTheCentreQuarterWhateverItsPageMeasuresFirst(sizes: [CGSize]) throws {
    let placed = snapshots(try newScoreboard(), sizes)
    #expect(isCentreQuarter(placed))
    #expect(abs(placed.scale - quarterScale) < 1e-9)
    #expect(placed.nativeWidth == 607)
    #expect(placed.nativeHeight == 247)
  }

  @Test func aResizedScoreboardKeepsItsSizeThroughTheNextSnapshots() throws {
    let resized = OverlayLayout.applyResize(
      try newScoreboard(), to: CGRect(x: 0.05, y: 0.8, width: 0.4, height: 0.1), canvas: canvas
    )
    #expect(abs(resized.scale - 0.4 * 1920 / 607) < 1e-9)
    let after = snapshots(resized, [ emptyPage, board, board ])
    #expect(abs(after.width - 0.4) < 1e-9)
    #expect(after.originX == 0.05)
    #expect(after.originY == 0.8)
  }

  @Test func aTopLeftWebOverlayIsParkedAtTheInsetAtItsNativeSize() {
    let placed = snapshots(newWebOverlay(placement: .topLeftNative), [ board ])
    #expect(placed.scale == 1)
    #expect(abs(placed.originX - 20.0 / 1920) < 1e-9)
    #expect(abs(placed.originY - 20.0 / 1080) < 1e-9)
    #expect(abs(placed.width - 607.0 / 1920) < 1e-9)
  }

  @Test func aLaidOutOverlayMeasuredForTheFirstTimeKeepsItsWidth() {
    var saved = newWebOverlay()
    saved.width = 0.5
    saved.hasLaidOut = true
    let placed = snapshots(saved, [ board ])
    #expect(abs(placed.width - 0.5) < 1e-9)
    #expect(abs(placed.scale - 0.5 * 1920 / 607) < 1e-9)
  }

  @Test func aWiderBoardGrowsToTheRightAndKeepsItsHeight() throws {
    // A modestly wider page, the same height: the box grows to the right.
    let wide = CGSize(width: 640, height: board.height)
    let placed = snapshots(try newScoreboard(), [ wide, wide, wide ], gap: 1.5)
    #expect(placed.nativeWidth == 640)
    #expect(placed.nativeHeight == 247)
    #expect(abs(placed.scale - quarterScale) < 1e-9)
    #expect(abs(placed.height * 1080 - quarterHeight) < 0.5)
    #expect(placed.width * 1920 > 480)
  }

  @Test func aLargerPageGrowsTheBoxRightAndDown() throws {
    let bigger = CGSize(width: 800, height: 800 * board.height / board.width)
    let placed = snapshots(try newScoreboard(), [ bigger, bigger, bigger ], gap: 1.5)
    #expect(abs(placed.scale - quarterScale) < 1e-9)
    #expect(placed.nativeWidth == 800)
    #expect(abs(placed.width * 1920 - 800 * quarterScale) < 0.5)
    #expect(abs(placed.height * 1080 - bigger.height * quarterScale) < 0.5)
    #expect(placed.width * 1920 > 480)
    #expect(placed.height * 1080 > quarterHeight)
  }

  @Test func aSmallerPageShrinksTheBoxAtTheScaleItWasPlacedWith() throws {
    let smaller = CGSize(width: 480, height: quarterHeight)
    let placed = snapshots(try newScoreboard(), [ smaller, smaller, smaller ], gap: 1.5)
    #expect(placed.nativeWidth == 480)
    #expect(abs(placed.scale - quarterScale) < 1e-9)
    #expect(abs(placed.width - 480 * quarterScale / 1920) < 1e-9)
    #expect(placed.width < 0.25)
  }
}
