import Foundation

/// Decides which coded pictures may go to the archive after a loss.
///
/// A picture assembled across a packet loss was already kept out of the file. That is not enough:
/// every picture after it until the next keyframe predicts from it, directly or through the ones
/// between, so they arrive intact and still cannot be decoded. A camera flushing its send queue
/// drops whole pictures, and the next one to arrive is exactly such a picture. rec-330's Pixel,
/// behind a congested link, archived them: its segment from 305 s decoded 22 frames and failed with
/// "Cannot Decode", and AVAssetReader stopped the whole export there, 600 s short.
///
/// So after a damaged picture the archive waits for a keyframe. The hole is a gap in delivery,
/// which the archive already holds across.
public struct ArchiveReferenceGate: Sendable, Equatable {
  public private(set) var awaitingKeyframe = false
  /// Intact pictures turned away because what they predict from never reached the file.
  public private(set) var skipped: UInt64 = 0

  public init() {}

  /// Whether this picture may be archived.
  public mutating func admit(isKeyframe: Bool, isCorrupt: Bool) -> Bool {
    if isCorrupt {
      awaitingKeyframe = true
      return false
    }
    if isKeyframe { awaitingKeyframe = false }
    if awaitingKeyframe {
      skipped &+= 1
      return false
    }
    return true
  }

  /// A new session starts on a keyframe of its own; nothing carries over.
  public mutating func reset() {
    awaitingKeyframe = false
  }
}
