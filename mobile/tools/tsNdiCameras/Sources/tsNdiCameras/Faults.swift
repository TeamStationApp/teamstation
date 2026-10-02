import Foundation

/// What a camera is currently doing wrong, on purpose.
///
/// Every field here exists because it produces a failure the app has to survive and that no
/// amount of correct sending would ever reach. They divide into three groups:
///
/// - **Loss and timing** (`dropRate`, `burstRemaining`, `stallUntil`, `jitterMilliseconds`) — what
///   an unreliable network looks like from above NDI's own retransmission. Network-level
///   impairment is a separate tool (`ndiImpair.sh`); these are the deterministic version, and
///   between them they cover both sides of the SDK's error correction.
/// - **Format changes** (`width`, `height`, `frameRate`) — legal, and the thing most likely to
///   break an archive, because no single fMP4 track can hold a resolution change.
/// - **Malformed frames** (`fourCC`, `shortStride`, `zeroFrameRateDenominator`,
///   `backwardsTimestamps`, `malformedMetadata`) — a sender that is wrong rather than unlucky.
///   These are what `NDIFrameValidator` exists for.
struct CameraFaults: Sendable {
  var dropRate: Double = 0
  var burstRemaining: Int = 0
  var stallUntil: Date?
  var jitterMilliseconds: Double = 0
  /// How far behind its own capture this camera's delivery has fallen, in milliseconds.
  ///
  /// Distinct from `jitterMilliseconds`, which delays the send and stamps the frame when it goes:
  /// the receiver sees the timestamp move with it and reads no lateness at all. This stamps the
  /// frame where it was taken and delivers it late, which is the only shape that makes a picture
  /// genuinely stale — and the shape the display cap exists to catch.
  ///
  /// Reached gradually rather than in one step, because a step is not lateness. Subtracting the
  /// whole amount from one frame's timestamp makes that timestamp go *backwards*, and a receiver
  /// worth its salt reads a permanent backwards shift as the sender's clock having restarted and
  /// re-anchors to it — measured here absorbing a 1.5 s step in half a second, correctly. A camera
  /// that falls behind does so frame by frame, and that is what this reproduces.
  var lateMilliseconds: Double = 0
  /// Milliseconds of lateness added per frame while ramping. Kept well under a frame interval so
  /// the timestamps stay monotonic all the way up.
  static let lateRampPerFrame: Double = 5

  var width: Int?
  var height: Int?
  var frameRate: Double?

  /// A FourCC the receiver does not handle, sent verbatim in the header while the buffer stays
  /// what it always was. The receiver has to refuse it on the header alone — reading the buffer to
  /// find out would be the bug.
  var fourCC: String?
  var shortStride = false
  var zeroFrameRateDenominator = false
  var backwardsTimestamps = false
  var malformedMetadata = false

  var audioEnabled = true
  var audioChannels = 1
  var audioSampleRate: Double = 48_000

  /// Sender destroyed and not yet recreated. Distinct from a stall: the source leaves discovery
  /// entirely, which is the reconnect path rather than the silence path.
  var killed = false
  var renameTo: String?

  var isStalled: Bool {
    guard let stallUntil else { return false }
    return Date() < stallUntil
  }

  /// Whether this frame should be thrown away before it is sent.
  ///
  /// Burst comes first: a burst is a real dropout and has to be contiguous, where `dropRate` is
  /// thinning and has to be scattered. Applying them in the other order would let a random drop
  /// consume a burst frame and make a 30-frame burst come out as 29.
  mutating func shouldDropFrame(random: inout SystemRandomNumberGenerator) -> Bool {
    if burstRemaining > 0 {
      burstRemaining -= 1
      return true
    }
    guard dropRate > 0 else { return false }
    return Double.random(in: 0 ..< 1, using: &random) < dropRate
  }

  mutating func apply(_ query: [String: String]) -> [String] {
    var applied: [String] = []

    if let value = query["drop"], let rate = Double(value) {
      dropRate = max(0, min(1, rate))
      applied.append("drop=\(dropRate)")
    }
    if let value = query["burst"], let count = Int(value) {
      burstRemaining = max(0, count)
      applied.append("burst=\(burstRemaining)")
    }
    if let value = query["stall"], let seconds = Double(value) {
      stallUntil = seconds > 0 ? Date().addingTimeInterval(seconds) : nil
      applied.append("stall=\(seconds)")
    }
    if let value = query["late"], let milliseconds = Double(value) {
      lateMilliseconds = max(0, milliseconds)
      applied.append("late=\(lateMilliseconds)")
    }
    if let value = query["jitter"], let milliseconds = Double(value) {
      jitterMilliseconds = max(0, milliseconds)
      applied.append("jitter=\(jitterMilliseconds)")
    }
    if let value = query["fps"], let rate = Double(value), rate > 0 {
      frameRate = rate
      applied.append("fps=\(rate)")
    }
    if let value = query["size"] {
      let parts = value.lowercased().split(separator: "x")
      if parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]), w > 0, h > 0 {
        width = w
        height = h
        applied.append("size=\(w)x\(h)")
      }
    }
    if let value = query["fourcc"] {
      fourCC = value.isEmpty || value == "off" ? nil : value
      applied.append("fourcc=\(fourCC ?? "off")")
    }
    if let value = query["badstride"] {
      shortStride = value == "1" || value == "true"
      applied.append("badstride=\(shortStride)")
    }
    if let value = query["badrate"] {
      zeroFrameRateDenominator = value == "1" || value == "true"
      applied.append("badrate=\(zeroFrameRateDenominator)")
    }
    if let value = query["timecode"] {
      backwardsTimestamps = value == "back"
      applied.append("timecode=\(value)")
    }
    if let value = query["metadata"] {
      malformedMetadata = value == "malformed"
      applied.append("metadata=\(value)")
    }
    if let value = query["audio"] {
      audioEnabled = !(value == "off" || value == "0" || value == "false")
      applied.append("audio=\(audioEnabled ? "on" : "off")")
    }
    if let value = query["channels"], let count = Int(value), count > 0 {
      audioChannels = count
      applied.append("channels=\(count)")
    }
    if let value = query["samplerate"], let rate = Double(value), rate > 0 {
      audioSampleRate = rate
      applied.append("samplerate=\(rate)")
    }
    if let value = query["kill"], value == "1" || value == "true" {
      killed = true
      applied.append("kill=1")
    }
    if let value = query["revive"], value == "1" || value == "true" {
      killed = false
      applied.append("revive=1")
    }
    if let value = query["rename"], !value.isEmpty {
      renameTo = value
      applied.append("rename=\(value)")
    }
    if query["reset"] == "1" {
      self = CameraFaults()
      applied.append("reset=1")
    }
    return applied
  }

  var summary: String {
    var parts: [String] = []
    if dropRate > 0 { parts.append("drop=\(dropRate)") }
    if burstRemaining > 0 { parts.append("burst=\(burstRemaining)") }
    if isStalled { parts.append("stalled") }
    if jitterMilliseconds > 0 { parts.append("jitter=\(jitterMilliseconds)") }
    if lateMilliseconds > 0 { parts.append("late=\(lateMilliseconds)") }
    if let width, let height { parts.append("size=\(width)x\(height)") }
    if let frameRate { parts.append("fps=\(frameRate)") }
    if let fourCC { parts.append("fourcc=\(fourCC)") }
    if shortStride { parts.append("badstride") }
    if zeroFrameRateDenominator { parts.append("badrate") }
    if backwardsTimestamps { parts.append("timecode=back") }
    if malformedMetadata { parts.append("metadata=malformed") }
    if !audioEnabled { parts.append("audio=off") }
    if audioChannels != 1 { parts.append("channels=\(audioChannels)") }
    if audioSampleRate != 48_000 { parts.append("samplerate=\(audioSampleRate)") }
    if killed { parts.append("killed") }
    return parts.isEmpty ? "clean" : parts.joined(separator: " ")
  }
}
