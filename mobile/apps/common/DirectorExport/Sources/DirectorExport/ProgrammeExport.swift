import AVFoundation
import Foundation
import DirectorCore

/// Whether a take's programme master goes out exactly as it was recorded, or has to be rebuilt.
///
/// The master is already the operator's encode, so an unbroken one is copied: cut to the window,
/// every sample as written. Anything that makes its timeline doubtful -- a writer that died and left
/// a continuation, a take picked up again after the app stopped, anchors that do not agree on where
/// it starts, a part that does not reach one end of the window, a file
/// that does not read to its end -- sends it through the same fixed-rate re-encode the cameras get,
/// which places every part where it happened and repeats the last picture across every hole.
///
/// Re-encoding is always correct, only slower, so every doubt resolves to it.
public enum ProgrammeExport {
  /// Why a master has to be re-encoded.
  public enum Break: Sendable, Equatable, CustomStringConvertible {
    /// More than one part on disk: a writer died and a continuation was opened.
    case parts(Int)
    /// The take was picked up again after the app stopped, which opens a new part.
    case resumed(Int)
    /// The anchors name a part after the first, so one was written even if its file is gone.
    case continuation(part: Int)
    /// Nothing says where the part sits on the wall clock.
    case unanchored
    /// No more than half the anchors are within `ArchiveIndex.anchorAgreementSeconds` of one another,
    /// so where the part starts is itself in doubt.
    case anchorsDisagree(seconds: Double)
    /// The file's pictures stop before it ends, or it cannot be opened at all.
    case unreadable
    /// The part starts this long after the window does.
    case startsLate(seconds: Double)
    /// The part's pictures end this long before the window does.
    case endsEarly(seconds: Double)

    public var description: String {
      switch self {
      case let .parts(count): "\(count) programme parts"
      case let .resumed(count): "resumed \(count) time\(count == 1 ? "" : "s")"
      case let .continuation(part): "anchors for part \(part)"
      case .unanchored: "no anchors"
      case let .anchorsDisagree(seconds): String(format: "anchors disagree by %.3f s", seconds)
      case .unreadable: "part does not read to its end"
      case let .startsLate(seconds): String(format: "part starts %.3f s late", seconds)
      case let .endsEarly(seconds): String(format: "part ends %.3f s early", seconds)
      }
    }
  }

  public enum Plan: Sendable, Equatable {
    /// Copy the one part as it is, its own timeline starting at `partStart`.
    case copy(partStart: WallClock)
    case reencode(Break)
  }

  /// What reading the one part's pictures found, on its own timeline, in seconds.
  public struct PartReading: Sendable, Equatable {
    /// Where the first picture is presented.
    public var firstPicture: Double
    /// Where the last picture that read back ends.
    public var lastPictureEnd: Double
    /// Where the file says its pictures end.
    public var declaredEnd: Double
    /// Whether the reader got to the end without an error.
    public var completed: Bool

    public init(firstPicture: Double, lastPictureEnd: Double, declaredEnd: Double, completed: Bool) {
      self.firstPicture = firstPicture
      self.lastPictureEnd = lastPictureEnd
      self.declaredEnd = declaredEnd
      self.completed = completed
    }
  }

  /// Copy only when all of these hold, checked in this order so the reason given is the plainest:
  ///
  /// - exactly one part, the take never resumed, and no anchor for a later part;
  /// - anchors exist, and more than half of them agree on where the part starts: within
  ///   `anchorAgreementSeconds` of the earliest tenth, the same test `programPartStarts` uses to pick
  ///   which ones to trust. The master runs on the programme's own frame clock, so its timeline
  ///   cannot move against the wall clock; what the anchors vary by is how late the picture on air
  ///   was captured, tens of milliseconds from one to the next on a good link and far more while a
  ///   camera struggles. A re-encode places the part at the same agreed start, so asking more of a
  ///   copy would only cost a generation;
  /// - the file reads to its end, to within a frame of what it declares;
  /// - its pictures cover the window to within a frame at both ends. `windowEnd` nil is a take that
  ///   never recorded an end, which the part is taken to run to.
  ///
  /// Pure, so every case can be tested without a file.
  public static func plan(
    partCount: Int,
    resumeCount: Int,
    anchors: [ArchiveIndex.ProgramAnchor],
    reading: PartReading?,
    windowStart: WallClock,
    windowEnd: WallClock?,
    frameRate: Int
  ) -> Plan {
    guard partCount == 1 else { return .reencode(.parts(partCount)) }
    guard resumeCount == 0 else { return .reencode(.resumed(resumeCount)) }
    if let later = anchors.map(\.part).filter({ $0 != 1 }).max() {
      return .reencode(.continuation(part: later))
    }
    let implied = anchors.map(\.partStartWall.seconds)
    guard let start = ArchiveIndex.partStart(implied: implied) else { return .reencode(.unanchored) }
    let frame = 1 / Double(max(1, frameRate))
    if start.agreeing * 2 <= implied.count {
      let spread = (implied.max() ?? start.seconds) - (implied.min() ?? start.seconds)
      return .reencode(.anchorsDisagree(seconds: spread))
    }
    guard let reading, reading.completed, reading.declaredEnd - reading.lastPictureEnd <= frame else {
      return .reencode(.unreadable)
    }
    let late = (start.seconds + reading.firstPicture) - windowStart.seconds
    if late > frame { return .reencode(.startsLate(seconds: late)) }
    if let windowEnd {
      let early = windowEnd.seconds - (start.seconds + reading.lastPictureEnd)
      if early > frame { return .reencode(.endsEarly(seconds: early)) }
    }
    return .copy(partStart: WallClock(seconds: start.seconds))
  }

  /// Reads every picture sample of `url` without decoding any, to learn whether the file holds what
  /// it says it does.
  ///
  /// Nil when the file will not open or has no picture. A compressed read of a master is a read of
  /// the file from disk, far quicker than a re-encode, and it is the only way to know the tail is
  /// really there: a header can describe samples the file does not contain.
  public static func read(_ url: URL) async throws -> PartReading? {
    let asset = AVURLAsset(url: url)
    guard let track = try? await asset.loadTracks(withMediaType: .video).first,
          let declared = try? await track.load(.timeRange),
          let reader = try? AVAssetReader(asset: asset)
    else { return nil }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    var first = Double.infinity
    var last = -Double.infinity
    var count = 0
    while let sample = output.copyNextSampleBuffer() {
      if count % 256 == 0, Task.isCancelled {
        reader.cancelReading()
        throw CancellationError()
      }
      count += 1
      guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
      let start = CMSampleBufferGetPresentationTimeStamp(sample)
      guard start.isNumeric else { continue }
      let duration = CMSampleBufferGetDuration(sample)
      first = min(first, start.seconds)
      last = max(last, start.seconds + (duration.isNumeric ? duration.seconds : 0))
    }
    guard first.isFinite, last.isFinite else {
      return PartReading(firstPicture: 0, lastPictureEnd: 0, declaredEnd: declared.end.seconds, completed: false)
    }
    // Samples read without decoding come back on the media's own timeline, which an encoder that
    // reorders frames starts a couple of frames after the track's: measured, 68 ms on a writer-made
    // H.264 file, whose edit list maps it back. Decoded pictures come back on the track's timeline.
    // So what was read is taken as a span from its own first sample, laid from where the track says
    // its pictures start: a tail the file does not hold still shows as a span short of the declared
    // one.
    let span = last - first
    return PartReading(
      firstPicture: declared.start.seconds,
      lastPictureEnd: declared.start.seconds + min(span, declared.duration.seconds),
      declaredEnd: declared.end.seconds,
      completed: reader.status == .completed
    )
  }
}
