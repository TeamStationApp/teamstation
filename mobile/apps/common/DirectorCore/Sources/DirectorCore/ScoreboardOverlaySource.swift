import CoreGraphics
import Foundation

/// Which page a Scoreboard content item shows.
///
/// The sample whenever the content editor is open and nothing is recording or
/// streaming, whether or not an event is chosen, so the operator always has a
/// board to place and size — even for an event whose scoreboard has closed.
/// Otherwise the chosen event's live board, and with no event, nothing.
public enum ScoreboardOverlaySource {
  /// Board size B: the CSS px box every scoreboard page measures, whatever it
  /// draws (`SCOREBOARD_BOARD_SIZE` in `src2/common/scoreboard.ts`). It is
  /// the size 1.0's scoreboard drew the sample at in a 1920 × 1080 window.
  public static let boardSize = CGSize(width: 607, height: 247)

  public static func url(
    live: URL?,
    sample: URL,
    editorOpen: Bool,
    capturing: Bool
  ) -> URL? {
    if editorOpen && !capturing { return sample }
    return live
  }
}

/// Which overlays are drawn on the programme.
public enum OverlayComposition {
  /// Every overlay, less a scoreboard whose page resolved to nothing: with no
  /// event chosen there is no board, and nothing may stand in for one.
  public static func drawable(
    _ overlays: [ProgramOverlay],
    scoreboardURL: URL?
  ) -> [ProgramOverlay] {
    guard scoreboardURL == nil else { return overlays }
    return overlays.filter { $0.kind != .scoreboard }
  }
}
