import Foundation
import DirectorCore
import DirectorSources

public enum TileState: String, Sendable, Codable {
  case empty
  case live
  case scrubbing
  case replaying
}

/// Per-tile reasons `TileRenderer.enqueue` returned false. Dumped in `/dump-state`.
public struct TileEnqueueFails: Sendable, Codable, Equatable {
  public var paused: UInt64 = 0
  public var noLayer: UInt64 = 0
  public var formatDesc: UInt64 = 0
  public var sampleBuffer: UInt64 = 0
  public var rendererFailed: UInt64 = 0
  public var lastSampleBufferStatus: Int32 = 0

  public init() {}
}

/// A discovered source as the selection list sees it, so a control-channel index can be tied back
/// to a physical camera.
public struct SourceSummary: Sendable, Codable, Equatable {
  /// One-based, matching what `/enable-source?index=` expects.
  public var index: Int
  public var name: String
  public var isEnabled: Bool
  public var usesAudio: Bool
  public var inputGain: Double
  public var isPresent: Bool
  public var sourceIndex: Int?

  public init(
    index: Int,
    name: String,
    isEnabled: Bool,
    usesAudio: Bool,
    inputGain: Double,
    isPresent: Bool,
    sourceIndex: Int?
  ) {
    self.index = index
    self.name = name
    self.isEnabled = isEnabled
    self.usesAudio = usesAudio
    self.inputGain = inputGain
    self.isPresent = isPresent
    self.sourceIndex = sourceIndex
  }
}

public struct TileTelemetry: Sendable, Codable, Equatable {
  public var index: Int
  public var sourceID: String?
  public var displayName: String?
  public var state: TileState = .empty
  public var frameID: UInt64 = 0
  /// Seconds behind live; 0 while live.
  public var offsetSeconds: Double = 0
  public var isProgram = false
  public var receivedFrames: UInt64 = 0
  public var droppedFrames: UInt64 = 0
  /// Access units copied into this camera's archive. Not "encoded": nothing re-encodes a camera's
  /// video, so this counts frames written rather than frames compressed.
  public var archivedFrames: UInt64 = 0
  /// Audio buffers received from the source. A camera that sends none leaves the archive's audio
  /// track empty, which a segmented writer will not finalise — so this is worth watching.
  public var audioFrames: UInt64 = 0
  /// Last video and audio presentation times written to the archive, in seconds from the session
  /// start. They must track each other; if audio runs away from video the muxer is being asked to
  /// span a timeline that does not exist and finalising the file will never complete.
  public var archiveVideoSeconds: Double = 0
  public var archiveAudioSeconds: Double = 0
  public var proxyStills: UInt64 = 0
  /// Height of the video going into this camera's archive, or 0 when it is not being archived.
  /// Always the camera's own height — the archive is a copy, so nothing else is possible.
  public var archiveHeight = 0
  public var isArchiving = false
  public var framesPerSecond: Double = 0
  /// Frames that actually reached this tile's display layer. `framesPerSecond` counts arrivals
  /// even while the tile is paused on a still, so it cannot tell a frozen preview from a live one.
  public var displayedFrames: UInt64 = 0
  public var displayedFramesPerSecond: Double = 0
  /// Why `enqueue` returned false. Counters, not per-frame logs — a frozen tile with `out=0`
  /// is diagnosed from which of these climbed while `framesPerSecond` stayed healthy.
  public var enqueueFails = TileEnqueueFails()
  /// What the source says it is sending, as opposed to what actually arrives. The gap between
  /// `sourceFrameRate` and the measured rate is the first thing to look at when a camera looks
  /// slow, because it separates a network problem from a pipeline one.
  public var sourceWidth = 0
  public var sourceHeight = 0
  public var sourceFrameRate: Double = 0
  public var sourcePixelFormat = ""
  public var connections = 0
  /// Video frames the SDK handed back, counted before any of our processing. Compare against
  /// `receivedFrames` to separate "the camera did not send it" from "we lost it".
  public var capturedFrames: UInt64 = 0
  public var poolMisses: UInt64 = 0
  public var formatMisses: UInt64 = 0
  /// RTP packets the camera sent that never arrived, counted from sequence-number gaps. The
  /// difference between a camera that is struggling and a link that is losing its traffic.
  public var packetsLost: UInt64 = 0
  /// Why this source last stopped delivering, in the words of whatever noticed. Empty while healthy.
  public var sourceStatus = ""
  /// The `CNAME` this camera presents, empty for the cameras that present none. Worth surfacing
  /// because a tile bound to the wrong camera and a tile bound to the right one look identical
  /// until you can see which identifier the stream is actually carrying.
  public var cname = ""
  /// Share of the receive thread's time spent blocked waiting on the network, 0-1. Near 1 means the
  /// loop is starved for frames; well below 1 means our own work on that thread is the limit.
  public var receiveWaitFraction: Double = 0
  /// Mean milliseconds spent downstream of capture per frame, on the receive thread.
  public var deliveryMilliseconds: Double = 0
  /// The last complete second's worst frame timing: how late the latest frame was, whether that late
  /// frame was a keyframe, and the longest one frame spent in our own decode-and-deliver work. A
  /// stutter the operator can see is one of these two numbers, and which one says whose fault it is.
  public var arrivalGapMaxMilliseconds: Double = 0
  public var arrivalGapWasKeyframe = false
  public var deliverMaxMilliseconds: Double = 0
  /// The smoothing buffer this camera would need for a preview that never stalls: the spread between
  /// its least and most late frame over the last ten seconds.
  public var pacingSpreadMilliseconds: Double = 0
  /// The same widest gap measured on the way out of the delay line rather than off the wire. This is
  /// what the screen shows, so it is the number that says whether the buffer worked.
  public var releaseGapMaxMilliseconds: Double = 0
  /// How much video the delay line is holding, in milliseconds — the monitor latency being paid.
  public var playoutMilliseconds: Double = 0
  /// The camera's RTCP sender-report clock audit. Measurement only — see `ReceiveStats`.
  public var senderReports: UInt64 = 0
  public var senderReportIntervalSeconds: Double = 0
  public var senderReportAgeSeconds: Double = 0
  public var senderReportStreams: Int = 0
  public var mediaTicksPerSecond: Double = 0
  public var mediaClockSpanSeconds: Double = 0
  public var cameraClockOffsetSeconds: Double = 0
  public var cameraClockOffsetFilteredSeconds: Double = 0
  public var cameraClockOffsetSamples: Int = 0
  public var correctedCaptureTime: Double = 0
  public var correctedCaptureAgeMilliseconds: Double = 0
  /// The one delay every camera is scheduled against. Zero means this camera is still on the
  /// per-camera fallback because it has no corrected capture time yet.
  public var sharedDelayMilliseconds: Double = 0
  /// Frames that arrived after they were due, each of which was a visible stall.
  public var playoutLateFrames: UInt64 = 0
  public var playoutDepth = 0
  /// Wire codec this camera negotiated, for the operator's camera list. Known from the SDP, so it is
  /// there before the first picture is decoded.
  public var sourceCodec = ""
  /// Decoded frames dropped for a timestamp that did not advance. Climbing at the frame rate means
  /// this tile is frozen because its source timeline stopped, not because the scene is still.
  public var outOfOrderFrames: UInt64 = 0
  /// How often the archive had to re-anchor audio to video, and by how much it had drifted. A
  /// non-zero count means this camera's audio clock does not advance at the same rate as its video
  /// clock, which is what stalls the muxer if left alone.
  public var audioResyncs: UInt64 = 0
  public var lastAudioDrift: Double = 0
  /// True once this source's audio clock was rejected as unusable and timing fell back to counting
  /// samples. Distinguishes "this camera's clock is broken" from "this camera is losing buffers".
  public var audioClockRejected = false
  /// Whether this source's audio is being summed into the programme mix.
  public var contributesAudio = false
  /// R6: milliseconds from the scrub gesture ending to the first replayed frame reaching the tile.
  /// Zero until a replay has run on this tile.
  public var replayLatencyMilliseconds: Double = 0
  /// Audio thrown away because the writer stopped consuming for long enough to overrun the queue.
  /// Any non-zero value means the archive is already compromised.
  public var audioBuffersDiscarded: UInt64 = 0
  /// Why this camera's archive stopped, if it did. Kept per tile so one camera's failure is not
  /// overwritten by another's.
  public var lastError: String?

  public init(index: Int) {
    self.index = index
  }

  /// The compact string exposed as the tile's accessibility value. Maestro asserts on
  /// substrings of this, so the shape is part of the contract in plan §6.6.
  ///
  /// The tile number leads because the runner ignores a selector's `text` when an `id` is also
  /// given: assertions have to match on text alone, and without the number in the string
  /// "tile 2 is live" cannot be distinguished from "some tile is live".
  public var accessibilityValue: String {
    var parts = [ "source=\(index + 1)", "state=\(state.rawValue)" ]
    parts.append("src=\(displayName ?? "none")")
    parts.append("f=\(frameID)")
    parts.append(String(format: "off=%.1f", offsetSeconds))
    parts.append("onair=\(isProgram ? "1" : "0")")
    // The height on disk, so a flow can assert that the archive really is the camera's own
    // resolution rather than trusting that nothing downscaled it.
    parts.append("arch=\(archiveHeight)")
    parts.append(String(format: "out=%.0f", displayedFramesPerSecond))
    // `k` marks a gap that ended on a keyframe, which is the camera's pacing rather than ours.
    parts.append(String(
      format: "gap=%.0f%@",
      arrivalGapMaxMilliseconds,
      arrivalGapWasKeyframe ? "k" : ""
    ))
    parts.append(String(format: "dlv=%.0f", deliverMaxMilliseconds))
    parts.append(String(format: "buf=%.0f", pacingSpreadMilliseconds))
    // What the delay line is holding and what the screen got for it. `rel` staying near one frame
    // interval while `gap` spikes is the buffer doing its job; `late` climbing means it is too
    // small and the picture is stalling.
    parts.append(String(format: "pl=%.0f", playoutMilliseconds))
    parts.append(String(format: "rel=%.0f", releaseGapMaxMilliseconds))
    parts.append("late=\(playoutLateFrames)")
    return parts.joined(separator: " ")
  }
}

public struct DVRTelemetry: Sendable, Codable, Equatable {
  public var isRecording = false
  /// How long the last stop spent flushing archive writers. Segmented writers can take seconds to
  /// finalise, and knowing whether that is 2s or 25s is the difference between a tuning decision
  /// and a bug hunt.
  public var lastFlushSeconds = ""
  /// Filename and byte count of the last program master file, so a flow can tell the difference
  /// between "program encoding ran" and "program encoding produced a file".
  public var programOutput = ""
  /// Segments deleted by retention sweeps and the space they gave back. `segmentCount` counts
  /// segments ever written, so it cannot show that a sweep did anything.
  public var retentionSwept: UInt64 = 0
  public var retentionReclaimedBytes: UInt64 = 0
  public var recordingStartedAt: Double?
  public var segmentCount: UInt64 = 0
  public var byteCount: UInt64 = 0
  public var proxyStills: UInt64 = 0
  public var indexWrites: UInt64 = 0
  public var freeDiskBytes: Int64 = 0
  public var lastError: String?
  /// UITest export of a stopped take into Prepared/. Distinct from recording so a harness can poll.
  public var isExporting = false
  public var lastExportRecordingID: Int64?
  public var lastExportFiles: [String] = []
  public var lastExportError: String?

  public init() {}
}

public struct SessionTelemetry: Sendable, Codable, Equatable {
  public var encodeSessions: Int = 0
  public var decodeSessions: Int = 0
  public var encodeFailures: Int = 0
  public var lastEncodeErrorCode: Int32?

  public init() {}
}

public struct ConverterTelemetry: Sendable, Codable, Equatable {
  public var convertedFrames: UInt64 = 0
  public var passthroughFrames: UInt64 = 0
  public var failedFrames: UInt64 = 0
  public var averageMilliseconds: Double = 0

  public init() {}
}

/// Everything the HUD, the accessibility values and the JSON dump read. One snapshot type, one
/// director — a Maestro assertion therefore observes production state rather than a test-only
/// shadow copy.
public struct TelemetrySnapshot: Sendable, Codable, Equatable {
  public var generatedAt: Double = 0
  public var clockSeconds: Double = 0
  public var sourceProfile: String = ""
  public var tiles: [TileTelemetry] = SourceIndex.all.map { TileTelemetry(index: $0.value) }
  public var dvr = DVRTelemetry()
  public var sessions = SessionTelemetry()
  public var converter = ConverterTelemetry()
  public var thermalState: String = "nominal"
  /// Seconds the device has spent asleep this session. Frame lateness is measured against a clock
  /// that stops during sleep, so a sleep drops the trailing minimum of `lateness` by its whole
  /// duration — the only mechanism that can put a playout offset far beyond its own cap. Nonzero
  /// here is that evidence; zero over a long session rules it out.
  public var sleptSeconds: Double = 0
  /// Spread of corrected capture times across the **newest received** frame of each live camera.
  ///
  /// **Not an acceptance measure, and it must not be read as one.** It samples what has arrived,
  /// not what is being composited, so it stays small while the screen is wrong: it read 29 ms
  /// during a run where a stopwatch in front of the tiles showed 2.81 s. Useful for spotting one
  /// camera whose delivery has diverged; useless for judging alignment.
  ///
  /// Alignment is judged by pointing every camera at a millisecond timecode display and reading
  /// the recorded frames — the plan's §8.1. A composited-frame spread would be the right telemetry
  /// and does not exist yet.
  public var captureSpreadMilliseconds: Double = 0
  /// Which camera is furthest behind the rest, so the spread points at something actionable.
  public var captureSpreadWorstCamera: String = ""

  /// Share of the whole machine's CPU this process is using. Separates "the network is not
  /// delivering frames" from "we have run out of CPU to decode them", which frame counters alone
  /// cannot distinguish.
  /// How many sources are feeding the programme audio mix, and how much mixed audio it has
  /// produced. Both are needed to tell "nobody is selected" apart from "the mix is stalled".
  /// Overlay snapshot status, or empty when none are loaded.
  public var overlay = ""
  /// Frames the compositor has produced, which is how an overlay that loaded but never reached the
  /// picture is told apart from one that never loaded.
  public var composedFrames: UInt64 = 0
  public var audioMixContributors = 0
  public var audioMixSeconds: Double = 0
  /// Mixer ring misses. `late` is audio that arrived after its slot had already been emitted —
  /// silence in the programme. `future` overran the ring the other way.
  public var audioMixLateBuffers: UInt64 = 0
  public var audioMixFutureBuffers: UInt64 = 0
  public var cpuPercent: Double = 0
  public var cpuCores = 0
  /// What iPadOS will still let this process allocate, which is far below physical RAM.
  public var availableMemoryMB = 0
  /// Jetsam bill, including surfaces lent to the display and encoder daemons.
  public var physFootprintMB = 0
  /// Anonymous resident pages. A soak that only watches `physFootprintMB` can miss a malloc climb.
  public var residentSizeMB = 0
  public var programSource: Int?
  /// Whether this session is on real cameras rather than generated or file-backed ones.
  public var sourceAvailable = false
  public var discoveredSourceCount = 0
  /// Diagnostic from `SourceDiscovery.diagnostic`, empty for synthetic sources.
  public var discoveryStatus = ""
  /// One entry per selection, in the order the control channel indexes them (one-based over the
  /// wire). Without this a source that advertises but never sends a frame is anonymous, and there
  /// is no way to tell which physical camera an index refers to.
  public var sources: [SourceSummary] = []
  /// Port and reachable addresses of the UI-test control server, empty when it is not running.
  public var controlServer = ""
  /// The message shown to the operator. Mirrored here so automation can read the same sentence
  /// the user sees rather than an approximation of it.
  public var statusMessage = ""
  /// Last replay failure, kept even when the banner is later overwritten by another message.
  public var lastReplayError = ""
  /// What the last replay was actually given to play: how much history was available, how far back it
  /// was asked to go, and how many archive files that turned into. A replay that ends early ran out
  /// of one of these, and without them the difference is invisible.
  public var lastReplayAssembly = ""
  /// The last lifecycle step the recording path completed. A recording that will not stop is
  /// otherwise indistinguishable from one that stopped without saying so.
  public var recordingStage = "idle"
  /// Result of the most recent encode-session probe, empty until one has been run.
  public var encodeProbe = ""
  /// Delay the live preview is currently holding, in milliseconds — the engine's choice, already
  /// clamped by the operator cap when one is on.
  public var displayLatencyMilliseconds: Double = 0
  /// Programme mix is actually playing through the system audio route.
  public var programAudioPlaying = false
  /// Programme RTMP publish is currently running. Distinct from `dvr.isRecording`.
  public var isStreaming = false
  /// IDRs actually emitted on the RTMP encode, not camera keyframes.
  public var streamKeyframeCount: UInt64 = 0
  /// Seconds since the last RTMP IDR. HLS stalls when this climbs past `gopSeconds`.
  public var streamKeyframeAgeSeconds: Double = 0
  /// Frames currently in flight in VideoToolbox.
  public var streamPendingEncodes = 0
  /// Seconds since the last VideoToolbox output callback. Zero until one has arrived.
  public var streamEncodeCallbackAgeSeconds: Double = 0
  /// Seconds since the last real program frame reached the RTMP encoder. Idle IDRs do not count.
  public var programFrameAgeSeconds: Double = 0
  /// IDRs the GOP watchdog forced by repeating the last program picture.
  public var streamIdleKeyframeCount: UInt64 = 0
  /// Times the RTMP compression session was invalidated because callbacks went silent.
  public var streamEncoderResetCount: UInt64 = 0
  /// Recording or streaming, so backgrounding must not suspend the pipeline.
  public var keepAliveInBackground = false
  /// System Picture-in-Picture of the programme output is showing over other apps.
  public var pictureInPictureActive = false
  /// 1-based source numbers in visual-slot order (top-right, mid-right, then the bottom row).
  public var sourceLayout = "1,2,3,4,5"

  public init() {}

  public var programSourceLabel: String {
    guard let programSource, let tile = tiles.first(where: { $0.index == programSource }) else {
      return "none"
    }
    return tile.displayName ?? "source\(programSource + 1)"
  }
}

/// Lock-protected mutable telemetry. Frame-path code calls the `record…` methods from its own
/// serial queues; the UI reads `snapshot` at its own cadence. No actor hops on the frame path
/// (I6).
public final class PipelineTelemetry: @unchecked Sendable {
  private let lock = NSLock()
  private var state = TelemetrySnapshot()
  private var frameTimestamps: [Int: (count: UInt64, since: CFAbsoluteTime)] = [:]
  private var displayedTimestamps: [Int: (count: UInt64, since: CFAbsoluteTime, last: CFAbsoluteTime)] = [:]
  /// Kept apart because they are counted differently, and their sum is what the HUD reports.
  private var replayDecodeSessions = 0
  private var liveDecodeSessions = 0
  private let clock: DirectorClock

  public init(clock: DirectorClock = SystemClock()) {
    self.clock = clock
  }

  public var snapshot: TelemetrySnapshot {
    lock.lock()
    defer { lock.unlock() }
    var copy = state
    copy.generatedAt = Date().timeIntervalSince1970
    copy.clockSeconds = clock.now.seconds
    copy.thermalState = Self.thermalStateName(ProcessInfo.processInfo.thermalState)
    copy.sleptSeconds = Self.sleptSeconds()
    copy.dvr.freeDiskBytes = DirectorPaths.freeDiskBytes()
    let now = CFAbsoluteTimeGetCurrent()
    for index in copy.tiles.indices {
      let sourceIndex = copy.tiles[index].index
      let last = displayedTimestamps[sourceIndex]?.last ?? 0
      if now - last > 1.2 {
        copy.tiles[index].displayedFramesPerSecond = 0
      }
    }
    return copy
  }

  public func mutate(_ body: (inout TelemetrySnapshot) -> Void) {
    lock.lock()
    body(&state)
    lock.unlock()
  }

  public func mutateTile(_ index: Int, _ body: (inout TileTelemetry) -> Void) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == index }) {
      body(&state.tiles[position])
    }
    lock.unlock()
  }

  /// Slot `a` and slot `b` exchange telemetry (index numbers stay with the slot).
  public func swapSlots(_ a: Int, _ b: Int) {
    guard a != b else { return }
    lock.lock()
    defer { lock.unlock() }
    guard
      let ia = state.tiles.firstIndex(where: { $0.index == a }),
      let ib = state.tiles.firstIndex(where: { $0.index == b })
    else { return }
    var first = state.tiles[ia]
    var second = state.tiles[ib]
    swap(&first, &second)
    first.index = a
    second.index = b
    state.tiles[ia] = first
    state.tiles[ib] = second
    if state.programSource == a {
      state.programSource = b
    } else if state.programSource == b {
      state.programSource = a
    }
    let frameA = frameTimestamps[a]
    frameTimestamps[a] = frameTimestamps[b]
    frameTimestamps[b] = frameA
    let displayedA = displayedTimestamps[a]
    displayedTimestamps[a] = displayedTimestamps[b]
    displayedTimestamps[b] = displayedA
  }

  public func recordReceivedFrame(tile: Int, frameID: UInt64) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].receivedFrames += 1
      state.tiles[position].frameID = frameID
    }
    var tracker = frameTimestamps[tile] ?? (count: 0, since: now)
    tracker.count += 1
    let elapsed = now - tracker.since
    if elapsed >= 1 {
      if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
        state.tiles[position].framesPerSecond = (Double(tracker.count) / elapsed * 10).rounded() / 10
      }
      tracker = (count: 0, since: now)
    }
    frameTimestamps[tile] = tracker
    lock.unlock()
  }

  public func recordDisplayedFrame(tile: Int) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].displayedFrames += 1
    }
    var tracker = displayedTimestamps[tile] ?? (count: 0, since: now, last: now)
    tracker.count += 1
    tracker.last = now
    let elapsed = now - tracker.since
    if elapsed >= 1 {
      if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
        state.tiles[position].displayedFramesPerSecond =
          (Double(tracker.count) / elapsed * 10).rounded() / 10
      }
      tracker = (count: 0, since: now, last: now)
    }
    displayedTimestamps[tile] = tracker
    lock.unlock()
  }

  public func recordDroppedFrame(tile: Int, count: UInt64 = 1) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].droppedFrames += count
    }
    lock.unlock()
  }

  public func recordArchivedFrame(tile: Int) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].archivedFrames += 1
    }
    lock.unlock()
  }

  public func recordProxyStill(tile: Int) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].proxyStills += 1
    }
    state.dvr.proxyStills += 1
    lock.unlock()
  }

  public func recordSegment(bytes: UInt64) {
    lock.lock()
    state.dvr.segmentCount += 1
    state.dvr.byteCount += bytes
    state.dvr.indexWrites += 1
    lock.unlock()
  }

  public func recordConverter(_ statistics: PixelConverter.Statistics) {
    lock.lock()
    state.converter = ConverterTelemetry(
      convertedFrames: statistics.convertedFrames,
      passthroughFrames: statistics.passthroughFrames,
      failedFrames: statistics.failedFrames,
      averageMilliseconds: (statistics.averageMilliseconds * 100).rounded() / 100
    )
    lock.unlock()
  }

  public func recordEncodeSessionChange(delta: Int) {
    lock.lock()
    state.sessions.encodeSessions = max(0, state.sessions.encodeSessions + delta)
    lock.unlock()
  }

  public func recordStreamKeyframe(ageSeconds: Double) {
    lock.lock()
    state.streamKeyframeCount += 1
    state.streamKeyframeAgeSeconds = ageSeconds
    lock.unlock()
  }

  public func recordStreamKeyframeAge(_ seconds: Double) {
    lock.lock()
    state.streamKeyframeAgeSeconds = (seconds * 10).rounded() / 10
    lock.unlock()
  }

  public func recordStreamPendingEncodes(_ count: Int) {
    lock.lock()
    state.streamPendingEncodes = max(0, count)
    lock.unlock()
  }

  public func recordStreamEncodeCallbackAge(_ seconds: Double) {
    lock.lock()
    state.streamEncodeCallbackAgeSeconds = (seconds * 10).rounded() / 10
    lock.unlock()
  }

  public func recordProgramFrameAge(_ seconds: Double) {
    lock.lock()
    state.programFrameAgeSeconds = (seconds * 10).rounded() / 10
    lock.unlock()
  }

  public func recordStreamIdleKeyframe() {
    lock.lock()
    state.streamIdleKeyframeCount += 1
    lock.unlock()
  }

  public func recordStreamEncoderReset() {
    lock.lock()
    state.streamEncoderResetCount += 1
    lock.unlock()
  }

  public func recordDecodeSessionChange(delta: Int) {
    lock.lock()
    replayDecodeSessions = max(0, replayDecodeSessions + delta)
    state.sessions.decodeSessions = replayDecodeSessions + liveDecodeSessions
    lock.unlock()
  }

  /// Live cameras count their decoders by reporting how many they hold, not by announcing changes:
  /// a session that dies with its socket has no opportunity to say so.
  public func recordLiveDecodeSessions(_ count: Int) {
    lock.lock()
    liveDecodeSessions = max(0, count)
    state.sessions.decodeSessions = replayDecodeSessions + liveDecodeSessions
    lock.unlock()
  }

  public func recordEncodeFailure(code: Int32) {
    lock.lock()
    state.sessions.encodeFailures += 1
    state.sessions.lastEncodeErrorCode = code
    lock.unlock()
  }

  public func recordError(_ message: String) {
    lock.lock()
    state.dvr.lastError = message
    lock.unlock()
  }

  public func reset() {
    lock.lock()
    let profile = state.sourceProfile
    let sourceAvailable = state.sourceAvailable
    state = TelemetrySnapshot()
    state.sourceProfile = profile
    state.sourceAvailable = sourceAvailable
    frameTimestamps.removeAll()
    displayedTimestamps.removeAll()
    lock.unlock()
  }

  /// Seconds this process has spent with the device asleep.
  ///
  /// `CLOCK_MONOTONIC_RAW` counts through sleep; `CLOCK_UPTIME_RAW` stops. Both advance together
  /// while awake, so the gap that opens between them is exactly the time slept. Measured against a
  /// baseline taken at first call, because a process launched after a sleep would otherwise inherit
  /// the device's entire prior uptime as its own.
  ///
  /// Frame lateness is measured against the uptime clock, so a sleep drops the trailing minimum of
  /// `lateness` by its whole duration — the only mechanism that can put a playout offset far beyond
  /// its own cap. Nonzero here is that evidence; zero over a long session rules it out.
  private static let clockBaseline: (continuous: UInt64, uptime: UInt64) = (
    clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW),
    clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
  )

  private static func sleptSeconds() -> Double {
    let continuousDelta = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) &- clockBaseline.continuous
    let uptimeDelta = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) &- clockBaseline.uptime
    guard continuousDelta > uptimeDelta else { return 0 }
    return Double(continuousDelta - uptimeDelta) / 1_000_000_000
  }

  public static func thermalStateName(_ thermalState: ProcessInfo.ThermalState) -> String {
    switch thermalState {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
  }
}

private extension DVRTelemetry {
  init(isRecording: Bool) {
    self.init()
    self.isRecording = isRecording
  }
}

private extension ConverterTelemetry {
  init(
    convertedFrames: UInt64,
    passthroughFrames: UInt64,
    failedFrames: UInt64,
    averageMilliseconds: Double
  ) {
    self.init()
    self.convertedFrames = convertedFrames
    self.passthroughFrames = passthroughFrames
    self.failedFrames = failedFrames
    self.averageMilliseconds = averageMilliseconds
  }
}
