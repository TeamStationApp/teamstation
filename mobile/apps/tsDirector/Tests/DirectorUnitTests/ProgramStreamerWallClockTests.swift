import CoreMedia
import CoreVideo
import Darwin
import DirectorCore
import Foundation
import Testing
@testable import DirectorMedia
import DirectorPipeline
@testable import DirectorRTMP
import DirectorSources

/// The programme stream's wall clock, read off the wire: the streamer is put on air over a socket
/// pair with no encoder, handed encoded frames the way VideoToolbox hands them over, and every RTMP
/// video message the peer receives is taken apart again.
@Suite("Program streamer wall-clock SEI", .serialized)
struct ProgramStreamerWallClockTests {
  /// A wall in exact binary fractions of a second, so milliseconds come out whole.
  private static let now = 1_760_000_000.25

  // MARK: - S5: the SEI goes ahead of the slices

  @Test("An H.264 frame carries the SEI after the encoder's own units and before its slices")
  func h264() throws {
    let wire = try WireHarness(codec: .h264, offsetMs: 1_250, now: Self.now)
    defer { wire.close() }
    let encoderSEI = Data([ 0x06, 0x05, 0x02, 0xAA, 0xBB, 0x80 ])
    let idr = Data([ 0x65, 0x88, 0x84, 0x00, 0x21 ])
    let pSlice = Data([ 0x41, 0x9A, 0x02, 0x03 ])

    // A live picture captured half a second before it was stamped, then a repeat a frame later.
    wire.encode([ encoderSEI, idr ], frame: 1, captureWall: WallClock(seconds: Self.now - 0.5))
    wire.clock.set(Self.now + 0.125)
    wire.encode([ pSlice ], frame: 2, captureWall: nil)

    let tags = try wire.videoTags(2)
    // Classic FLV: keyframe then inter frame, codec 7, coded pictures, no composition offset.
    #expect(Array(tags[0].prefix(5)) == [ 0x17, 0x01, 0x00, 0x00, 0x00 ])
    #expect(Array(tags[1].prefix(5)) == [ 0x27, 0x01, 0x00, 0x00, 0x00 ])

    let first = try units(tags[0].dropFirst(5))
    let firstWall = Int64(1_759_999_999_750 + 1_250)
    #expect(first == [ encoderSEI, WallClockSEI.encode(.h264, wallMs: firstWall, corrected: true), idr ])

    // The repeat borrows the live picture's half-second lag, and the SEI goes first: nothing comes
    // before the slice.
    let second = try units(tags[1].dropFirst(5))
    let secondWall = Int64(1_759_999_999_875 + 1_250)
    #expect(second == [ WallClockSEI.encode(.h264, wallMs: secondWall, corrected: true), pSlice ])
    #expect(second[0][second[0].count - 2] & 1 == 1)
  }

  @Test("An HEVC frame carries the prefix SEI after the encoder's own units and before its slices")
  func hevc() throws {
    let wire = try WireHarness(codec: .hevc, offsetMs: -80, now: Self.now)
    defer { wire.close() }
    let encoderSEI = Data([ 0x4E, 0x01, 0x05, 0x02, 0xAA, 0xBB, 0x80 ])
    // IDR_W_RADL, in two slice segments.
    let idr = Data([ 0x26, 0x01, 0xAF, 0x09, 0x40 ])
    let idrSegment = Data([ 0x26, 0x01, 0x20, 0x11 ])

    wire.encode([ encoderSEI, idr, idrSegment ], frame: 1, captureWall: WallClock(seconds: Self.now - 0.25))

    let tags = try wire.videoTags(1)
    // Enhanced RTMP: IsExHeader, keyframe, CodedFrames, `hvc1`, then a zero composition offset.
    #expect(Array(tags[0].prefix(8)) == [ 0x91, 0x68, 0x76, 0x63, 0x31, 0x00, 0x00, 0x00 ])
    let wall = Int64(1_760_000_000_000 - 80)
    #expect(try units(tags[0].dropFirst(8)) == [
      encoderSEI,
      WallClockSEI.encode(.hevc, wallMs: wall, corrected: true),
      idr,
      idrSegment
    ])
  }

  @Test("A frame the encoder hands back that was never noted still goes out stamped, as of now")
  func unnotedFrame() throws {
    let wire = try WireHarness(codec: .h264, offsetMs: 0, now: Self.now)
    defer { wire.close() }
    let pSlice = Data([ 0x41, 0x9A ])
    wire.encode([ pSlice ], frame: 7, captureWall: nil, noted: false)
    let tags = try wire.videoTags(1)
    #expect(try units(tags[0].dropFirst(5)) == [
      WallClockSEI.encode(.h264, wallMs: 1_760_000_000_250, corrected: true),
      pSlice
    ])
  }

  @Test(
    "Frames VideoToolbox encodes go out with one SEI each, after the decoder configuration and ahead of their slices",
    arguments: [ RTMPVideoCodec.h264, .hevc ]
  )
  func encoded(codec: RTMPVideoCodec) throws {
    let wire = try WireHarness(codec: codec, offsetMs: 40, now: Self.now, encoder: true)
    defer { wire.close() }
    let seiCodec: WallClockSEI.Codec = codec == .hevc ? .hevc : .h264
    let picture = try #require(WireHarness.picture(width: 1280, height: 720))
    var expected: [Data] = []
    for frame in 0 ..< 3 {
      let now = Self.now + Double(frame) * 0.125
      wire.clock.set(now)
      wire.streamer.append(
        picture,
        presentationTime: CMTime(value: CMTimeValue(frame), timescale: 30),
        captureWall: WallClock(seconds: now - 0.5)
      )
      expected.append(WallClockSEI.encode(seiCodec, wallMs: Int64(((now - 0.5) * 1000).rounded()) + 40, corrected: true))
      // One at a time, so none is shed at the pending cap while the encoder holds another.
      wire.waitForEncoder()
    }

    let tags = try wire.videoTags(4)
    #expect(FLVTag.isVideoSequenceHeader(tags[0]))
    for (tag, sei) in zip(tags.dropFirst(), expected) {
      let found = try units(tag.dropFirst(codec == .hevc ? 8 : 5))
      let at = try #require(found.firstIndex(of: sei))
      let slice = try #require(found.firstIndex { WallClockSEI.isSlice(seiCodec, header: $0[0]) })
      #expect(at < slice)
      #expect(found.filter { $0 == sei }.count == 1)
    }
  }

  // MARK: - Where the server's copy begins

  @Test("Nothing sent, no live start; the first picture sets it, and a wedged-encoder reset does not move it")
  func liveStartSurvivesReset() throws {
    let wire = try WireHarness(codec: .h264, offsetMs: 0, now: Self.now, encoder: true)
    defer { wire.close() }
    #expect(wire.streamer.liveTimelineStart == nil)
    let picture = try #require(WireHarness.picture(width: 1280, height: 720))

    wire.streamer.append(picture, presentationTime: .zero, captureWall: WallClock(seconds: Self.now - 0.5))
    wire.waitForEncoder()
    _ = try wire.videoTags(2)
    let first = try #require(wire.streamer.liveTimelineStart)
    #expect(abs(first.seconds - (Self.now - 0.5)) < 0.002)

    // The stall watchdog throws the encoder away mid-publish; the next picture goes out behind a
    // fresh decoder configuration, seconds later.
    wire.streamer.resetWedgedSessionForTesting()
    wire.clock.set(Self.now + 5)
    wire.streamer.append(
      picture,
      presentationTime: CMTime(value: 150, timescale: 30),
      captureWall: WallClock(seconds: Self.now + 4.5)
    )
    wire.waitForEncoder()
    let tags = try wire.videoTags(4)
    #expect(FLVTag.isVideoSequenceHeader(tags[2]))
    #expect(wire.streamer.liveTimelineStart == first)
  }

  // MARK: - A stream started on a cut

  /// A cut keeps the old camera's last picture on air until the new camera's first is due, the live
  /// delay after it was captured. A stream started in that instant stamped the held picture as of
  /// now, a whole live delay late, and TeamStation placed the publish by its first frame.
  @Test("A stream started on a cut stamps the held picture at its capture time plus the time it has been on air")
  func streamStartedOnACut() async throws {
    let wire = try WireHarness(codec: .hevc, offsetMs: 0, now: Self.now, encoder: true, live: false)
    defer { wire.close() }
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("held-wall-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let telemetry = PipelineTelemetry(clock: wire.clock)
    let converter = PixelConverter()
    let router = TileRouter(
      telemetry: telemetry,
      converter: converter,
      compositor: nil,
      programEncoder: ProgramEncoder(telemetry: telemetry, converter: converter, config: AppConfig(programResolution: .hd720), directory: root),
      programStreamer: wire.streamer,
      clock: wire.clock
    )
    router.setStreamRate(30)
    let cameras = [ PushFrameSource(id: "cam-a"), PushFrameSource(id: "cam-b") ]
    for (index, camera) in cameras.enumerated() {
      let pipe = SourcePipeline(sourceID: camera.sourceID, sourceIndex: index, source: camera, converter: PixelConverter(), telemetry: telemetry)
      router.add(pipe)
      try pipe.start()
    }
    router.selectProgram(sourceIndex: 0)

    // Camera A's picture, captured the live delay ago: it comes due at once and goes on air.
    let capture = Self.now - AudioMixer.defaultLiveReadLagSeconds
    cameras[0].push(PixelFrame(
      sourceID: cameras[0].sourceID,
      pixelBuffer: try #require(WireHarness.picture(width: 1280, height: 720)),
      presentationTime: .zero,
      wallClock: WallClock(seconds: Self.now),
      captureWallClock: WallClock(seconds: capture),
      frameID: 0
    ))
    try await Task.sleep(for: .milliseconds(300))

    // Half a second later the operator cuts to camera B, whose first picture is not due yet, and
    // presses Stream in the same instant.
    wire.clock.set(Self.now + 0.5)
    router.selectProgram(sourceIndex: 1)
    try wire.goLive()

    let tags = try wire.videoTags(2)
    #expect(FLVTag.isVideoSequenceHeader(tags[0]))
    let found = try units(tags[1].dropFirst(8))
    // On air for half a second: it stands for its capture time plus that, not for now.
    let held = WallClockSEI.encode(.hevc, wallMs: Int64(((capture + 0.5) * 1000).rounded()), corrected: true)
    let asOfNow = WallClockSEI.encode(.hevc, wallMs: Int64(((Self.now + 0.5) * 1000).rounded()), corrected: true)
    #expect(!found.contains(asOfNow), "the held picture was stamped as of now, a live delay late")
    #expect(found.contains(held))
  }

  // MARK: - S6: no sample, no correction

  @Test("Without a measured offset the SEI carries Director's own wall, with bit 0 clear")
  func uncorrected() throws {
    // Never set, and set but not yet measured.
    let offsets: [Int??] = [ .none, .some(nil) ]
    for offset in offsets {
      let wire = try WireHarness(codec: .hevc, offsetMs: offset, now: Self.now)
      defer { wire.close() }
      let slice = Data([ 0x02, 0x01, 0xD0, 0x31 ])
      wire.encode([ slice ], frame: 3, captureWall: WallClock(seconds: Self.now - 0.5))

      let tags = try wire.videoTags(1)
      let found = try units(tags[0].dropFirst(8))
      #expect(found == [ WallClockSEI.encode(.hevc, wallMs: 1_759_999_999_750, corrected: false), slice ])
      // The flags byte sits just before the stop bit, whatever emulation prevention did before it.
      #expect(found[0].last == 0x80)
      #expect(found[0][found[0].count - 2] & 1 == 0)
    }
  }

  // MARK: - Helpers

  /// The length-prefixed NAL units of a frame, as written.
  private func units(_ payload: Data) throws -> [Data] {
    let bytes = [UInt8](payload)
    var found: [Data] = []
    var offset = 0
    while offset < bytes.count {
      try #require(offset + 4 <= bytes.count)
      let length = bytes[offset ..< offset + 4].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4
      try #require(offset + length <= bytes.count)
      found.append(Data(bytes[offset ..< offset + length]))
      offset += length
    }
    return found
  }
}

@Suite("Frame wall clock")
struct FrameWallClockTests {
  private static let slice = Data([ 0x00, 0x00, 0x00, 0x02, 0x41, 0x9A ])

  @Test("The wall is the content wall plus the offset, and corrected only with one")
  func wall() {
    let corrected = FrameWallClock(contentWallMs: 1_000, serverClockOffsetMs: -250)
    #expect(corrected.wallMs == 750)
    #expect(corrected.corrected)
    let own = FrameWallClock(contentWallMs: 1_000, serverClockOffsetMs: nil)
    #expect(own.wallMs == 1_000)
    #expect(!own.corrected)
  }

  @Test("A frame with no slice gets the SEI at its end")
  func noSlice() {
    let sei = Data([ 0x00, 0x00, 0x00, 0x02, 0x06, 0x80 ])
    let clock = FrameWallClock(contentWallMs: 5, serverClockOffsetMs: nil)
    let nal = WallClockSEI.encode(.h264, wallMs: 5, corrected: false)
    #expect(clock.inserted(into: sei, codec: .h264) == sei + Self.prefixed(nal))
  }

  @Test("A unit whose length runs past the end stops the walk, and the SEI goes after the last whole one")
  func truncated() {
    let whole = Data([ 0x00, 0x00, 0x00, 0x02, 0x06, 0x80 ])
    let broken = Data([ 0x00, 0x00, 0x00, 0x09, 0x06, 0x80 ])
    let zero = Data([ 0x00, 0x00, 0x00, 0x00 ])
    let clock = FrameWallClock(contentWallMs: 5, serverClockOffsetMs: 1)
    let nal = Self.prefixed(WallClockSEI.encode(.h264, wallMs: 6, corrected: true))
    #expect(clock.inserted(into: whole + broken, codec: .h264) == whole + nal + broken)
    #expect(clock.inserted(into: zero + Self.slice, codec: .h264) == nal + zero + Self.slice)
    #expect(clock.inserted(into: Data(), codec: .h264) == nal)
  }

  @Test("A two-byte length prefix is written in two bytes")
  func shortLengths() {
    let slice = Data([ 0x00, 0x02, 0x41, 0x9A ])
    let clock = FrameWallClock(contentWallMs: 5, serverClockOffsetMs: nil)
    let nal = WallClockSEI.encode(.h264, wallMs: 5, corrected: false)
    let length = Data([ UInt8(nal.count >> 8), UInt8(nal.count & 0xFF) ])
    #expect(clock.inserted(into: slice, codec: .h264, lengthSize: 2) == length + nal + slice)
  }

  @Test("The FLV tag carries the payload with the SEI in it")
  func tag() {
    let clock = FrameWallClock(contentWallMs: 5, serverClockOffsetMs: nil)
    #expect(
      FLVTag.videoFrame(codec: .h264, keyframe: false, payload: Self.slice, wallClock: clock)
        == FLVTag.videoFrame(codec: .h264, keyframe: false, payload: clock.inserted(into: Self.slice, codec: .h264))
    )
  }

  private static func prefixed(_ nal: Data) -> Data {
    Data([ 0, 0, UInt8(nal.count >> 8), UInt8(nal.count & 0xFF) ]) + nal
  }
}

@Suite("Programme content wall")
struct ProgrammeContentWallTests {
  @Test("A live picture's capture time sets the lag, and a repeat borrows it")
  func borrowsTheLag() {
    var content = ProgrammeContentWall()
    // Nothing measured yet: the frame is as of now.
    #expect(content.wall(at: 100, captureWall: nil) == WallClock(seconds: 100))
    #expect(content.wall(at: 101, captureWall: WallClock(seconds: 100.5)) == WallClock(seconds: 100.5))
    #expect(content.lagSeconds == 0.5)
    #expect(content.wall(at: 103, captureWall: nil) == WallClock(seconds: 102.5))
  }

  @Test("A capture time in the future or ten seconds back is not believed")
  func unbelievable() {
    var content = ProgrammeContentWall()
    _ = content.wall(at: 100, captureWall: WallClock(seconds: 99.75))
    #expect(content.wall(at: 100, captureWall: WallClock(seconds: 100.5)) == WallClock(seconds: 99.75))
    #expect(content.wall(at: 100, captureWall: WallClock(seconds: 90)) == WallClock(seconds: 99.75))
    content.reset()
    #expect(content.lagSeconds == nil)
  }
}

@Suite("Programme held picture wall")
struct ProgrammeHeldPictureWallTests {
  @Test("A new picture carries its capture time, and a repeat that plus the time it has been on air")
  func repeatsMoveOn() {
    var held = ProgrammeHeldPictureWall()
    #expect(held.capture(sequence: 1, capture: WallClock(seconds: 99), at: 100) == WallClock(seconds: 99))
    #expect(held.capture(sequence: 1, capture: WallClock(seconds: 99), at: 100.5) == WallClock(seconds: 99.5))
    // The next picture starts again from its own capture time.
    #expect(held.capture(sequence: 2, capture: WallClock(seconds: 100.25), at: 101.25) == WallClock(seconds: 100.25))
    #expect(held.capture(sequence: 2, capture: WallClock(seconds: 100.25), at: 102.25) == WallClock(seconds: 101.25))
  }

  @Test("A picture with no capture time, a replay's, carries none")
  func replay() {
    var held = ProgrammeHeldPictureWall()
    #expect(held.capture(sequence: 1, capture: nil, at: 100) == nil)
    #expect(held.capture(sequence: 1, capture: nil, at: 101) == nil)
  }
}

@Suite("Stream frame walls")
struct StreamFrameWallsTests {
  @Test("A frame's wall comes back with it, and frames the encoder dropped before it go")
  func takesInOrder() {
    var walls = StreamFrameWalls()
    for frame in 1 ... 4 {
      walls.note(WallClock(seconds: Double(frame)), for: CMTime(value: CMTimeValue(frame), timescale: 30))
    }
    // Frames 1 and 2 were dropped; 3 comes back.
    #expect(walls.take(CMTime(value: 3, timescale: 30)) == WallClock(seconds: 3))
    #expect(walls.count == 1)
    // The same instant at another timescale is the same frame.
    #expect(walls.take(CMTime(value: 8, timescale: 60)) == WallClock(seconds: 4))
    #expect(walls.take(CMTime(value: 5, timescale: 30)) == nil)
    walls.note(WallClock(seconds: 9), for: CMTime(value: 9, timescale: 30))
    walls.removeAll()
    #expect(walls.count == 0)
  }
}

/// The streamer on air over one end of a socket pair, with a clock the test sets, and an RTMP chunk
/// reader on the other end.
private final class WireHarness {
  let clock: FixedClock
  let streamer: ProgramStreamer
  private let client = RTMPClient()
  private let ends: [Int32]
  private let reader = RTMPChunkReader()
  private var received: [Data] = []

  /// `offsetMs` nil leaves the streamer's offset unset; `.some(nil)` sets one that has not measured.
  /// `encoder` gives the streamer a real VideoToolbox session at 720p.
  /// `live` false leaves the streamer stopped until `goLive`.
  init(codec: RTMPVideoCodec, offsetMs: Int??, now: Double, encoder: Bool = false, live: Bool = true) throws {
    var fds: [Int32] = [ 0, 0 ]
    _ = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
    ends = fds
    clock = FixedClock(now)
    streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter(), clock: clock)
    if let offsetMs {
      streamer.setServerClockOffset { offsetMs }
    }
    client.attachForTesting(fd: fds[0], budgetBytes: 8 * 1024 * 1024)
    var config = AppConfig.default
    config.streamCodec = codec == .hevc ? .hevc : .h264
    config.streamResolution = .hd720
    settings = StreamSettings(config: config)
    self.encoder = encoder
    if live { try goLive() }
  }

  private let settings: StreamSettings
  private let encoder: Bool

  /// Puts the streamer on air, as a press of Stream does.
  func goLive() throws {
    try streamer.goLiveForTesting(client: client, settings: settings, encoder: encoder)
  }

  /// Waits, for up to two seconds, until the encoder has handed back everything it was given.
  func waitForEncoder() {
    let deadline = Date().addingTimeInterval(2)
    while streamer.pendingEncodesForTesting > 0, Date() < deadline {
      usleep(5_000)
    }
  }

  /// A grey picture in the encoder's own format, so the streamer hands it over as it is.
  static func picture(width: Int, height: Int) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let attributes = [ kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary ] as CFDictionary
    guard CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      attributes,
      &buffer
    ) == kCVReturnSuccess, let buffer else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    for plane in 0 ..< CVPixelBufferGetPlaneCount(buffer) {
      if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) {
        memset(base, 128, CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane))
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, [])
    return buffer
  }

  /// Hands the streamer one encoded frame: noted as `encode` notes it, unless `noted` is false, then
  /// back from the encoder as length-prefixed `units`.
  func encode(_ units: [Data], frame: Int64, captureWall: WallClock?, noted: Bool = true) {
    let time = CMTime(value: frame, timescale: 30)
    if noted {
      streamer.noteFrameForTesting(presentationTime: time, captureWall: captureWall)
    }
    var payload = Data()
    for unit in units {
      let length = UInt32(unit.count)
      payload.append(contentsOf: [ UInt8(length >> 24), UInt8((length >> 16) & 0xFF), UInt8((length >> 8) & 0xFF), UInt8(length & 0xFF) ])
      payload.append(unit)
    }
    streamer.simulateOutputCallbackForTesting(
      incrementPending: true,
      sample: Self.sample(payload, at: time),
      status: noErr
    )
  }

  /// The first `count` video messages the peer received, read for up to five seconds.
  func videoTags(_ count: Int) throws -> [Data] {
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    let deadline = Date().addingTimeInterval(5)
    while received.count < count, Date() < deadline {
      let read = buffer.withUnsafeMutableBytes { Darwin.recv(ends[1], $0.baseAddress, $0.count, MSG_DONTWAIT) }
      if read > 0 {
        let messages = reader.push(Data(buffer[0 ..< read]))
        received += messages.filter { $0.type == .video }.map(\.payload)
      } else {
        usleep(5_000)
      }
    }
    try #require(received.count >= count)
    return Array(received.prefix(count))
  }

  func close() {
    streamer.stop()
    Darwin.close(ends[1])
    Darwin.close(ends[0])
  }

  /// An encoded frame as VideoToolbox's callback carries it: one sample, its bytes and its time, and
  /// no format description, which the streamer only reads for the decoder configuration.
  private static func sample(_ payload: Data, at time: CMTime) -> CMSampleBuffer? {
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: payload.count,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: payload.count,
      flags: 0,
      blockBufferOut: &block
    ) == noErr, let block else { return nil }
    let copied = payload.withUnsafeBytes { bytes in
      CMBlockBufferReplaceDataBytes(
        with: bytes.baseAddress!,
        blockBuffer: block,
        offsetIntoDestination: 0,
        dataLength: payload.count
      )
    }
    guard copied == noErr else { return nil }
    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: 30),
      presentationTimeStamp: time,
      decodeTimeStamp: .invalid
    )
    var size = payload.count
    var sample: CMSampleBuffer?
    guard CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: block,
      formatDescription: nil,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &size,
      sampleBufferOut: &sample
    ) == noErr else { return nil }
    return sample
  }
}
