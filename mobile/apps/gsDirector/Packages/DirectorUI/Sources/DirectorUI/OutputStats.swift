import DirectorPipeline
import Foundation

/// The numbers the Output tile shows beside its nameplate, kept as a pure function of the
/// snapshot so a test can read them without a view.
///
/// The rule for what earns a place here: nothing the toolbar already shows (stream rate,
/// dropped stream packets, thermal, REC n/m), and nothing that belongs in the debug HUD.
public enum OutputStats {
  public struct Pill: Equatable, Sendable {
    public let id: String
    public let text: String
  }

  public static func pills(_ snapshot: TelemetrySnapshot) -> [Pill] {
    var pills: [Pill] = []
    // How long the take has run. The toolbar says *whether* we are recording, never how long,
    // and that is the most-asked question mid-game. It stops when the operator stops, not when
    // the last writer has finished flushing, which can be twenty seconds later.
    if snapshot.isActivelyRecording {
      pills.append(Pill(id: "output-rec", text: "REC " + clock(snapshot.recordingSeconds)))
    }
    // The rate the programme picture is actually being produced at. Every source tile can read
    // sixty while this reads zero, and that is the black screen nobody could otherwise see.
    pills.append(Pill(
      id: "output-fps",
      text: String(format: "%.0f fps", snapshot.composedFramesPerSecond)
    ))
    if let program = snapshot.programTile {
      // The on-air camera's own loss pill, repeated here so the operator watching Output sees
      // it without looking across at the source.
      pills.append(Pill(id: "output-loss", text: "loss " + program.lossPerSecondLabel))
      // How old the on-air camera's newest picture was **when it arrived**. It is measured at
      // the receive thread, so it covers capture and the network and stops there: the delay
      // line's hold, the compositor and the display queue all come after it and are not in this
      // number. Presenting it as Output's own capture-to-screen delay would need a capture time
      // carried through the compositor, which nothing does yet — so it is labelled for what it
      // measures rather than for the question it looks like it answers.
      pills.append(Pill(
        id: "output-age",
        text: String(format: "age %.0f ms", program.frameAgeMilliseconds)
      ))
    }
    return pills
  }

  /// The same numbers as text, for `ProgramTileView`'s accessibility value. `loss=` is the raw
  /// rate rather than the pill's dash, because automation reads arrival separately via `out=`.
  public static func accessibilityValue(_ snapshot: TelemetrySnapshot) -> String {
    let program = snapshot.programTile
    return String(
      format: "fps=%.0f loss=%.0f age=%.0f rec=%d",
      snapshot.composedFramesPerSecond,
      program?.packetsLostPerSecond ?? 0,
      program?.frameAgeMilliseconds ?? 0,
      snapshot.isActivelyRecording ? snapshot.recordingSeconds : 0
    )
  }

  static func clock(_ seconds: Int) -> String {
    String(format: "%02d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60)
  }
}
