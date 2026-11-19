/// Which clips say a reading. Only 20 to 99 has a voice; a side outside that range is left out,
/// and a reading with nothing left to say is silent.
///
/// A pitch alone is its falling take ("56"); an exit is its take before "exit" and the word itself
/// ("53 exit"); both together join with "and" ("56 and 52 exit").
public enum Phrase {
  public static let speakable = 20...99

  public static func clips(pitch: Int?, exit: Int?) -> [String] {
    let pitch = pitch.flatMap { speakable.contains($0) ? $0 : nil }
    let exit = exit.flatMap { speakable.contains($0) ? $0 : nil }
    switch (pitch, exit) {
    case let (pitch?, exit?):
      return [ "n\(pitch)-and", "word-and", "n\(exit)-exit", "word-exit" ]
    case let (pitch?, nil):
      return [ "n\(pitch)-final" ]
    case let (nil, exit?):
      return [ "n\(exit)-exit", "word-exit" ]
    case (nil, nil):
      return []
    }
  }

  /// The clips as the words a listener hears: "56 and 52 exit".
  public static func words(_ clips: [String]) -> String {
    clips.map { clip -> String in
      if clip.hasPrefix("word-") { return String(clip.dropFirst(5)) }
      let number = clip.dropFirst().prefix { $0.isNumber }
      return String(number)
    }
    .joined(separator: " ")
  }
}
