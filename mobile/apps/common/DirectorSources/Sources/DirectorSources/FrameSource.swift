import CoreMedia
import CoreVideo
import Foundation
import DirectorCore

/// A decoded frame as a source hands it to us: uncompressed pixels plus enough
/// identity to prove, later, that exactly this frame reached the archive.
///
/// `@unchecked Sendable` is deliberate (I6). `CVPixelBuffer` is a CoreFoundation type with no
/// Sendable annotation, but a frame is treated as immutable the instant it is published: the
/// director never writes to the buffer again, and every consumer only reads. Ownership moves
/// across the dedicated frame queues by convention, not by actor isolation, so there is no
/// per-frame hop.
public struct PixelFrame: @unchecked Sendable {
  public let sourceID: SourceID
  public let pixelBuffer: CVPixelBuffer
  /// Presentation time on the source's own timeline; monotonic within a source.
  public let presentationTime: CMTime
  /// When the frame was received, used to place it on the DVR wall-clock timeline.
  public let wallClock: WallClock
  /// When the camera took the picture, on the Director's clock. Nil while a source has no clock
  /// anchor yet. Carried here as well as on the coded frame because how old a picture is decides
  /// whether it is still worth showing, and that question is asked of the decoded one.
  public let captureWallClock: WallClock?
  /// Monotonic per-source counter starting at 0. The unit of R4's "every frame appears once".
  public let frameID: UInt64
  /// Frame number burned into the picture by the fixture generator or the synthetic renderer,
  /// recoverable by decoding the archive back. `nil` for real cameras.
  public let markerValue: Int?

  public init(
    sourceID: SourceID,
    pixelBuffer: CVPixelBuffer,
    presentationTime: CMTime,
    wallClock: WallClock,
    captureWallClock: WallClock? = nil,
    frameID: UInt64,
    markerValue: Int? = nil
  ) {
    self.sourceID = sourceID
    self.pixelBuffer = pixelBuffer
    self.presentationTime = presentationTime
    self.wallClock = wallClock
    self.captureWallClock = captureWallClock
    self.frameID = frameID
    self.markerValue = markerValue
  }

  public var width: Int { CVPixelBufferGetWidth(pixelBuffer) }
  public var height: Int { CVPixelBufferGetHeight(pixelBuffer) }
  public var pixelFormat: OSType { CVPixelBufferGetPixelFormatType(pixelBuffer) }
}

/// Audio delivered alongside video. Goes into the same `AVAssetWriter` as the video (D1), so
/// A/V sync is the writer's problem rather than a hand-rolled muxer's.
public struct AudioFrame: @unchecked Sendable {
  public let sourceID: SourceID
  public let sampleBuffer: CMSampleBuffer
  public let wallClock: WallClock

  public init(sourceID: SourceID, sampleBuffer: CMSampleBuffer, wallClock: WallClock) {
    self.sourceID = sourceID
    self.sampleBuffer = sampleBuffer
    self.wallClock = wallClock
  }
}

/// One coded picture exactly as the camera sent it, length-prefixed and undecoded.
///
/// This is what the archive writes. Re-encoding a camera's stream to put it on disk would spend an
/// encoder and a thermal budget on a second generation of loss, so the archive is a copy: these
/// bytes reach the file unaltered, and the resolution, frame rate and codec on disk are whatever
/// the camera chose.
public struct CompressedFrame: @unchecked Sendable {
  public enum Codec: String, Sendable {
    case h264
    case hevc
    case av1
  }

  public let sourceID: SourceID
  public let codec: Codec
  public let data: Data
  public let parameterSets: [Data]
  public let isKeyframe: Bool
  public let presentationTime: CMTime
  public let decodeTime: CMTime
  public let wallClock: WallClock
  /// When this picture was taken, on the Director's clock — as distinct from `wallClock`, which is
  /// when it arrived. Nil until the camera's sender reports have established an anchor.
  ///
  /// A segment's start is recorded from this. Taking it from arrival instead is why two cameras
  /// rewound to the same moment land in different places: each segment's start carries that
  /// camera's delivery delay and its own keyframe phase, so segment N spans a different piece of
  /// wall clock on every camera.
  public let captureWallClock: WallClock?
  public let frameID: UInt64

  public init(
    sourceID: SourceID,
    codec: Codec,
    data: Data,
    parameterSets: [Data],
    isKeyframe: Bool,
    presentationTime: CMTime,
    decodeTime: CMTime,
    wallClock: WallClock,
    captureWallClock: WallClock? = nil,
    frameID: UInt64
  ) {
    self.sourceID = sourceID
    self.codec = codec
    self.data = data
    self.parameterSets = parameterSets
    self.isKeyframe = isKeyframe
    self.presentationTime = presentationTime
    self.decodeTime = decodeTime
    self.wallClock = wallClock
    self.captureWallClock = captureWallClock
    self.frameID = frameID
  }
}

/// One AAC access unit as the camera sent it, with the configuration a muxer needs to describe the
/// track it belongs to. Archived as-is for the same reason as the video.
public struct CompressedAudioFrame: @unchecked Sendable {
  /// An AAC-LC access unit is always this many samples, which makes it both the timestamp step and
  /// the sample duration.
  public static let framesPerPacket: Int64 = 1024

  public let sourceID: SourceID
  public let data: Data
  /// The AudioSpecificConfig from the SDP. A muxer cannot describe an AAC track without it.
  public let magicCookie: Data
  public let sampleRate: Double
  public let channelCount: Int
  /// On the source's own audio clock, which need not share a timebase with its video.
  public let presentationTime: CMTime
  public let wallClock: WallClock

  public init(
    sourceID: SourceID,
    data: Data,
    magicCookie: Data,
    sampleRate: Double,
    channelCount: Int,
    presentationTime: CMTime,
    wallClock: WallClock
  ) {
    self.sourceID = sourceID
    self.data = data
    self.magicCookie = magicCookie
    self.sampleRate = sampleRate
    self.channelCount = channelCount
    self.presentationTime = presentationTime
    self.wallClock = wallClock
  }

  public var duration: CMTime {
    CMTime(value: CMTimeValue(Self.framesPerPacket), timescale: CMTimeScale(sampleRate))
  }
}

public typealias PixelFrameHandler = @Sendable (PixelFrame) -> Void
public typealias AudioFrameHandler = @Sendable (AudioFrame) -> Void
public typealias CompressedFrameHandler = @Sendable (CompressedFrame) -> Void
public typealias CompressedAudioFrameHandler = @Sendable (CompressedAudioFrame) -> Void

/// What a source delivers, and to whom. Passing handlers into `start` rather than exposing
/// mutable delegate properties keeps the type `Sendable` without a lock.
///
/// A network source publishes each picture twice: decoded for the screen and the program mix, and
/// coded for the archive. They are separate sinks because they want different timing — the screen
/// wants frames paced by the delay line, the archive wants them the moment they arrive.
public struct FrameSinks: Sendable {
  public var pixel: PixelFrameHandler?
  public var audio: AudioFrameHandler?
  public var compressed: CompressedFrameHandler?
  public var compressedAudio: CompressedAudioFrameHandler?

  public init(
    pixel: PixelFrameHandler? = nil,
    audio: AudioFrameHandler? = nil,
    compressed: CompressedFrameHandler? = nil,
    compressedAudio: CompressedAudioFrameHandler? = nil
  ) {
    self.pixel = pixel
    self.audio = audio
    self.compressed = compressed
    self.compressedAudio = compressedAudio
  }
}

public struct SourceFormat: Hashable, Sendable {
  public var width: Int
  public var height: Int
  public var frameRate: Double
  public var pixelFormat: OSType
  /// How the wire carries the picture — "H.264", "HEVC" — for the operator's camera list. A plain
  /// label rather than the transport's own codec type, because a generated or file-backed source has
  /// no wire codec and this type sits below the one that defines them.
  public var codecName: String

  public init(
    width: Int,
    height: Int,
    frameRate: Double,
    pixelFormat: OSType,
    codecName: String = ""
  ) {
    self.width = width
    self.height = height
    self.frameRate = frameRate
    self.pixelFormat = pixelFormat
    self.codecName = codecName
  }

  /// `kCVPixelFormatType_422YpCbCr8` reads as "2vuy" in a HUD line or a JSON dump.
  public static func fourCharacterCode(_ value: OSType) -> String {
    let bytes = [ 24, 16, 8, 0 ].map { UInt8((value >> $0) & 0xFF) }
    guard bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7F }) else { return String(value) }
    return String(decoding: bytes, as: UTF8.self)
  }
}

public enum FrameSourceError: Error, CustomStringConvertible {
  case unavailable(String)
  case failedToStart(String)

  public var description: String {
    switch self {
    case let .unavailable(reason): "source unavailable: \(reason)"
    case let .failedToStart(reason): "source failed to start: \(reason)"
    }
  }
}

/// What the receive loop itself saw, before any of our processing.
///
/// Needed because a frame that never reaches the router is invisible to every other counter: it is
/// not "received" and it is not "dropped", it simply never existed. That makes an arrival shortfall
/// and a self-inflicted loss look identical downstream, which is exactly the question that decides
/// whether the network or the app is at fault.
public struct ReceiveStats: Sendable, Equatable {
  /// Video frames handed back by the SDK, counted before anything is done with them.
  public var captured: UInt64 = 0
  /// Frames discarded because no destination buffer was available.
  public var poolMisses: UInt64 = 0
  /// Frames discarded because the SDK sent a pixel layout we do not handle.
  public var formatMisses: UInt64 = 0
  /// Seconds spent blocked inside the SDK's capture call, waiting for the network.
  public var waitingSeconds: Double = 0
  /// Seconds spent downstream of capture, on the receive thread, which is time the loop cannot
  /// spend collecting the next frame.
  public var deliverySeconds: Double = 0
  /// That delivery time split in two, in milliseconds, because they have different owners and
  /// different fixes: `copy` is the source's own move of the frame into a pixel buffer, `publish`
  /// is everything the pipeline then does with it on the same thread — convert, playout, tile,
  /// compositor. A source that looks slow is almost always one of these two and never both, and
  /// without the split the answer is a guess.
  public var copyMilliseconds: Double = 0
  public var publishMilliseconds: Double = 0
  /// Frames a source encoded for its own archive, and frames it refused to encode because the
  /// encoder was already too far behind.
  ///
  /// Only sources that make their own coded form report these. A climbing `archiveDropped` is the
  /// archive degrading on purpose so the picture does not: the alternative is an encode that backs
  /// up onto the receive thread and takes the live tile down with it.
  public var archiveEncoded: UInt64 = 0
  /// Sync samples among those encodes. `SegmentWriter` opens every file on one, so an archive
  /// whose encodes climb while these do not is an archive that has silently stopped growing.
  public var archiveKeyframes: UInt64 = 0
  /// Encode submissions VideoToolbox refused, and how many times its session had to be rebuilt
  /// because it had stopped accepting work altogether.
  public var archiveEncodeRefused: UInt64 = 0
  public var archiveEncoderRebuilds: UInt64 = 0
  /// The `OSStatus` of the most recent refusal, so the failure can be named rather than guessed at.
  public var archiveEncodeStatus: Int = 0
  public var archiveDropped: UInt64 = 0
  /// How many frames are waiting to be encoded right now.
  public var archiveBacklog: Int = 0
  /// One frame in this many reaches the archive. Above 1, the source is deliberately recording at
  /// a fraction of its live rate because the encoder could not sustain the full one — a continuous
  /// half-rate angle rather than a full-rate one full of holes.
  public var archiveStride: Int = 1
  /// The widest gap between two arriving frames during the last complete second, in milliseconds,
  /// and whether that gap ended on a keyframe.
  ///
  /// Averages hide a stutter: a tile that misses one frame a second still reports 29 fps and a
  /// two-millisecond mean. These say how late the worst frame was, and `arrivalGapWasKeyframe`
  /// says whether the camera's own I-frames are what arrived late.
  public var arrivalGapMaxMilliseconds: Double = 0
  public var arrivalGapWasKeyframe = false
  /// The longest a single frame spent being decoded and delivered on the receive thread during that
  /// second. Time here is time not spent reading the socket, so it becomes the next frame's gap —
  /// which is how our own per-second work (proxy stills, keyframe encodes) turns into visible jitter.
  public var deliverMaxMilliseconds: Double = 0
  /// The same widest gap, measured where frames leave the delay line instead of where they arrive.
  /// This is the one the screen sees.
  public var releaseGapMaxMilliseconds: Double = 0
  /// How much video a player would have to be holding to present every frame of the last ten seconds
  /// on time: the spread between the least and most late arrival, measured against the frames' own
  /// timestamps. Directly the size of the smoothing buffer this camera demands.
  public var pacingSpreadMilliseconds: Double = 0
  /// How much video the delay line is actually holding, which is what the operator pays for in
  /// monitor latency.
  public var playoutMilliseconds: Double = 0
  /// Frames that arrived after the moment they were due — the buffer was too small and the picture
  /// stalled. Each one widens the buffer immediately.
  public var playoutLateFrames: UInt64 = 0
  /// Pictures waiting in the delay line right now.
  public var playoutDepth: Int = 0
  /// Packets the network lost, counted from gaps in the transport's own numbering.
  ///
  /// This is the one number that separates "the network dropped it" from "the iPad could not keep
  /// up", which is the first question to ask when a tile looks slow. Always zero for
  /// sources that generate their frames locally.
  public var packetsLost: UInt64 = 0
  /// What this camera's own RTCP sender reports say about its clock (RFC 3550 §6.4). The playout
  /// path does not use any of this yet; it is here to decide whether it could.
  ///
  /// `senderReports` at zero after a minute of video means the camera sends none, so an absolute
  /// timeline is not available from it. `mediaTicksPerSecond` away from the nominal rate — 90000 for
  /// video — is drift the delay line currently reads as lateness and chases forever.
  /// `cameraClockOffsetSeconds` is the sender's wall clock minus ours; comparing it between cameras
  /// says whether they agree well enough to be aligned on one timeline.
  public var senderReports: UInt64 = 0
  public var senderReportIntervalSeconds: Double = 0
  public var senderReportAgeSeconds: Double = 0
  public var senderReportStreams: Int = 0
  public var mediaTicksPerSecond: Double = 0
  public var mediaClockSpanSeconds: Double = 0
  public var cameraClockOffsetSeconds: Double = 0
  /// The offset after minimum-delay filtering, and how many observations it rests on. The raw value
  /// above follows transit delay; this one does not, which is what makes injected lateness visible
  /// instead of silently absorbed.
  public var cameraClockOffsetFilteredSeconds: Double = 0
  public var cameraClockOffsetSamples: Int = 0
  /// The latest frame's capture time on the Director's clock, and how far behind now that is.
  ///
  /// The age is **excess over this camera's own best case**, not absolute end-to-end delay: the
  /// offset it is corrected by comes from minimum-delay filtering, which removes the constant part
  /// of transit along with the clock difference. The spread of these ages across cameras is
  /// therefore the misalignment the design is judged on — but **this number cannot size `D_global`**,
  /// which needs the absolute delay these filtered values deliberately discard.
  public var correctedCaptureTime: Double = 0
  public var correctedCaptureAgeMilliseconds: Double = 0
  /// Decoders this source currently holds. Only network sources decode anything; a generated or
  /// file-backed source reports zero.
  public var decodeSessions = 0
  /// Decoded frames discarded because their timestamp did not advance. A handful means the camera
  /// reordered; a count that climbs at the frame rate means the source timeline has stopped moving
  /// and the tile is frozen, which is otherwise indistinguishable from a camera holding still.
  public var outOfOrderFrames: UInt64 = 0
  /// Times the sender's clock has been seen to restart, which in practice is the camera rebooting.
  public var senderClockRestarts: UInt64 = 0
  /// How long this source has been silent past the stall timeout, or zero while it is delivering.
  /// The one counter on a tile that can describe frames that did *not* arrive.
  public var stalledForSeconds: Double = 0
  /// Why delivery last stopped, in the words of whatever noticed — a socket error, or a session that
  /// went quiet without one. Empty while healthy, and the difference between a tile that is black for
  /// a knowable reason and one that is simply black.
  public var status: String?

  public init() {}
}

/// The single boundary between "we have pixels" and "where the pixels came from".
/// Everything above this — DVR, index, proxy, scrub, replay, compositor, program encode,
/// export — is written against this protocol and never learns which transport delivered a frame.
/// A live camera that announces itself in SDP or RTCP. Optional: synthetic sources do not.
public protocol StreamIdentityReporting: AnyObject {
  var onStreamAdvertisement: (@Sendable (StreamAdvertisement) -> Void)? { get set }
}

public protocol FrameSource: AnyObject, Sendable {
  var sourceID: SourceID { get }
  var displayName: String { get }
  var isRunning: Bool { get }
  /// Known only once frames start arriving for network sources.
  var format: SourceFormat? { get }
  /// Established upstream connections. Only network sources can be running with none, which is
  /// the difference between "discovered but unreachable" and "connected but silent".
  var connections: Int { get }
  /// Only network sources report anything interesting here.
  var receiveStats: ReceiveStats { get }

  func start(sinks: FrameSinks) throws
  func stop()

  /// Whether anything downstream currently wants the coded form of this source's frames.
  ///
  /// The router wires all four sinks for every source and leaves them wired, which is right for a
  /// camera whose coded frames arrive whether we want them or not — an RTSP camera's `compressed`
  /// sink costs nothing, because those bytes came off the socket already.
  ///
  /// It is not right for a source that has to *make* the coded form. The free NDI SDK hands over
  /// decoded pixels, so an NDI camera's archive is a re-encode, and treating a wired sink as a
  /// request to encode means four idle preview tiles hold four 1080p encode sessions for output
  /// nobody reads. Encode sessions, not CPU, are what this app runs out of.
  ///
  /// Default is a no-op, so only sources that encode need to care.
  func setArchiving(_ isArchiving: Bool)
}

public extension FrameSource {
  var connections: Int { isRunning ? 1 : 0 }
  var receiveStats: ReceiveStats { ReceiveStats() }
  func setArchiving(_ isArchiving: Bool) {}

  func start(onPixelFrame: @escaping PixelFrameHandler) throws {
    try start(sinks: FrameSinks(pixel: onPixelFrame))
  }
}
