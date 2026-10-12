import CoreMedia
import DirectorCore
@testable import DirectorExport
@testable import DirectorMedia
@testable import DirectorRTMP
import Foundation

/// The golden vectors of Director's stream and recording paths, written to
/// `mobile/apps/common/MediaFixtures/` as JSON beside `.bin` files of the bytes on the wire.
///
/// The Kotlin port of these paths asserts the same files, so a change to Director's behaviour here
/// changes a fixture, and the Android suite fails until the change is ported. Every vector is
/// computed from the code itself, never typed in, and every input is fixed, so writing them twice
/// gives the same bytes.
enum MediaFixtureWriter {
  /// One file the writer produces, by name, and its contents.
  struct File: Equatable {
    let name: String
    let data: Data
  }

  /// Every fixture, in name order.
  static let names: [String] = files().map(\.name)

  /// Where the fixtures live in the repository, from this file's own place in it.
  static var directory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // DirectorUnitTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // tsDirector
      .deletingLastPathComponent()  // apps
      .appendingPathComponent("common/MediaFixtures", isDirectory: true)
  }

  /// Writes every fixture into `directory`, replacing what is there, and answers with what it wrote.
  @discardableResult
  static func write(to directory: URL = directory) throws -> [File] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let all = files()
    for file in all {
      try file.data.write(to: directory.appendingPathComponent(file.name), options: .atomic)
    }
    return all
  }

  /// Every fixture's contents, computed now.
  static func files() -> [File] {
    var out: [File] = []
    out += rtmpWire()
    out += sendBudget()
    out.append(json("stream-encode-clock.json", streamEncodeClock()))
    out.append(json("stream-audio-stamps.json", streamAudioStamps()))
    out.append(json("stream-stall-policy.json", streamStallPolicy()))
    out.append(json("reconnect-backoff.json", reconnectBackoff()))
    out.append(json("programme-grid-placement.json", gridPlacement()))
    out.append(json("programme-sound-origin.json", soundOrigin()))
    out.append(json("programme-hold-fill.json", holdFill()))
    out.append(json("programme-resumed-part.json", resumedPart()))
    out.append(json("programme-export-placement.json", exportPlacement()))
    return out.sorted { $0.name < $1.name }
  }

  // MARK: - Encoding

  private static func json<Value: Encodable>(_ name: String, _ value: Value) -> File {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [ .prettyPrinted, .sortedKeys, .withoutEscapingSlashes ]
    // A vector that cannot be encoded is a bug in the writer, and the test says so.
    let data = (try? encoder.encode(value)) ?? Data()
    return File(name: name, data: data + Data("\n".utf8))
  }

  private static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  // MARK: - RTMP on the wire

  /// The parameter sets of a 1920×1080 HEVC Main stream from VideoToolbox.
  static let vps = Data([
    0x40, 0x01, 0x0C, 0x01, 0xFF, 0xFF, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03,
    0x00, 0x00, 0x03, 0x00, 0x78, 0x17, 0x02, 0x40
  ])
  static let sps = Data([
    0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x03, 0x00, 0xB0, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03,
    0x00, 0x78, 0xA0, 0x03, 0xC0, 0x80, 0x11, 0x07, 0xCB, 0x88, 0x17, 0xB9, 0x16, 0x45, 0x2F, 0xFC,
    0xB9, 0xFC, 0x4F, 0xE8, 0x80
  ])
  static let pps = Data([ 0x44, 0x01, 0xC0, 0x72, 0xF0, 0x53, 0x24 ])
  /// AAC-LC, 48 kHz, stereo.
  static let audioSpecificConfig = Data([ 0x11, 0x90 ])
  static let url = "rtmp://ingest.example.test:1935/live/00000000-0000-4000-8000-000000000001"

  struct WireEntry: Encodable {
    let name: String
    let file: String
    let bytes: Int
    let description: String
    var chunkStreamID: UInt32?
    var messageType: UInt8?
    var timestamp: UInt32?
    var chunkSize: Int?
  }

  private static func rtmpWire() -> [File] {
    var files: [File] = []
    var index: [WireEntry] = []
    func add(_ name: String, _ data: Data, _ description: String, chunk: (UInt32, RTMPMessage, Int)? = nil) {
      let file = "rtmp-\(name).bin"
      files.append(File(name: file, data: data))
      var entry = WireEntry(name: name, file: file, bytes: data.count, description: description)
      if let (stream, message, size) = chunk {
        entry.chunkStreamID = stream
        entry.messageType = message.type.rawValue
        entry.timestamp = message.timestamp
        entry.chunkSize = size
      }
      index.append(entry)
    }

    // C0 and the fixed head of C1: version 3, the time, four zero bytes. The rest of C1 is random.
    add(
      "handshake-c0c1-head",
      Data(RTMPHandshake.c0c1(time: 0x0102_0304).prefix(9)),
      "C0 and the first 8 bytes of C1 for time 0x01020304; C1 is 1536 bytes, the rest random"
    )
    var s1 = Data(count: RTMPHandshake.packetSize)
    for offset in s1.indices { s1[offset] = UInt8(offset % 251) }
    add("handshake-c2", RTMPHandshake.c2(fromS1: s1), "C2 echoes S1, here bytes i % 251")

    let parsed = try? RTMPURL.parse(url).get()
    if let parsed {
      for codec in [ RTMPVideoCodec.hevc, .h264 ] {
        let payload = RTMPClient.connectPayload(url: parsed, codec: codec)
        let message = RTMPMessage(streamID: 0, type: .amf0Command, timestamp: 0, payload: payload)
        add(
          "connect-\(codec.rawValue)",
          RTMPChunk.encode(message, chunkStreamID: 3, chunkSize: 4096),
          "connect on chunk stream 3, chunk size 4096; fourCcList names hvc1 for HEVC only",
          chunk: (3, message, 4096)
        )
      }
      let publish = RTMPMessage(
        streamID: 1,
        type: .amf0Command,
        timestamp: 0,
        payload: RTMPClient.publishPayload(stream: parsed.stream)
      )
      add(
        "publish",
        RTMPChunk.encode(publish, chunkStreamID: 3, chunkSize: 4096),
        "publish of the stream key, transaction 3, type live",
        chunk: (3, publish, 4096)
      )
    }
    let metadata = RTMPMessage(
      streamID: 1,
      type: .amf0Data,
      timestamp: 0,
      payload: RTMPClient.metadataPayload(
        width: 1920, height: 1080, frameRate: 30, bitrate: 4_000_000, codec: .hevc
      )
    )
    add(
      "onmetadata-hevc",
      RTMPChunk.encode(metadata, chunkStreamID: 4, chunkSize: 4096),
      "@setDataFrame onMetaData for 1920x1080 at 30 fps, 4 Mbps, hvc1",
      chunk: (4, metadata, 4096)
    )

    let record = HEVCDecoderConfiguration.record(parameterSets: [ vps, sps, pps ]) ?? Data()
    let sequenceStart = FLVTag.videoSequenceHeader(codec: .hevc, record: record)
    add("hevc-sequence-start-tag", sequenceStart, "Enhanced RTMP SequenceStart tag carrying the hvcC")
    var keyframe = Data([ 0x00, 0x00, 0x00, 0x08, 0x26, 0x01 ])
    keyframe.append(Data((0 ..< 6).map { UInt8($0) }))
    let keyTag = FLVTag.videoFrame(codec: .hevc, keyframe: true, payload: keyframe)
    add("hevc-keyframe-tag", keyTag, "Enhanced RTMP coded frame, keyframe, one IDR NAL, length-prefixed")
    var delta = Data([ 0x00, 0x00, 0x00, 0x05, 0x02, 0x01 ])
    delta.append(Data([ 0xAA, 0xBB, 0xCC ]))
    add(
      "hevc-delta-tag",
      FLVTag.videoFrame(codec: .hevc, keyframe: false, payload: delta),
      "Enhanced RTMP coded frame, inter frame, one TRAIL_R NAL"
    )
    add("aac-sequence-header-tag", FLVTag.audio(packetType: 0, payload: audioSpecificConfig), "AAC sequence header, LC 48 kHz stereo")
    add(
      "aac-raw-tag",
      FLVTag.audio(packetType: 1, payload: Data((0 ..< 16).map { UInt8($0 * 3) })),
      "AAC raw frame"
    )
    // A coded frame larger than one chunk: the continuation chunks are type 3 headers.
    let big = RTMPMessage(
      streamID: 1,
      type: .video,
      timestamp: 1_234,
      payload: FLVTag.videoFrame(codec: .hevc, keyframe: true, payload: Data((0 ..< 300).map { UInt8($0 % 256) }))
    )
    add(
      "video-chunked-128",
      RTMPChunk.encode(big, chunkStreamID: 6, chunkSize: 128),
      "a 305-byte video message in 128-byte chunks on chunk stream 6",
      chunk: (6, big, 128)
    )
    let audioMessage = RTMPMessage(
      streamID: 1,
      type: .audio,
      timestamp: 0x00FF_FFFF + 5,
      payload: FLVTag.audio(packetType: 1, payload: Data(repeating: 0x5A, count: 10))
    )
    add(
      "audio-extended-timestamp",
      RTMPChunk.encode(audioMessage, chunkStreamID: 5, chunkSize: 4096),
      "an audio message whose timestamp needs the extended field",
      chunk: (5, audioMessage, 4096)
    )

    files.append(json("rtmp-wire.json", [ "url": AnyEncodable(url), "entries": AnyEncodable(index) ]))
    return files
  }

  // MARK: - Send budget and shedding

  struct BacklogItem: Encodable {
    let kind: String
    let bytes: Int
  }

  struct ShedCase: Encodable {
    let name: String
    let budgetBytes: Int
    let delayExceeded: Bool
    let queue: [BacklogItem]
    let dropped: [Int]
  }

  struct BudgetRow: Encodable {
    let bitrate: Int
    let sendBudgetBytes: Int
  }

  private static func sendBudget() -> [File] {
    let budgets = [ 500_000, 2_000_000, 4_000_000, 6_000_000, 20_000_000 ].map {
      BudgetRow(bitrate: $0, sendBudgetBytes: RTMPClient.sendBudget(forBitrate: $0))
    }
    func item(_ kind: String, _ bytes: Int) -> RTMPClient.ShedItem {
      RTMPClient.ShedItem(
        bytes: bytes,
        isVideo: kind == "key" || kind == "delta",
        isKeyframe: kind == "key",
        isSequenceHeader: kind == "header"
      )
    }
    func groups(_ count: Int, frames: Int, bytes: Int, audioEvery: Int = 0) -> [(String, Int)] {
      var queue: [(String, Int)] = [ ("header", 40), ("header", 7) ]
      for _ in 0 ..< count {
        queue.append(("key", bytes * 4))
        for frame in 1 ..< frames {
          queue.append(("delta", bytes))
          if audioEvery > 0, frame % audioEvery == 0 { queue.append(("audio", 400)) }
        }
      }
      return queue
    }
    let scripts: [(String, Int, Bool, [(String, Int)])] = [
      ("under budget", 100_000, false, groups(2, frames: 4, bytes: 1_000)),
      ("over budget by one group", 30_000, false, groups(4, frames: 4, bytes: 1_500)),
      ("over budget with audio between pictures", 40_000, false, groups(5, frames: 6, bytes: 1_200, audioEvery: 2)),
      ("delay over the send buffer sheds everything but headers", 10_000_000, true, groups(3, frames: 3, bytes: 900)),
      ("only headers queued", 10, false, [ ("header", 40), ("header", 7) ]),
      ("a group cut mid-way loses its tail too", 9_000, false, [
        ("header", 40), ("key", 4_000), ("delta", 1_000), ("delta", 1_000), ("key", 4_000), ("delta", 1_000)
      ])
    ]
    let cases = scripts.map { name, budget, late, script in
      let queue = script.map { item($0.0, $0.1) }
      let total = queue.reduce(0) { $0 + $1.bytes }
      return ShedCase(
        name: name,
        budgetBytes: budget,
        delayExceeded: late,
        queue: script.map { BacklogItem(kind: $0.0, bytes: $0.1) },
        dropped: RTMPClient.shedIndices(queue, queuedBytes: total, budget: budget, delayExceeded: late)
      )
    }
    return [
      json("rtmp-send-budget.json", [
        "bufferSeconds": AnyEncodable(RTMPClient.sendBufferSeconds),
        "budgets": AnyEncodable(budgets),
        "shedding": AnyEncodable(cases)
      ])
    ]
  }

  // MARK: - Stream timing

  struct ClockStep: Encodable {
    let now: Double
    var requestKeyframe = false
    let ptsValue: Int64
    let ptsTimescale: Int32
    let forceKey: Bool
  }

  private static func streamEncodeClock() -> [String: AnyEncodable] {
    var clock = StreamEncodeClock(frameRate: 30, gopSeconds: 2)
    let base = 800_000_000.0
    // On time, a late frame, two frames at the same instant, a clock that went backwards, a stall,
    // a cut asking for a keyframe, and a GOP's worth more.
    let script: [(Double, Bool)] = [
      (0, false), (1.0 / 30, false), (2.0 / 30, false), (0.2, false), (0.2, false), (0.15, false),
      (0.5, false), (0.5 + 1.0 / 30, true), (1.0, false), (2.0, false), (2.1, false), (4.6, false),
      (4.6 + 1.0 / 30, false)
    ]
    var steps: [ClockStep] = []
    for (offset, request) in script {
      if request { clock.requestKeyframe() }
      let now = base + offset
      let time = clock.nextPresentationTime(source: .zero, now: now)
      let force = clock.shouldForceKey(at: time, now: now)
      if force { clock.noteKeyframe(at: time, now: now) }
      steps.append(ClockStep(
        now: offset,
        requestKeyframe: request,
        ptsValue: time.value,
        ptsTimescale: time.timescale,
        forceKey: force
      ))
    }
    return [
      "frameRate": AnyEncodable(30),
      "gopSeconds": AnyEncodable(2.0),
      "maxKeyFrameInterval": AnyEncodable(clock.maxKeyFrameInterval),
      "steps": AnyEncodable(steps)
    ]
  }

  struct StampRun: Encodable {
    let inputWall: Double
    let startWall: Double
    let primingSamples: Int
    let epochMilliseconds: Double
    let fromPacket: Int
    let count: Int
    let stamps: [UInt32?]
  }

  private static func streamAudioStamps() -> [String: AnyEncodable] {
    // A stream started at 1000 s; its mix began 0.5 s later, ran 40 packets, broke for more than
    // the gap the encoder tolerates, and came back at 1003.25 s: the encoder is reset, the count
    // starts again from a new epoch, and no stamp goes at or before the last one sent.
    let runs: [(Double, Int, Int)] = [ (1_000.5, 0, 40), (1_003.25, 0, 40), (999.98, 0, 4) ]
    var stamps: [StampRun] = []
    for (input, from, count) in runs {
      let epoch = ProgramStreamer.audioEpochMilliseconds(inputWall: input, startWall: 1_000, primingSamples: 2_112)
      stamps.append(StampRun(
        inputWall: input,
        startWall: 1_000,
        primingSamples: 2_112,
        epochMilliseconds: epoch,
        fromPacket: from,
        count: count,
        stamps: ProgramStreamer.audioTimestamps(count: count, from: from, epoch: epoch)
      ))
    }
    let proposed: [UInt32?] = [ 1_000, 1_021, 1_021, nil, 1_020, 1_043, 2_000 ]
    let monotonic = ProgramStreamer.monotonicAudioStamps(proposed, after: 990)
    return [
      "samplesPerPacket": AnyEncodable(1_024),
      "sampleRate": AnyEncodable(48_000),
      "resetGapSeconds": AnyEncodable(ProgramStreamer.audioGapResetSeconds),
      "runs": AnyEncodable(stamps),
      "neverBackwards": AnyEncodable([
        "after": AnyEncodable(990),
        "proposed": AnyEncodable(proposed),
        "sent": AnyEncodable(monotonic)
      ])
    ]
  }

  struct StallCase: Encodable {
    let name: String
    let now: Double
    let lastKeyframeWall: Double
    let lastCallbackWall: Double
    let pendingEncodes: Int
    let hasLastFrame: Bool
    let lastResetWall: Double
    let startedWall: Double
    let lastOutputWall: Double
    let action: String
  }

  private static func streamStallPolicy() -> [String: AnyEncodable] {
    let policy = StreamStallPolicy(gopSeconds: 2, resetCooldown: 10)
    let cases: [(String, Double, Double, Double, Int, Bool, Double, Double, Double)] = [
      ("healthy", 100, 99.5, 99.97, 1, true, 0, 50, 99.97),
      ("keyframe overdue by half a GOP", 100, 97, 99.97, 0, true, 0, 50, 99.97),
      ("keyframe due but not yet overdue", 100, 98, 99.97, 0, true, 0, 50, 99.97),
      ("overdue with no picture to repeat", 100, 97, 99.97, 0, false, 0, 50, 99.97),
      ("callbacks silent with encodes pending", 100, 99, 95, 3, true, 0, 50, 95),
      ("callbacks silent inside the reset cooldown", 100, 99, 95, 3, true, 95, 50, 95),
      ("callbacks silent after the cooldown", 100, 99, 95, 3, true, 89, 50, 95),
      ("errors only, no picture for two GOPs", 100, 99, 99.98, 1, true, 0, 50, 96),
      ("never a callback, three GOPs in", 100, 0, 0, 2, true, 0, 94, 0),
      ("never a callback, two GOPs in", 100, 0, 0, 2, true, 0, 96, 0),
      ("no keyframe yet, overdue from the start", 100, 0, 99.9, 0, true, 0, 97, 99.9)
    ]
    let rows = cases.map { name, now, key, callback, pending, last, reset, started, output in
      let action = policy.action(
        now: now,
        lastKeyframeWall: key,
        lastCallbackWall: callback,
        pendingEncodes: pending,
        hasLastFrame: last,
        lastResetWall: reset,
        startedWall: started,
        lastOutputWall: output
      )
      let named: String
      switch action {
      case .none: named = "none"
      case .encodeIdleIDR: named = "encodeIdleIDR"
      case .resetSession: named = "resetSession"
      }
      return StallCase(
        name: name, now: now, lastKeyframeWall: key, lastCallbackWall: callback,
        pendingEncodes: pending, hasLastFrame: last, lastResetWall: reset, startedWall: started,
        lastOutputWall: output, action: named
      )
    }
    return [
      "gopSeconds": AnyEncodable(2.0),
      "resetCooldown": AnyEncodable(10.0),
      "cases": AnyEncodable(rows)
    ]
  }

  struct BackoffEvent: Encodable {
    let event: String
    let at: Double
    var liveFor: Double?
    var waits: Double?
  }

  /// The redial waits of `StreamSessionController`, from its own schedule rules.
  private static func reconnectBackoff() -> [String: AnyEncodable] {
    var schedule = StreamRetrySchedule()
    var events: [BackoffEvent] = []
    var at = 0.0
    // Six drops a second after each dial: 3, 6, 12, 24, 30, 30.
    for _ in 0 ..< 6 {
      let wait = schedule.dropped(liveFor: 1)
      events.append(BackoffEvent(event: "drop", at: at, liveFor: 1, waits: wait))
      at += wait + 1
    }
    // A session that held 45 s: the next wait starts over at 3.
    let reset = schedule.dropped(liveFor: 45)
    events.append(BackoffEvent(event: "drop", at: at, liveFor: 45, waits: reset))
    at += reset + 29.9
    // One that held just under 30 s does not reset it.
    let short = schedule.dropped(liveFor: 29.9)
    events.append(BackoffEvent(event: "drop", at: at, liveFor: 29.9, waits: short))
    // A drop while dialling (never live) keeps doubling.
    let dialling = schedule.dropped(liveFor: nil)
    events.append(BackoffEvent(event: "drop", at: at + short, liveFor: nil, waits: dialling))
    schedule.started()
    events.append(BackoffEvent(event: "start", at: at + short + dialling))
    let fresh = schedule.dropped(liveFor: 2)
    events.append(BackoffEvent(event: "drop", at: at + short + dialling + 2, liveFor: 2, waits: fresh))
    return [
      "firstRetrySeconds": AnyEncodable(StreamRetrySchedule.firstRetrySeconds),
      "longestRetrySeconds": AnyEncodable(StreamRetrySchedule.longestRetrySeconds),
      "liveResetSeconds": AnyEncodable(StreamRetrySchedule.liveResetSeconds),
      "events": AnyEncodable(events)
    ]
  }

  // MARK: - The recording

  struct GridStep: Encodable {
    let sourceSeconds: Double?
    let hostSeconds: Double
    let onClockGrid: Bool
    let slot: Int64?
  }

  private static func gridPlacement() -> [String: AnyEncodable] {
    let rate = 30.0
    // Camera-timed frames with jitter, one running fast, a stall, and clock-grid frames that a late
    // timer delivers together.
    let script: [(Double?, Double, Bool)] = [
      (0.000, 0.000, false), (0.034, 0.033, false), (0.065, 0.068, false), (0.101, 0.099, false),
      (0.110, 0.115, false), (0.140, 0.130, false), (0.300, 0.170, false), (0.230, 0.235, false),
      (nil, 0.270, false), (1.000, 1.000, false), (1.033, 1.040, true), (1.066, 1.140, true),
      (1.100, 1.140, true), (1.133, 1.140, true), (1.000, 1.180, true), (1.300, 1.300, false)
    ]
    var lastSlot: Int64 = -1
    var steps: [GridStep] = []
    for (source, host, grid) in script {
      let hostSlot = Int64((host * rate).rounded())
      let slot = ProgramEncoder.gridSlot(
        sourceSeconds: source,
        rate: rate,
        hostSlot: hostSlot,
        lastSlot: lastSlot,
        onClockGrid: grid,
        continuingAfterRecovery: false
      )
      let written = slot > lastSlot ? slot : nil
      if let written { lastSlot = written }
      steps.append(GridStep(sourceSeconds: source, hostSeconds: host, onClockGrid: grid, slot: written))
    }
    return [
      "frameRate": AnyEncodable(30),
      "gridSlackFrames": AnyEncodable(ProgramEncoder.gridSlackForTesting),
      "steps": AnyEncodable(steps)
    ]
  }

  struct OriginCase: Encodable {
    let name: String
    let offers: [[Double]]
    let partStartWall: Double?
  }

  private static func soundOrigin() -> [String: AnyEncodable] {
    func run(_ name: String, _ offers: [(Double, Double)]) -> OriginCase {
      var origin = ProgrammeSoundOrigin()
      for (implied, seconds) in offers {
        origin.offer(impliedPartStart: implied, atProgramme: seconds)
      }
      return OriginCase(name: name, offers: offers.map { [ $0.0, $0.1 ] }, partStartWall: origin.partStartWall)
    }
    func frames(_ count: Int, _ implied: (Int) -> Double) -> [(Double, Double)] {
      (0 ..< count).map { index -> (Double, Double) in (implied(index), Double(index) / 30) }
    }
    let steady = frames(50) { index -> Double in 1_000 + 0.02 * Double(index % 5) }
    let spiky = frames(50) { index -> Double in index % 7 == 3 ? 1_000.4 : 1_000.01 }
    let even = frames(46) { index -> Double in 1_000 + 0.001 * Double(index) }
    let short = frames(20) { _ -> Double in 1_000 }
    return [
      "seedSeconds": AnyEncodable(ProgrammeSoundOrigin.seedSeconds),
      "cases": AnyEncodable([
        run("jitter within 80 ms", steady),
        run("late spikes ignored by the median", spiky),
        run("an even count takes the mean of the middle two", even),
        run("not settled before 1.5 s", short)
      ])
    ]
  }

  struct HoldCase: Encodable {
    let name: String
    let requestedEnd: Double
    let lastPictureSeconds: Double?
    let frameRate: Int
    let writtenSoundEnd: Double
    let pictureFillFrom: Double
    let pictureFillStep: Double
    let pictureFillCount: Int
    let soundFillEnd: Double
    let silenceSeconds: Double
    let silenceCapped: Bool
  }

  private static func holdFill() -> [String: AnyEncodable] {
    let cases: [(String, Double, Double?, Int, Double)] = [
      ("picture reached the stop, sound 4 s short", 600, 599.95, 30, 596),
      ("picture a frame past the stop", 600, 600.02, 30, 599.9),
      ("no picture at all", 12, nil, 30, 0),
      ("long empty programme fills at 10 fps", 120, 10, 30, 10),
      ("sound already there", 60, 59.95, 30, 60.0),
      ("sound adrift past the cap", 900, 899.9, 30, 0)
    ]
    let rows = cases.map { name, end, picture, rate, sound in
      let fill = ProgramEncoder.HoldFill(
        requestedEnd: end,
        lastPicture: picture,
        frameRate: rate,
        writtenSoundEnd: sound
      )
      return HoldCase(
        name: name, requestedEnd: end, lastPictureSeconds: picture, frameRate: rate,
        writtenSoundEnd: sound, pictureFillFrom: fill.pictureFrom, pictureFillStep: fill.pictureStep,
        pictureFillCount: fill.pictureCount, soundFillEnd: fill.soundEnd,
        silenceSeconds: fill.silenceSeconds, silenceCapped: fill.silenceCapped
      )
    }
    return [
      "silenceChunkSeconds": AnyEncodable(1_024.0 / 48_000.0),
      "maximumSilenceChunks": AnyEncodable(ProgramEncoder.HoldFill.maximumSilenceChunks),
      "gridFillSeconds": AnyEncodable(ProgramEncoder.HoldFill.gridFillSeconds),
      "cases": AnyEncodable(rows)
    ]
  }

  struct ResumeCase: Encodable {
    let name: String
    let takeStart: Double
    let resumedAt: Double
    let firstPictureAt: Double?
    let previousPartsSeconds: Double
  }

  private static func resumedPart() -> [String: AnyEncodable] {
    let cases: [(String, Double, Double, Double?)] = [
      ("cameras back two seconds after the resume", 1_000, 1_300, 1_302),
      ("cameras back half a minute after", 1_000, 1_300, 1_331.5),
      ("no picture before Stop keeps the resume", 1_000, 1_300, nil),
      ("a clock that stepped back never goes negative", 1_000, 990, 995)
    ]
    let rows = cases.map { name, start, resumed, first in
      ResumeCase(
        name: name,
        takeStart: start,
        resumedAt: resumed,
        firstPictureAt: first,
        previousPartsSeconds: ProgramEncoder.previousPartsSeconds(
          takeStart: start,
          partOpensAt: first ?? resumed
        )
      )
    }
    return [ "cases": AnyEncodable(rows) ]
  }

  struct PlacementCase: Encodable {
    let name: String
    let anchors: [[Double]]
    let partStarts: [String: Double]
    let plan: String
  }

  private static func exportPlacement() -> [String: AnyEncodable] {
    func anchors(part: Int, start: Double, every: Double, count: Int, jitter: Double) -> [ArchiveIndex.ProgramAnchor] {
      (0 ..< count).map {
        let seconds = Double($0) * every
        let lag = jitter * Double(($0 * 7) % 5) / 4
        return ArchiveIndex.ProgramAnchor(part: part, programSeconds: seconds, wall: WallClock(seconds: start + seconds + lag))
      }
    }
    func run(_ name: String, _ all: [ArchiveIndex.ProgramAnchor], parts: Int, resumes: Int) -> PlacementCase {
      let starts = ArchiveIndex.partStarts(all)
      let plan = ProgrammeExport.plan(
        partCount: parts,
        resumeCount: resumes,
        anchors: all,
        reading: ProgrammeExport.PartReading(firstPicture: 0, lastPictureEnd: 600, declaredEnd: 600, completed: true),
        windowStart: WallClock(seconds: starts[1]?.seconds ?? 0),
        windowEnd: WallClock(seconds: (starts[1]?.seconds ?? 0) + 600),
        frameRate: 30
      )
      let named: String
      switch plan {
      case let .copy(partStart): named = String(format: "copy from %.6f", partStart.seconds)
      case let .reencode(reason): named = "reencode: \(reason)"
      }
      return PlacementCase(
        name: name,
        anchors: all.map { [ Double($0.part), $0.programSeconds, $0.wall.seconds ] },
        partStarts: Dictionary(uniqueKeysWithValues: starts.map { (String($0.key), $0.value.seconds) }),
        plan: named
      )
    }
    let one = anchors(part: 1, start: 1_000, every: 3, count: 200, jitter: 0.04)
    let resumed = anchors(part: 1, start: 1_000, every: 3, count: 100, jitter: 0.04)
      + anchors(part: 2, start: 1_330.5, every: 3, count: 90, jitter: 0.04)
    let recovered = anchors(part: 1, start: 1_000, every: 3, count: 60, jitter: 0.02)
      + anchors(part: 2, start: 1_180, every: 3, count: 60, jitter: 0.02)
      + anchors(part: 3, start: 1_365.25, every: 3, count: 50, jitter: 0.02)
    return [
      "anchorAgreementSeconds": AnyEncodable(ArchiveIndex.anchorAgreementSeconds),
      "cases": AnyEncodable([
        run("one unbroken part copies", one, parts: 1, resumes: 0),
        run("a take resumed as part 2", resumed, parts: 2, resumes: 1),
        run("a writer recovered twice", recovered, parts: 3, resumes: 0)
      ])
    ]
  }
}

/// Lets one JSON object hold values of different types.
struct AnyEncodable: Encodable {
  private let encodeValue: (Encoder) throws -> Void

  init<Value: Encodable>(_ value: Value) {
    encodeValue = value.encode
  }

  func encode(to encoder: Encoder) throws {
    try encodeValue(encoder)
  }
}
