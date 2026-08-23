import DirectorCore
import Testing

@Suite("Scrub mapping")
struct ScrubMappingTests {
  @Test("One small-tile width is 60 seconds")
  func oneTileWidthIsSixtySeconds() {
    let offset = ScrubMapping.offsetSeconds(
      translation: -300,
      tileWidth: 300,
      historySeconds: 120,
      playheadOffset: 0
    )
    #expect(offset == -60)
  }

  @Test("Travel past one tile width keeps the same seconds-per-point")
  func extraTravelContinuesAtTheSameRate() {
    let offset = ScrubMapping.offsetSeconds(
      translation: -450,
      tileWidth: 300,
      historySeconds: 120,
      playheadOffset: 0
    )
    #expect(offset == -90)
  }

  @Test("A young recording clamps to available history rather than inventing span")
  func shortHistoryClampsToTape() {
    let offset = ScrubMapping.offsetSeconds(
      translation: -150,
      tileWidth: 300,
      historySeconds: 8,
      playheadOffset: 0
    )
    #expect(offset == -8)
  }

  @Test("From live, a left swipe of half the tile is 30 seconds, clamped to history")
  func fromLiveLeftSwipe() {
    let offset = ScrubMapping.offsetSeconds(
      translation: -150,
      tileWidth: 300,
      historySeconds: 20,
      playheadOffset: 0
    )
    #expect(offset == -20)
  }

  @Test("A second left swipe continues from the playhead, not from live")
  func incrementalRewindFromPlayhead() {
    let first = ScrubMapping.offsetSeconds(
      translation: -90,
      tileWidth: 300,
      historySeconds: 120,
      playheadOffset: 0
    )
    #expect(first == -18)

    let second = ScrubMapping.offsetSeconds(
      translation: -90,
      tileWidth: 300,
      historySeconds: 120,
      playheadOffset: first
    )
    #expect(second == -36)
  }

  @Test("A right swipe from a rewound playhead moves toward live, not to the start")
  func incrementalForwardFromPlayhead() {
    let offset = ScrubMapping.offsetSeconds(
      translation: 30,
      tileWidth: 300,
      historySeconds: 120,
      playheadOffset: -12
    )
    #expect(offset == -6)
  }

  @Test("A right swipe from live stays at live")
  func rightSwipeFromLiveStaysLive() {
    let offset = ScrubMapping.offsetSeconds(
      translation: 120,
      tileWidth: 300,
      historySeconds: 20,
      playheadOffset: 0
    )
    #expect(offset == 0)
  }

  @Test("Left swipe from playhead does not jump to the start of the tape")
  func doesNotJumpToFront() {
    let offset = ScrubMapping.offsetSeconds(
      translation: -60,
      tileWidth: 300,
      historySeconds: 40,
      playheadOffset: -4
    )
    #expect(offset == -16)
    #expect(offset > -40)
  }

  @Test("Offset clamps to available history")
  func clampsToHistory() {
    let start = ScrubMapping.offsetSeconds(
      translation: -300,
      tileWidth: 300,
      historySeconds: 10,
      playheadOffset: -8
    )
    #expect(start == -10)

    let live = ScrubMapping.offsetSeconds(
      translation: 300,
      tileWidth: 300,
      historySeconds: 10,
      playheadOffset: -2
    )
    #expect(live == 0)
  }

  @Test("A deep enough release starts replay instead of snapping to live")
  func liveScrubReplaysWhenDeepEnough() {
    #expect(
      ScrubMapping.shouldReturnToLive(offsetSeconds: -3, historySeconds: 20) == false
    )
    #expect(
      ScrubMapping.shouldReturnToLive(offsetSeconds: 0, historySeconds: 20) == true
    )
    #expect(
      ScrubMapping.shouldReturnToLive(offsetSeconds: -0.2, historySeconds: 20) == true
    )
  }

  @Test("A short tape can still replay; the 0.5s snap does not eat it")
  func shortHistoryStillReplays() {
    #expect(
      ScrubMapping.shouldReturnToLive(offsetSeconds: -0.3, historySeconds: 0.4) == false
    )
    #expect(
      ScrubMapping.shouldReturnToLive(offsetSeconds: 0, historySeconds: 0.4) == true
    )
  }

  @Test("Finger-up uses the lift translation when it is a real drag")
  func endTranslationPrefersLift() {
    #expect(ScrubMapping.endTranslation(lift: -180, farthest: -40) == -180)
  }

  @Test("Finger-up falls back to the farthest drag when lift reports zero")
  func endTranslationFallsBackToFarthest() {
    #expect(ScrubMapping.endTranslation(lift: 0, farthest: -180) == -180)
    #expect(ScrubMapping.endTranslation(lift: 4, farthest: -90) == -90)
  }

  @Test("A tiny playlist does not start replay — that snap-to-live is 'rewind never works'")
  func tinyPlaylistDoesNotStartReplay() {
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 0.4, startOffset: 0) == false)
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 0.9, startOffset: 0) == false)
  }

  @Test("A start already at the playlist's live edge does not start replay")
  func startAtPlaylistEdgeDoesNotStartReplay() {
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 10, startOffset: 9.9) == false)
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 10, startOffset: 9.75) == false)
  }

  @Test("A real playlist with room to play starts replay")
  func realPlaylistStartsReplay() {
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 10, startOffset: 2) == true)
    #expect(ScrubMapping.shouldStartReplay(assemblyDuration: 1, startOffset: 0) == true)
  }

  @Test("Hotkeys finish after content duration, not wall clock")
  func hotkeyFinishesOnContentTime() {
    #expect(ScrubMapping.hasPlayedRequestedDuration(played: 10, requested: 10) == true)
    #expect(ScrubMapping.hasPlayedRequestedDuration(played: 9.97, requested: 10) == false)
    #expect(ScrubMapping.hasPlayedRequestedDuration(played: 9.99, requested: 10) == true)
    #expect(ScrubMapping.hasPlayedRequestedDuration(played: 20, requested: nil) == false)
  }

  @Test("A playlist that ends a couple of seconds behind live should keep replaying")
  func earlyPlaylistEndContinuesReplay() {
    #expect(ScrubMapping.shouldContinueReplay(currentOffsetSeconds: -2) == true)
    #expect(ScrubMapping.shouldContinueReplay(currentOffsetSeconds: -1.2) == true)
    #expect(ScrubMapping.shouldContinueReplay(currentOffsetSeconds: -0.4) == false)
    #expect(ScrubMapping.shouldContinueReplay(currentOffsetSeconds: 0) == false)
  }
}
