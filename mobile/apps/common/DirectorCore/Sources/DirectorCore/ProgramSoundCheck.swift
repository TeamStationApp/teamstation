import Foundation

/// What a finished programme part's sound track turned out to hold, kept with the take.
///
/// The Director has always noticed this at Stop — `ProgramEncoder.finish` reads the file back and
/// reports when the sound falls short of the picture. It reported it to `PipelineTelemetry`, which
/// is memory: the next take overwrote it and a relaunch lost it. So a master whose sound ran 46.8 s
/// short of its picture raised its alarm on two consecutive weekends with nobody left to read it,
/// and the fault was eventually found by ear, after both games had been uploaded.
///
/// Kept per part rather than per take, because a writer that died mid-take leaves a continuation
/// and each part's sound is finished separately.
public struct ProgramSoundCheck: Sendable, Equatable, Codable {
  /// Which output file, 1-based, matching `ProgramAnchor.part`.
  public var part: Int
  /// Where the file's picture ends, read back from the file rather than from the track header.
  public var pictureSeconds: Double
  /// Where the file's sound ends, read back the same way.
  public var soundSeconds: Double
  /// How many sound samples the file holds. -1 when the track could not be read at all.
  public var samples: Int
  /// The encoder's own diagnostic line, kept verbatim: the numbers behind the verdict, which are
  /// what distinguish a queue that overflowed from a writer that refused from a hold that filled
  /// nothing.
  public var detail: String

  /// How far the sound falls short of the picture. Zero when it does not.
  public var shortfall: Double {
    guard pictureSeconds > 0, soundSeconds > 0 else { return 0 }
    return max(0, pictureSeconds - soundSeconds)
  }

  /// Beyond this a viewer hears it. The same threshold `ProgramEncoder.finish` raises its error at.
  public static let tolerance: Double = 0.25

  /// Whether this part is damaged. Sound shorter than picture is the one fault nothing downstream
  /// can repair, so it is worth saying plainly rather than leaving to be inferred from two numbers.
  public var isShort: Bool {
    pictureSeconds > 0 && soundSeconds > 0 && shortfall > Self.tolerance
  }

  public init(
    part: Int,
    pictureSeconds: Double,
    soundSeconds: Double,
    samples: Int,
    detail: String
  ) {
    self.part = part
    self.pictureSeconds = pictureSeconds
    self.soundSeconds = soundSeconds
    self.samples = samples
    self.detail = detail
  }
}
