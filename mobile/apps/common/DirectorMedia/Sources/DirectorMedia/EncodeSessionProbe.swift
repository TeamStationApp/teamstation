import Foundation
import VideoToolbox

/// Measures how many concurrent hardware encode sessions this device will actually give us.
///
/// R2 is the top risk in the plan and it is undocumented.
/// `kVTCompressionPropertyKey_RecommendedParallelizationLimit` does not answer it: that
/// property describes splitting **one** movie across sessions for offline transcode, not a
/// realtime concurrent-session ceiling. The only honest answer is to create sessions until one
/// refuses, which is what this does.
public enum EncodeSessionProbe {
  public struct Result: Sendable, Codable, Equatable {
    public var requested: Int
    public var created: Int
    public var firstFailureCode: Int32?
    public var codec: String
    public var width: Int
    public var height: Int
    public var elapsedSeconds: Double
    /// Sessions that accepted a frame. Creating a session is cheap and succeeds long after the
    /// device has stopped being willing to actually encode, so this is the number that matters.
    public var encoded: Int = 0
    public var encodeFailureCode: Int32?
    /// Compressed frames the encoder actually emitted. `VTCompressionSessionEncodeFrame` returning
    /// `noErr` only means the frame was queued, so this is the one that proves encoding works.
    public var emitted: Int = 0
    public var framesPerSession: Int = 1

    public var summary: String {
      var text = "\(created)/\(requested) \(codec) \(height)p sessions created"
      if created != requested {
        text += " — creation failed with \(firstFailureCode.map(String.init) ?? "unknown")"
      }
      text += ", \(encoded)/\(created * framesPerSession) frames accepted, \(emitted) emitted"
      if let encodeFailureCode {
        text += " — encode failed with \(encodeFailureCode)"
      }
      return text
    }
  }

  /// `kVTVideoEncoderNotAvailableNowErr`, the code the hardware returns when it will not open
  /// another session. Named here because it is the failure this probe exists to find.
  public static let encoderNotAvailableNow: Int32 = -12_900

  public static func probe(
    upTo maximum: Int,
    width: Int = 1920,
    height: Int = 1080,
    codec: CMVideoCodecType = kCMVideoCodecType_H264,
    framesPerSession: Int = 1,
    frameRate: Int = 30
  ) -> Result {
    let started = CFAbsoluteTimeGetCurrent()
    var sessions: [VTCompressionSession] = []
    var firstFailure: Int32?

    for _ in 0 ..< maximum {
      var session: VTCompressionSession?
      let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width),
        height: Int32(height),
        codecType: codec,
        encoderSpecification: [
          kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: kCFBooleanTrue,
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue
        ] as CFDictionary,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: nil,
        refcon: nil,
        compressionSessionOut: &session
      )
      guard status == noErr, let session else {
        firstFailure = status
        break
      }
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_ExpectedFrameRate,
        value: NSNumber(value: frameRate)
      )
      // Creation alone can succeed lazily; preparing forces the encoder to actually claim
      // hardware resources, which is where the ceiling shows up.
      let prepared = VTCompressionSessionPrepareToEncodeFrames(session)
      if prepared != noErr {
        firstFailure = prepared
        VTCompressionSessionInvalidate(session)
        break
      }
      sessions.append(session)
    }

    let created = sessions.count

    var encoded = 0
    var encodeFailure: Int32?
    let counter = EmittedCounter()
    if let frame = blankFrame(width: width, height: height) {
      for session in sessions {
        for index in 0 ..< framesPerSession {
          let status = VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: frame,
            presentationTimeStamp: CMTime(
              value: CMTimeValue(index),
              timescale: CMTimeScale(max(frameRate, 1))
            ),
            duration: CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))),
            frameProperties: nil,
            infoFlagsOut: nil
          ) { status, _, sample in
            if status == noErr, sample != nil { counter.increment() }
          }
          if status == noErr {
            encoded += 1
          } else {
            if encodeFailure == nil { encodeFailure = status }
            break
          }
        }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      }
    }

    for session in sessions {
      VTCompressionSessionInvalidate(session)
    }

    return Result(
      requested: maximum,
      created: created,
      firstFailureCode: firstFailure,
      codec: codec == kCMVideoCodecType_HEVC ? "HEVC" : "H.264",
      width: width,
      height: height,
      elapsedSeconds: (CFAbsoluteTimeGetCurrent() - started).rounded(toPlaces: 3),
      encoded: encoded,
      encodeFailureCode: encodeFailure,
      emitted: counter.value,
      framesPerSession: framesPerSession
    )
  }

  /// Total sustained encode throughput, expressed as whole-stream equivalents at a stated rate.
  public struct Throughput: Sendable, Codable, Equatable {
    public var sessions: Int
    public var seconds: Double
    public var emitted: Int
    public var codec: String
    public var height: Int
    /// The rate the streams being counted run at. Carried in the result rather than assumed,
    /// because it halves the answer: the same device that sustains four 30 fps streams sustains
    /// two at 60, and a headroom figure that does not say which it means is not usable.
    public var frameRate: Int = 30

    public var framesPerSecond: Double { seconds > 0 ? Double(emitted) / seconds : 0 }
    /// How many streams of this size and rate the device sustained.
    public var streams: Double { framesPerSecond / Double(max(frameRate, 1)) }

    public var summary: String {
      String(
        format: "%d x %@ %dp sessions sustained %.1f fps total over %.0fs = %.2f streams at %d fps",
        sessions, codec, height, framesPerSecond, seconds, streams, frameRate
      )
    }
  }

  /// Measures how much 1080p encoding this device can sustain in real time, which is the number
  /// that sizes hardware.
  ///
  /// Distinct from `probe(upTo:)`, which measures how many sessions can be *created* and briefly
  /// fed — that ran to ten sessions on hardware which in practice sustains barely two. Frames are
  /// submitted with a bounded number outstanding per session, so the result reflects what the
  /// encoder drains rather than how fast we can fill a queue.
  public static func sustainedThroughput(
    sessions sessionCount: Int,
    seconds: Double,
    width: Int = 1920,
    height: Int = 1080,
    codec: CMVideoCodecType = kCMVideoCodecType_H264,
    frameRate: Int = 30
  ) -> Throughput {
    var sessions: [VTCompressionSession] = []
    for _ in 0 ..< sessionCount {
      var session: VTCompressionSession?
      let status = VTCompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        width: Int32(width),
        height: Int32(height),
        codecType: codec,
        encoderSpecification: [
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue
        ] as CFDictionary,
        imageBufferAttributes: nil,
        compressedDataAllocator: nil,
        outputCallback: nil,
        refcon: nil,
        compressionSessionOut: &session
      )
      guard status == noErr, let session else { break }
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_AverageBitRate,
        value: NSNumber(value: 8_000_000)
      )
      // Rate control spends its bitrate per second, so an encoder told 30 while being fed 60
      // gives every frame half the bits and flatters the measurement.
      VTSessionSetProperty(
        session,
        key: kVTCompressionPropertyKey_ExpectedFrameRate,
        value: NSNumber(value: frameRate)
      )
      VTCompressionSessionPrepareToEncodeFrames(session)
      sessions.append(session)
    }

    // Cycled rather than a single buffer: re-encoding one unchanging frame makes every P-frame
    // almost empty and motion estimation trivial, which flattered this device by roughly 3x.
    let frames = movingFrames(width: width, height: height, count: 8)
    guard !frames.isEmpty, !sessions.isEmpty else {
      for session in sessions { VTCompressionSessionInvalidate(session) }
      return Throughput(
        sessions: 0,
        seconds: 0,
        emitted: 0,
        codec: codec == kCMVideoCodecType_HEVC ? "HEVC" : "H.264",
        height: height,
        frameRate: frameRate
      )
    }

    let counter = EmittedCounter()
    var submitted = [Int](repeating: 0, count: sessions.count)
    let started = CFAbsoluteTimeGetCurrent()
    let deadline = started + seconds
    // Deep enough that the encoder is never starved waiting for the submitting thread: with only
    // a few frames in flight this measures callback latency instead of throughput, and reported
    // *more* capacity for expensive content than for cheap content, which cannot be true.
    let maximumOutstanding = 30

    while CFAbsoluteTimeGetCurrent() < deadline {
      for (offset, session) in sessions.enumerated() {
        let outstanding = submitted[offset] - counter.value(for: offset)
        guard outstanding < maximumOutstanding else { continue }
        let index = submitted[offset]
        let status = VTCompressionSessionEncodeFrame(
          session,
          imageBuffer: frames[index % frames.count],
          presentationTimeStamp: CMTime(
            value: CMTimeValue(index),
            timescale: CMTimeScale(max(frameRate, 1))
          ),
          duration: CMTime(value: 1, timescale: CMTimeScale(max(frameRate, 1))),
          frameProperties: nil,
          infoFlagsOut: nil
        ) { status, _, sample in
          if status == noErr, sample != nil { counter.increment(offset) }
        }
        if status == noErr { submitted[offset] += 1 }
      }
      usleep(500)
    }

    let elapsed = CFAbsoluteTimeGetCurrent() - started
    for session in sessions {
      VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(session)
    }

    return Throughput(
      sessions: sessions.count,
      seconds: elapsed.rounded(toPlaces: 2),
      emitted: counter.value,
      codec: codec == kCMVideoCodecType_HEVC ? "HEVC" : "H.264",
      height: height,
      frameRate: frameRate
    )
  }

  private final class EmittedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var perSession: [Int: Int] = [:]

    func increment() {
      lock.lock()
      count += 1
      lock.unlock()
    }

    func increment(_ session: Int) {
      lock.lock()
      count += 1
      perSession[session, default: 0] += 1
      lock.unlock()
    }

    func value(for session: Int) -> Int {
      lock.lock()
      defer { lock.unlock() }
      return perSession[session] ?? 0
    }

    var value: Int {
      lock.lock()
      defer { lock.unlock() }
      return count
    }
  }

  /// A short loop of frames with detail that moves between them, so the encoder has to do the
  /// motion estimation and residual coding that real camera video costs.
  private static func movingFrames(width: Int, height: Int, count: Int) -> [CVPixelBuffer] {
    var frames: [CVPixelBuffer] = []
    for step in 0 ..< count {
      guard let buffer = blankFrame(width: width, height: height) else { continue }
      CVPixelBufferLockBaseAddress(buffer, [])
      if let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0) {
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
        let rows = CVPixelBufferGetHeightOfPlane(buffer, 0)
        let bytes = luma.assumingMemoryBound(to: UInt8.self)
        var seed = UInt32(truncatingIfNeeded: step &* 2_654_435_761) | 1
        let shift = step * 17
        for row in 0 ..< rows {
          for column in 0 ..< min(stride, width) {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            // Noise plus a diagonal ramp that translates each step: incompressible detail that
            // also genuinely moves.
            let noise = UInt8(truncatingIfNeeded: seed >> 16)
            let ramp = UInt8(truncatingIfNeeded: row + column + shift)
            bytes[row * stride + column] = noise &+ ramp
          }
        }
      }
      // Chroma too, or a quarter of the samples in the frame stay flat and free, and the reported
      // ceiling comes out higher than any real footage could achieve.
      if let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
        let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
        let rows = CVPixelBufferGetHeightOfPlane(buffer, 1)
        let bytes = chroma.assumingMemoryBound(to: UInt8.self)
        var seed = UInt32(truncatingIfNeeded: step &* 40_503) | 1
        for row in 0 ..< rows {
          for column in 0 ..< stride {
            seed = seed &* 1_664_525 &+ 1_013_904_223
            bytes[row * stride + column] = UInt8(truncatingIfNeeded: seed >> 16)
          }
        }
      }
      CVPixelBufferUnlockBaseAddress(buffer, [])
      frames.append(buffer)
    }
    return frames
  }

  private static func blankFrame(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      [ kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary ] as CFDictionary,
      &buffer
    )
    return status == kCVReturnSuccess ? buffer : nil
  }
}

extension Double {
  func rounded(toPlaces places: Int) -> Double {
    let divisor = pow(10.0, Double(places))
    return (self * divisor).rounded() / divisor
  }
}
