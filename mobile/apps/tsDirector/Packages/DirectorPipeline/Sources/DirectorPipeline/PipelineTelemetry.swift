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
  /// What the display renderer said when it failed, rather than only that it did.
  ///
  /// A failed `AVSampleBufferVideoRenderer` accepts every later enqueue and shows none of them, so
  /// the tile freezes on its last picture while arrivals keep counting -- which is exactly what a
  /// frozen board looks like from the outside. The count alone cannot tell that apart from a
  /// decoder that simply stopped producing, so the error is kept verbatim.
  public var lastRendererError: String = ""
  /// Seconds since 1970 when the renderer first reported a failure, so it can be lined up against
  /// a webcam frame or a system report without guessing.
  public var lastRendererFailureAt: Double = 0
  /// Seconds since 1970 of the last sample this tile actually handed to the display layer.
  /// A tile whose arrivals climb while this stands still is stalled after decode, not before.
  public var lastEnqueueAt: Double = 0
  /// Times the renderer asked to be flushed before it would decode again, counted separately
  /// from an outright failure because the two have different fixes.
  public var requiresFlush: UInt64 = 0
  /// Times a failed renderer was rebuilt from scratch, which is the only thing that clears one.
  public var rendererRebuilds: UInt64 = 0

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
  /// The address this row is bound to, and the address the Bonjour record was resolved to. They
  /// are the same for every camera that works; when they differ, that is why a Cameraman shows
  /// no controls, and guessing at it from the outside is impossible.
  public var endpointHost: String?
  public var advertisedHost: String?
  /// Bonjour TXT `control` for this row's camera, empty for a NearStream or an older Cameraman.
  public var controlVersion: String?
  /// One-based index of the row whose parameter channel drives this row's tile, when linked.
  public var linkedControlIndex: Int?
  /// True when this row is some other row's control link and so never gets a tile of its own.
  public var isLinkedControl = false

  public init(
    index: Int,
    name: String,
    isEnabled: Bool,
    usesAudio: Bool,
    inputGain: Double,
    isPresent: Bool,
    sourceIndex: Int?,
    endpointHost: String? = nil,
    advertisedHost: String? = nil,
    controlVersion: String? = nil,
    linkedControlIndex: Int? = nil,
    isLinkedControl: Bool = false
  ) {
    self.index = index
    self.name = name
    self.isEnabled = isEnabled
    self.usesAudio = usesAudio
    self.inputGain = inputGain
    self.isPresent = isPresent
    self.sourceIndex = sourceIndex
    self.endpointHost = endpointHost
    self.advertisedHost = advertisedHost
    self.controlVersion = controlVersion
    self.linkedControlIndex = linkedControlIndex
    self.isLinkedControl = isLinkedControl
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
  /// The camera on this tile is a TS Cameraman that answers the parameter verbs, so the tile shows
  /// the three-dot button and the phone's own thermal and battery pills.
  public var hasCameraControl = false
  /// The phone's `system.thermal` (`nominal` / `fair` / `serious` / `critical`), polled slowly.
  public var cameraThermal: String?
  /// The phone's `system.battery`, percent. Nil until the first poll, or when the phone cannot read it.
  public var cameraBatteryPercent: Int?
  public var cameraBatteryCharging = false
  /// Director's own zoom on this tile's picture, 1 for none.
  public var digitalZoom: Double = 1
  public var displayedFramesPerSecond: Double = 0
  /// Why `enqueue` returned false. Counters, not per-frame logs — a frozen tile with `out=0`
  /// is diagnosed from which of these climbed while `framesPerSecond` stayed healthy.
  public var enqueueFails = TileEnqueueFails()
  /// Times this tile was found wedged in `.replaying` and put back on live by the watchdog.
  /// Any value above zero is a bug that was survived, not a healthy recovery — the tile was
  /// showing a still while the game went on.
  public var replayWedgeRecoveries: UInt64 = 0
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
  /// How fast `packetsLost` is climbing, over the last whole second. This is the number on the
  /// tile: the cumulative count says whether the link has ever been bad, this says whether it is
  /// bad now. On an NDI tile the counter underneath is the SDK's dropped *frames*, which include
  /// our own backlog as well as the network's losses — the free SDK offers nothing finer.
  public var packetsLostPerSecond: Double = 0
  /// What the loss pill shows: the rate, or an em dash when nothing is arriving to measure.
  ///
  /// Loss is counted from gaps between packets that *arrive* (RTP sequence numbers) or from the
  /// NDI SDK's dropped-frame counters. A link that has died therefore stops moving the counter
  /// altogether and the rate folds to zero — the same zero a clean link shows, at the one moment
  /// the operator most needs to tell them apart. So a tile that is not delivering says so.
  public var lossPerSecondLabel: String {
    guard framesPerSecond > 0, stalledForSeconds == 0 else { return "—" }
    return String(format: "%.0f", packetsLostPerSecond)
  }

  /// What the camera's link is carrying, in bytes a second. RTSP counts its own socket; NDI's
  /// socket belongs to the SDK, so an NDI tile is given the Wi-Fi total less what the RTSP tiles
  /// account for, and only while it is the one NDI camera live. Nil when neither is available.
  public var receiveBytesPerSecond: Double?

  /// The tile's frame rate as the operator reads it: "60 FPS", whole frames, arrivals rather than
  /// what the screen showed. An em dash when nothing is arriving, like the loss beside it.
  public var frameRateLabel: String {
    guard framesPerSecond > 0, stalledForSeconds == 0 else { return "— FPS" }
    return String(format: "%.0f FPS", framesPerSecond)
  }

  /// What the tile's own picture is not telling the operator: that it has stopped, or that it is a
  /// still held because everything newer arrived too late to show. Nil while the picture is live.
  ///
  /// Both used to be silent. A camera that went off the network left its last picture up for two
  /// hours; one whose link backed up to five seconds had every picture refused by the display cap
  /// and froze for over a minute. Neither showed anything but the frozen picture.
  public var heldPictureLabel: String? {
    if stalledForSeconds > 0 { return "No picture \(Self.duration(stalledForSeconds))" }
    if displayHeldLateSeconds >= 1 { return "Late \(Self.duration(displayHeldLateSeconds))" }
    return nil
  }

  private static func duration(_ seconds: Double) -> String {
    seconds < 120 ? String(format: "%.0f s", seconds) : String(format: "%.0f min", seconds / 60)
  }

  /// "4 Mbps": whole megabits a second, the unit a camera's bitrate is set in. It used to be
  /// megabytes, so a 4 Mbps camera — half a megabyte a second — read 0 or 1 and looked broken.
  public var throughputLabel: String {
    guard let receiveBytesPerSecond, framesPerSecond > 0, stalledForSeconds == 0 else {
      return "— Mbps"
    }
    return String(format: "%.0f Mbps", receiveBytesPerSecond * 8 / 1_000_000)
  }

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
  /// That time split between the source's own copy of the frame and everything the pipeline does
  /// with it on the same thread. They have different owners and different fixes, and a source that
  /// looks slow is nearly always one of the two.
  public var copyMilliseconds: Double = 0
  public var publishMilliseconds: Double = 0
  /// For a source that encodes its own archive: frames encoded, frames refused because the encoder
  /// was already too far behind, and how many are waiting now. A climbing `archiveDropped` is the
  /// archive degrading deliberately so the live picture does not.
  public var archiveEncoded: UInt64 = 0
  /// Sync samples among those encodes. Every archive file opens on one, so encodes climbing while
  /// these stand still is the signature of a recording that has stopped without saying so.
  public var archiveKeyframes: UInt64 = 0
  public var archiveEncodeRefused: UInt64 = 0
  public var archiveEncoderRebuilds: UInt64 = 0
  public var archiveEncodeStatus: Int = 0
  public var decodeFailures: UInt64 = 0
  public var decoderRebuilds: UInt64 = 0
  public var decodeStatus: Int = 0
  public var reconnects: UInt64 = 0
  public var archiveDropped: UInt64 = 0
  public var archiveBacklog = 0
  /// One frame in this many reaches the archive. Above 1 the camera is recording at a fraction of
  /// its live rate on purpose, because its encoder could not sustain the full one.
  public var archiveStride = 1
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
  /// Times this camera's wall clock stepped back and its offset was re-measured from after the step.
  public var cameraClockSteps: UInt64 = 0
  /// Sound packets held back until the camera's clock reports agreed.
  public var soundAwaitingClock: UInt64 = 0
  public var correctedCaptureTime: Double = 0
  public var correctedCaptureAgeMilliseconds: Double = 0
  /// Frames that arrived after they were due, each of which was a visible stall.
  public var playoutLateFrames: UInt64 = 0
  public var playoutDepth = 0
  /// Wire codec this camera negotiated, for the operator's camera list. Known from the SDP, so it is
  /// there before the first picture is decoded.
  public var sourceCodec = ""
  /// Decoded frames dropped for a timestamp that did not advance. Climbing at the frame rate means
  /// this tile is frozen because its source timeline stopped, not because the scene is still.
  public var outOfOrderFrames: UInt64 = 0
  /// Times this camera's clock has restarted — a reboot, in practice. A discontinuity in capture
  /// times is explained by this, and a count that climbs steadily is an unstable sender rather
  /// than one that was power-cycled once.
  public var senderClockRestarts: UInt64 = 0
  /// This camera's sound on its own timeline: what the live mix is doing with it (`playing`,
  /// `fadingOut`, `silent`, `buffering`, `fadingIn`; empty while it is not mixed), how much sound
  /// waits ahead of the live mix's read head, fades into silence, silence emitted after it had been
  /// heard, timelines started (one per session or jump over a second), re-anchors (a run begun on
  /// arrival time moved once to its first capture time), steps (an error over 100 ms
  /// held for a second), gaps in its own sample count, and the clock mapping's last error against
  /// where the run lays it down. One new timeline per reconnect and no steps is a healthy camera.
  public var soundState = ""
  public var soundHeldMilliseconds: Double = 0
  public var soundFades: UInt64 = 0
  public var soundConcealedMilliseconds: Double = 0
  public var soundTimelines: UInt64 = 0
  /// Timelines a new session started; `soundTimelines` less this is the in-session ones.
  public var soundSessionTimelines: UInt64 = 0
  /// The largest error a step corrected, in milliseconds.
  public var soundLargestStepMilliseconds: Double = 0
  public var soundSteps: UInt64 = 0
  /// Runs begun on arrival time before the session's first sender report, moved once to capture.
  public var soundReanchors: UInt64 = 0
  public var soundGaps: UInt64 = 0
  public var soundErrorMilliseconds: Double = 0
  /// The drift loop's correction for this camera, in parts per million: how much faster than its
  /// own count its sound is laid down. Settles within 15 s of a new timeline; ±500 is the clamp.
  public var soundDriftPartsPerMillion: Double = 0
  /// Pictures not shown because they were older than the display cap. The monitor is worthless
  /// showing action that has already happened, so these are skipped and the last good picture
  /// stays up — and counted, because a bounded latency that reports nothing is indistinguishable
  /// from a frozen tile.
  public var displayRefusedLate: UInt64 = 0
  /// How long the tile has held its last picture because every one since was over the display cap,
  /// in seconds; zero while it is showing live pictures. The count above says pictures were
  /// refused; this says the operator is looking at a still, and for how long.
  public var displayHeldLateSeconds: Double = 0
  /// How old the newest picture was when the display gate judged it, in milliseconds — capture to
  /// presentation, including this app's own queueing. The whole feature exists because a tile was
  /// seen running two seconds behind the room, and this is the field that says so out loud.
  public var frameAgeMilliseconds: Double = 0
  /// Pictures not archived because they were older than the disk cap. Expected to stay at zero in
  /// ordinary use: the recording is watched afterwards, where a late picture is simply a picture,
  /// so this cap is the generous one and only stops a source minutes behind from writing history
  /// into the middle of a recording.
  public var diskRefusedLate: UInt64 = 0
  /// Seconds this camera has been silent past the stall timeout, or zero while it is delivering.
  ///
  /// Every other counter here describes a frame that arrived, so none of them can say that none
  /// did. A tile whose camera had rebooted read `live` at 60.4 fps while receiving nothing, and
  /// this is the field that contradicts it.
  public var stalledForSeconds: Double = 0
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
  /// Where each archive audio buffer went. After a two-minute reconnect the segment opened on the
  /// resume keyframe had video and no audio track at all, and every exit from the audio path was
  /// silent, so nothing could say which one swallowed it.
  public var audioReceived: UInt64 = 0
  public var audioRejectedNotStarted: UInt64 = 0
  /// Audio the writer refused before it could be placed — because the recording was closing or
  /// carries no audio track — and audio that could not be made into a sample buffer at all. Both
  /// used to return silently, which left "audio arrived and none was written" with no counter
  /// between the two ends to say where it went.
  public var audioRejectedClosed: UInt64 = 0
  public var audioRejectedBuild: UInt64 = 0
  public var audioRejectedPlacement: UInt64 = 0
  public var audioAppended: UInt64 = 0
  public var audioDrainNotReady: UInt64 = 0
  public var audioAppendFailed: UInt64 = 0
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
    // The number on the tile's loss pill, so a flow can assert it moved when the network did.
    parts.append(String(format: "loss=%.0f", packetsLostPerSecond))
    return parts.joined(separator: " ")
  }
}

public struct DVRTelemetry: Sendable, Codable, Equatable {
  public var isRecording = false
  /// How many times the take now rolling has been picked up again after the app stopped running,
  /// and how long it was away the last time. Both are how a flow tells a resumed take apart from
  /// a fresh one without reading the database.
  public var resumeCount: UInt64 = 0
  public var lastDowntimeSeconds: Double = 0
  /// The stream was re-dialled at launch rather than started by hand.
  public var resumedStream = false
  /// How long the last stop spent flushing archive writers. Segmented writers can take seconds to
  /// finalise, and knowing whether that is 2s or 25s is the difference between a tuning decision
  /// and a bug hunt.
  public var lastFlushSeconds = ""
  /// What the last programme finish had to work with: where the picture and the sound had reached,
  /// what length the fill was asked for, and what was still queued. A master whose sound stops short
  /// of its picture is invisible until an export months later, so the stop leaves its numbers here.
  public var lastProgramFinish = ""
  /// Filename and byte count of the last program master file, so a flow can tell the difference
  /// between "program encoding ran" and "program encoding produced a file".
  public var programOutput = ""
  /// Segments deleted by retention sweeps and the space they gave back. `segmentCount` counts
  /// segments ever written, so it cannot show that a sweep did anything.
  public var retentionSwept: UInt64 = 0
  public var retentionReclaimedBytes: UInt64 = 0
  public var recordingStartedAt: Double?
  public var segmentCount: UInt64 = 0
  /// Silent-fill activity in the archive writers. `SegmentWriter` fills audio only when a video gap
  /// longer than two seconds is corroborated by capture time, so on a healthy recording every one of
  /// these must stay zero. They did not: a 90 s take with continuous 30 fps video still wrote fill
  /// packets, which is how the fill was found running with no gap to fill. `archiveGapSeconds` was
  /// already accumulated inside the writer and had no reader, so nothing could see it.
  public var archiveFillEvents: UInt64 = 0
  public var archiveFillPackets: UInt64 = 0
  public var archiveGapSeconds: Double = 0
  public var archiveFillLastGapSeconds: Double = 0
  public var archiveFillLastCaptureGap: Double = 0
  /// Times the writer re-based its timeline because a camera's media clock went backwards or
  /// jumped somewhere real elapsed time could not corroborate — a reconnect, in practice.
  public var archiveClockRebases: UInt64 = 0
  public var archiveLastRebaseElapsedSeconds: Double = 0
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

/// What the open Cameraman control screen is showing, for dump-state.
public struct CameraControlTelemetry: Sendable, Codable, Equatable {
  public var open = false
  public var sourceIndex: Int?
  public var responding = false
  public var zoom: Double = 0
  public var position = ""
  public var thermal = ""
  public var batteryPercent: Int?
  /// What the phone says its encoder is set to, so a Settings change can be asserted on the
  /// camera's own answer rather than on the picker still showing what was tapped.
  public var codec = ""
  public var bitrateKbps = 0
  public var lastError = ""
  public var polls = 0
  public var writes = 0

  public init() {}
}

/// The stream's bitrate controller as it last decided: where the rate is in the operator's range,
/// why it last moved, and what the link was doing when it did. `dump-state` and a soak read this to
/// tell a stream that adapted from one that shed frames.
public struct StreamRateTelemetry: Sendable, Codable, Equatable {
  /// `hevc` or `h264`, empty while not streaming.
  public var codec = ""
  /// What the encoder has been told, in bits per second.
  public var bitrate = 0
  /// The operator's range; the controller moves only between these.
  public var low = 0
  public var high = 0
  /// `hold`, `emergency`, `congested`, `growing` or `increase`.
  public var lastDecision = ""
  /// The queue delay the last decision was made on: the oldest unsent write in the client, plus
  /// the kernel's standing backlog while the link is falling short.
  public var queueMilliseconds = 0
  /// What the link carried for the video over the last second; zero until a second is measured.
  public var deliveryBitsPerSecond = 0
  /// What the kernel holds on a clean link, which is flight time rather than queue.
  public var transportBaseMilliseconds = 0
  public var decreases = 0
  public var increases = 0

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
  /// How fast `composedFrames` is climbing. The Output tile shows this, because it is the rate
  /// that reads zero when every source tile is healthy and the programme picture has stopped.
  public var composedFramesPerSecond: Double = 0
  public var audioMixContributors = 0
  public var audioMixSeconds: Double = 0
  /// Mixer ring misses. `late` is audio that arrived after its slot had already been emitted —
  /// silence in the programme. `future` overran the ring the other way.
  public var audioMixLateBuffers: UInt64 = 0
  public var audioMixFutureBuffers: UInt64 = 0
  /// The recording's own mix, which waits seconds for late sound. Its `late` is sound that missed
  /// even that wait: silence in the recording.
  public var recordingMixSeconds: Double = 0
  public var recordingMixLateBuffers: UInt64 = 0
  public var recordingMixFutureBuffers: UInt64 = 0
  /// How long after capture the live mix plays each camera's sound (D): the display latency cap.
  public var liveSoundDelayMilliseconds: Double = 0
  /// Fades into silence and silence emitted in each mix, over every source.
  public var audioMixFades: UInt64 = 0
  public var audioMixConcealedSeconds: Double = 0
  public var recordingMixFades: UInt64 = 0
  public var recordingMixConcealedSeconds: Double = 0
  public var cpuPercent: Double = 0
  public var cpuCores = 0
  /// What iPadOS will still let this process allocate, which is far below physical RAM.
  public var availableMemoryMB = 0
  /// Jetsam bill, including surfaces lent to the display and encoder daemons.
  public var physFootprintMB = 0
  /// This device's own IPv4 addresses, `interface=address`. The other end of every camera link,
  /// and the one address nothing else in a dump could tell you.
  public var localAddresses: [String] = []
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
  /// The Cameraman control screen, when one is open.
  public var cameraControl = CameraControlTelemetry()
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
  /// The two staleness caps as the pipeline currently has them, zero meaning off. Reported because
  /// a refusal counter reading zero is otherwise ambiguous between a cap that is not firing and a
  /// cap that never arrived.
  public var displayLatencyCapMilliseconds: Double = 0
  public var diskLatencyCapMilliseconds: Double = 0
  /// Programme mix is actually playing through the system audio route.
  public var programAudioPlaying = false
  /// Programme RTMP publish is currently running. Distinct from `dvr.isRecording`.
  public var isStreaming = false
  /// Where the Stream button publishes: `url` or `event`, and which one, without its stream key
  /// (the URL up to its application, or the chosen game's id and title). Read before a test
  /// streams, so a test never publishes to a real team's game.
  public var streamDestination = ""
  public var streamTarget = ""
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
  /// Media tags the RTMP client shed because the socket was behind. Climbing means the uplink
  /// cannot carry the configured bitrate; a stall that reports zero here is the 2026-09-05 bug.
  public var streamDroppedPackets: UInt64 = 0
  /// Times the publish dropped, and times it was dialled again after one. A stream that ends and
  /// stays ended shows in neither the keyframe count nor the dropped-packet count — both simply
  /// stop moving — so the operator's health check needs a number that goes up when it happens.
  public var streamDisconnects: UInt64 = 0
  public var streamReconnects: UInt64 = 0
  /// Why the publish last dropped, and how long ago, so a stream that is off says why without
  /// anyone having to catch the toast.
  public var streamLastDisconnect = ""
  public var streamLastDisconnectAt: Double = 0
  /// Bytes waiting between the encoder and the socket. Pinned near the budget is a stalled peer.
  public var streamQueuedBytes = 0
  /// The stream's bitrate controller. Cleared when the stream stops.
  public var streamRate = StreamRateTelemetry()
  /// Recording or streaming, so backgrounding must not suspend the pipeline.
  public var keepAliveInBackground = false
  /// System Picture-in-Picture of the programme output is showing over other apps.
  public var pictureInPictureActive = false
  /// 1-based source numbers in visual-slot order: the cells Output leaves free, in reading order.
  public var sourceLayout = "1,2,3,4,5"
  /// The corner Output's merged cell is parked in (`ProgramCorner` raw value).
  public var outputCorner = "topLeading"

  public init() {}

  public var programSourceLabel: String {
    guard let programSource, let tile = programTile else {
      return "none"
    }
    return tile.displayName ?? "source\(programSource + 1)"
  }

  /// The tile currently on programme. Every reader of "what is on air" asks this question, and
  /// answering it in one place is what keeps a change to how programme is resolved — a slot
  /// swap, say — from having to be found again in each of them.
  public var programTile: TileTelemetry? {
    guard let programSource else { return nil }
    return tiles.first { $0.index == programSource }
  }

  /// The operator has recording engaged, as opposed to a recording that is still closing.
  ///
  /// `dvr.isRecording` stays true through the whole stop path — detaching, flushing each archive,
  /// finishing the programme, closing the index — because that path is what still owns the files.
  /// `recordingStage` leaves `idle` the instant the operator stops, so the two together separate
  /// "recording" from "stopping", which is the difference between a clock that should still be
  /// running and one that should not.
  public var isActivelyRecording: Bool {
    dvr.isRecording && recordingStage == "idle"
  }

  /// How long the take has been running, in whole seconds; zero when nothing is being recorded.
  public var recordingSeconds: Int {
    guard dvr.isRecording, let startedAt = dvr.recordingStartedAt else { return 0 }
    return max(0, Int(clockSeconds - startedAt))
  }
}

/// Lock-protected mutable telemetry. Frame-path code calls the `record…` methods from its own
/// serial queues; the UI reads `snapshot` at its own cadence. No actor hops on the frame path
/// (I6).
public final class PipelineTelemetry: @unchecked Sendable {
  private let lock = NSLock()
  private var state = TelemetrySnapshot()
  private var frameTimestamps: [Int: (count: UInt64, since: TimeInterval, last: TimeInterval)] = [:]
  private var displayedTimestamps: [Int: (count: UInt64, since: TimeInterval, last: TimeInterval)] = [:]
  private var lossRates: [Int: CounterRateTracker] = [:]
  private var byteRates: [Int: CounterRateTracker] = [:]
  private var composedRate = CounterRateTracker()
  /// Kept apart because they are counted differently, and their sum is what the HUD reports.
  private var replayDecodeSessions = 0
  private var liveDecodeSessions = 0
  private let clock: DirectorClock

  /// A clock that only moves forward, for every elapsed-time measurement in this class.
  ///
  /// The rate folds and the staleness ageing below all subtract two samples of it. Wall clock
  /// cannot answer that question: an NTP step, or an operator correcting Date & Time, moves it
  /// backwards, and a negative `elapsed` leaves every rate frozen on its last value until wall
  /// time has caught up again. This one is immune to both.
  private static func monotonicNow() -> TimeInterval {
    ProcessInfo.processInfo.systemUptime
  }

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
    let now = Self.monotonicNow()
    for index in copy.tiles.indices {
      let sourceIndex = copy.tiles[index].index
      let last = displayedTimestamps[sourceIndex]?.last ?? 0
      if now - last > 1.2 {
        copy.tiles[index].displayedFramesPerSecond = 0
      }
      // The arrival rate needs the same ageing, and for a sharper reason: it is only recomputed
      // when a frame arrives, so a source that stops delivering leaves its last healthy figure
      // standing for ever. A tile wedged by a camera reboot went on reporting 60.4 fps while
      // receiving nothing, which is precisely the reading that made a dead tile look alive.
      let lastArrival = frameTimestamps[sourceIndex]?.last ?? 0
      if now - lastArrival > 1.2 {
        copy.tiles[index].framesPerSecond = 0
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
    let lossA = lossRates[a]
    lossRates[a] = lossRates[b]
    lossRates[b] = lossA
    let bytesA = byteRates[a]
    byteRates[a] = byteRates[b]
    byteRates[b] = bytesA
  }

  /// The transport's cumulative received bytes for this tile, folded into
  /// `receiveBytesPerSecond`. Returns the rate so the caller can subtract it from the interface
  /// total when attributing the rest to an NDI tile.
  @discardableResult
  public func recordReceivedBytes(tile: Int, cumulative: UInt64) -> Double {
    let now = Self.monotonicNow()
    lock.lock()
    var tracker = byteRates[tile] ?? CounterRateTracker()
    let rate = tracker.record(cumulative, at: now)
    byteRates[tile] = tracker
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].receiveBytesPerSecond = rate
    }
    lock.unlock()
    return rate
  }

  /// A rate worked out elsewhere — the NDI tile's share of the interface — or nil to clear it.
  public func setReceiveRate(tile: Int, bytesPerSecond: Double?) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].receiveBytesPerSecond = bytesPerSecond
    }
    lock.unlock()
  }

  /// The transport's cumulative loss for this tile, as of now. Stores the count and folds it
  /// into `packetsLostPerSecond`; see `CounterRateTracker` for why a rate rather than the count.
  public func recordPacketsLost(tile: Int, cumulative: UInt64) {
    let now = Self.monotonicNow()
    lock.lock()
    var tracker = lossRates[tile] ?? CounterRateTracker()
    let rate = tracker.record(cumulative, at: now)
    lossRates[tile] = tracker
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].packetsLost = cumulative
      state.tiles[position].packetsLostPerSecond = rate
    }
    lock.unlock()
  }

  /// Forget a stopped tile's baseline, so the next pipeline on the slot is measured from its own
  /// first sample rather than against a counter that no longer exists.
  public func resetLossRate(tile: Int) {
    lock.lock()
    lossRates[tile] = nil
    byteRates[tile] = nil
    lock.unlock()
  }

  /// The compositor's frame count, as of now, folded into `composedFramesPerSecond`.
  public func recordComposedFrames(_ cumulative: UInt64) {
    let now = Self.monotonicNow()
    lock.lock()
    state.composedFrames = cumulative
    state.composedFramesPerSecond = composedRate.record(cumulative, at: now)
    lock.unlock()
  }

  public func recordReceivedFrame(tile: Int, frameID: UInt64) {
    let now = Self.monotonicNow()
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].receivedFrames += 1
      state.tiles[position].frameID = frameID
    }
    var tracker = frameTimestamps[tile] ?? (count: 0, since: now, last: now)
    tracker.count += 1
    tracker.last = now
    let elapsed = now - tracker.since
    if elapsed >= 1 {
      if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
        state.tiles[position].framesPerSecond = (Double(tracker.count) / elapsed * 10).rounded() / 10
      }
      tracker = (count: 0, since: now, last: now)
    }
    frameTimestamps[tile] = tracker
    lock.unlock()
  }

  public func recordDisplayedFrame(tile: Int) {
    let now = Self.monotonicNow()
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

  public func recordFrameAge(tile: Int, milliseconds: Double) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].frameAgeMilliseconds = milliseconds
    }
    lock.unlock()
  }

  public func recordReplayWedgeRecovery(tile: Int) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].replayWedgeRecoveries &+= 1
    }
    lock.unlock()
  }

  public func recordDisplayRefusedLate(tile: Int) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].displayRefusedLate &+= 1
    }
    lock.unlock()
  }

  public func recordDisplayHeldLate(tile: Int, seconds: Double) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].displayHeldLateSeconds = seconds
    }
    lock.unlock()
  }

  public func recordDiskRefusedLate(tile: Int) {
    lock.lock()
    if let position = state.tiles.firstIndex(where: { $0.index == tile }) {
      state.tiles[position].diskRefusedLate &+= 1
    }
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

  /// RTMP transport health, polled from the client rather than pushed per tag.
  public func recordStreamTransport(droppedPackets: UInt64, queuedBytes: Int) {
    lock.lock()
    state.streamDroppedPackets = droppedPackets
    state.streamQueuedBytes = max(0, queuedBytes)
    lock.unlock()
  }

  public func recordStreamRate(_ rate: StreamRateTelemetry) {
    lock.lock()
    state.streamRate = rate
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

  /// The publish dropped. `detail` is what the client said about it.
  public func recordStreamDisconnect(_ detail: String) {
    lock.lock()
    state.streamDisconnects += 1
    state.streamLastDisconnect = detail
    state.streamLastDisconnectAt = Date().timeIntervalSince1970
    lock.unlock()
  }

  /// The publish was dialled again after a drop.
  public func recordStreamReconnect() {
    lock.lock()
    state.streamReconnects += 1
    lock.unlock()
  }

  public func recordProgramFinish(_ detail: String) {
    lock.lock()
    state.dvr.lastProgramFinish = detail
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
    // The rate trackers hold a baseline and the last rate they folded. Left alone they would
    // publish the pre-reset figure back into the fresh snapshot on the very next poll, which is
    // exactly the stale reading a reset is asked for to get rid of.
    lossRates.removeAll()
    byteRates.removeAll()
    composedRate = CounterRateTracker()
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
