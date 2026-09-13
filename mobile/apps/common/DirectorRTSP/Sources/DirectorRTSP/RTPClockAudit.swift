import Foundation

/// Measures what a camera's RTCP sender reports say about its clock.
///
/// The playout path times frames as `iPad uptime - unwrapped RTP ticks / 90000`. Those two counters
/// share no origin and are driven by different crystals, so that difference is not a delay: it is an
/// arbitrary constant plus whatever the two oscillators disagree about. A sender report is the only
/// thing on the wire that fixes this — it pairs the sender's own NTP wall clock with the RTP
/// timestamp at that same instant (RFC 3550 §6.4).
///
/// This type does not change playout. It answers three questions that decide whether it could:
///
/// 1. Do the cameras send sender reports at all, and how often?
/// 2. Does each camera's media clock run at its nominal rate against real time? `ticksPerSecond`
///    away from 90000 by a part in ten thousand is 8.6 seconds of drift a day, which the delay line
///    would chase for as long as the session lasts.
/// 3. Do the cameras agree with each other about what time it is? Aligning tiles on an absolute
///    timeline only works if they do; comparing each camera's `ntpOffsetSeconds` says whether they
///    could be trusted to.
///
/// Rates are accumulated across reports rather than measured from the first one, so a session that
/// outlives the 32-bit RTP field keeps counting.
struct RTPClockAudit: Sendable {
  /// Per-SSRC running totals. A compound report carries one of these per stream, so video and audio
  /// are tracked apart without needing to know which channel carried them: video moves far more
  /// bytes, which is what picks it out below.
  private struct Track {
    var lastRTPTimestamp: UInt32
    var lastNTPSeconds: Double
    var accumulatedTicks: UInt64 = 0
    var accumulatedSeconds: Double = 0
    var octetCount: UInt32
    var reports: UInt64 = 1
  }

  /// Half the 32-bit circle. A step shorter than this is the clock advancing; anything longer is a
  /// repeat or a reorder, not a jump of four billion ticks.
  private static let half = UInt64(1) << 31

  /// One offset observation: what the camera said, less our own clock, and how long the report
  /// spent in flight as far as we can tell.
  private struct OffsetSample {
    let atUptime: Double
    let offset: Double
  }

  private var tracks: [UInt32: Track] = [:]
  /// The stream the offset is measured from: the busiest, which is the video. A camera that also
  /// reports on its audio sends those reports on their own, and their capture times need not agree
  /// with the picture's to the millisecond; letting them into a window that keeps its maximum
  /// would let the audio's clock move where every picture is placed.
  private var offsetSSRC: UInt32?
  private var lastArrivalUptime: Double?
  private var intervalTotal: Double = 0
  private var intervalSamples: UInt64 = 0
  /// Rolling window of offset observations, kept so the estimate can be the minimum rather than the
  /// latest. See `filteredOffsetSeconds`.
  private var offsetSamples: [OffsetSample] = []
  private static let offsetWindowSeconds: Double = 600
  /// An offset larger than this is a camera whose clock was never set, not a camera in another
  /// time zone. A NearStream ships without an NTP client and reports whatever it powered up
  /// believing; correcting by that would anchor every one of its segments decades from the rest of
  /// the take and place a perfectly good angle nowhere near the game. Beyond this we decline to
  /// answer, and the writer falls back to arrival time -- which is late, but is at least today.
  ///
  /// Matches the guard the NDI receive clock applies to the same question.
  static let maximumClockSkewSeconds: Double = 3_600

  /// Sender reports seen on this connection. Zero after a minute of video means this camera sends
  /// none, and an absolute timeline is not available from it.
  private(set) var reportCount: UInt64 = 0
  /// The sender's wall clock minus ours, at the moment its last report arrived. Includes one-way
  /// transit, which is milliseconds; anything larger is genuine disagreement between the clocks.
  private(set) var ntpOffsetSeconds: Double = 0
  /// Uptime when the last report landed, so staleness can be reported rather than inferred.
  private(set) var lastReportUptime: Double = 0

  /// The offset to actually correct with: the **largest** observation in the window.
  ///
  /// A report's observed offset is the camera's clock less ours, *plus* however long the report
  /// spent in flight — and flight time only ever makes the value smaller. The least-delayed report
  /// in the window is therefore the one closest to the true clock difference, and taking the
  /// maximum is minimum-delay filtering expressed in this sign convention.
  ///
  /// This is what stops a congested spell from being mistaken for a clock change. Without it the
  /// estimate follows the delay, silently cancelling the lateness it was supposed to reveal: a
  /// 500 ms send-side hold moved the unfiltered value 0.45 s, which would have made injected
  /// lateness invisible to the very tests meant to catch it.
  var filteredOffsetSeconds: Double {
    offsetSamples.map(\.offset).max() ?? ntpOffsetSeconds
  }

  /// How many observations the filtered value rests on. One sample is not a filter.
  var offsetSampleCount: Int { offsetSamples.count }

  /// The most recent (wall clock, RTP tick) pair for one specific stream.
  ///
  /// This is the whole point of a sender report: one instant where a camera says what its media
  /// clock read and what time it was. Every frame's capture time is that anchor plus the tick
  /// difference, so the arbitrary origin of the RTP counter cancels out.
  ///
  /// The SSRC must be the caller's own stream. Picking the busiest one instead works only once
  /// enough bytes have flowed to tell video from audio, and before that it silently pairs a video
  /// frame with the audio stream's anchor — different clock rate, so the tick arithmetic produces a
  /// capture time hours out. Measured: 5.5 hours, which is the signed tick range over 90 kHz.
  func anchor(forSSRC ssrc: UInt32) -> (ntpSeconds: Double, rtpTimestamp: UInt32)? {
    guard let track = tracks[ssrc] else { return nil }
    return (track.lastNTPSeconds, track.lastRTPTimestamp)
  }

  /// When a frame carrying `rtpTimestamp` was captured, on **our** clock.
  ///
  /// The anchor puts it on the camera's wall clock; subtracting the filtered offset moves it onto
  /// ours. Correcting onto our own clock rather than trusting the camera's is what makes cameras
  /// that disagree with each other by seconds — measured: a 2.15 s spread — line up anyway.
  ///
  /// The tick difference is taken as a signed 32-bit quantity so a frame slightly older than the
  /// anchor reads as negative rather than as most of a rollover.
  func captureTimeOnLocalClock(rtpTimestamp: UInt32, ssrc: UInt32, clockRate: Double = 90_000) -> Double? {
    guard let anchor = anchor(forSSRC: ssrc), clockRate > 0 else { return nil }
    let offset = filteredOffsetSeconds
    guard abs(offset) <= Self.maximumClockSkewSeconds else { return nil }
    let ticks = Int32(bitPattern: rtpTimestamp &- anchor.rtpTimestamp)
    let cameraWall = anchor.ntpSeconds + Double(ticks) / clockRate
    return cameraWall - offset
  }

  /// Mean seconds between sender reports.
  var meanIntervalSeconds: Double {
    intervalSamples > 0 ? intervalTotal / Double(intervalSamples) : 0
  }

  /// The busiest stream's measured media-clock rate, in ticks per real second. Video should sit at
  /// 90000 and audio at its sample rate; the distance from nominal is the drift the delay line is
  /// currently mistaking for lateness.
  var ticksPerSecond: Double {
    guard let track = dominantTrack, track.accumulatedSeconds > 0 else { return 0 }
    return Double(track.accumulatedTicks) / track.accumulatedSeconds
  }

  /// Real seconds spanned by the rate measurement, so a ratio taken over two reports is not read
  /// with the same confidence as one taken over ten minutes.
  var measuredSpanSeconds: Double { dominantTrack?.accumulatedSeconds ?? 0 }

  /// Distinct streams reporting. Two means video and audio are both timestamped and could be put on
  /// one timeline against each other.
  var streamCount: Int { tracks.count }

  private var dominantTrack: Track? {
    tracks.values.max { $0.octetCount < $1.octetCount }
  }

  /// Folds one compound report in. `arrivalUptime` is the same monotonic clock the playout path
  /// uses; `wallClockNow` is our own notion of the time, for the offset comparison.
  mutating func note(report: RTCPReport, arrivalUptime: Double, wallClockNow: Date) {
    guard !report.senderReports.isEmpty else { return }
    reportCount &+= 1

    if let previous = lastArrivalUptime {
      intervalTotal += max(0, arrivalUptime - previous)
      intervalSamples &+= 1
    }
    lastArrivalUptime = arrivalUptime
    lastReportUptime = arrivalUptime

    for sender in report.senderReports {
      let ntpSeconds = sender.ntpDate.timeIntervalSince1970

      guard var track = tracks[sender.ssrc] else {
        tracks[sender.ssrc] = Track(
          lastRTPTimestamp: sender.rtpTimestamp,
          lastNTPSeconds: ntpSeconds,
          octetCount: sender.octetCount
        )
        continue
      }

      // Unsigned wrap-around difference, then rejected if it is the long way round: a camera that
      // repeats or reorders a timestamp must not read as having jumped half a circle forward.
      let step = UInt64(sender.rtpTimestamp &- track.lastRTPTimestamp)
      let elapsed = ntpSeconds - track.lastNTPSeconds
      if step < Self.half, elapsed > 0 {
        track.accumulatedTicks &+= step
        track.accumulatedSeconds += elapsed
      }
      track.lastRTPTimestamp = sender.rtpTimestamp
      track.lastNTPSeconds = ntpSeconds
      track.octetCount = sender.octetCount
      track.reports &+= 1
      tracks[sender.ssrc] = track
    }

    // The offset is taken from the busiest stream only. A report without it, such as the audio's
    // own, anchors its stream above and leaves the offset alone.
    let busiest = tracks.max { $0.value.octetCount < $1.value.octetCount }?.key
    if busiest != offsetSSRC {
      offsetSSRC = busiest
      offsetSamples.removeAll()
    }
    if let busiest, let primary = report.senderReports.first(where: { $0.ssrc == busiest }) {
      let observed = primary.ntpDate.timeIntervalSince1970 - wallClockNow.timeIntervalSince1970
      ntpOffsetSeconds = observed
      offsetSamples.append(OffsetSample(atUptime: arrivalUptime, offset: observed))
      let cutoff = arrivalUptime - Self.offsetWindowSeconds
      offsetSamples.removeAll { $0.atUptime < cutoff }
    }
  }

  /// A reconnect gives the camera a new timeline and possibly a new SSRC, so nothing measured
  /// against the old one carries over.
  mutating func reset() {
    tracks.removeAll()
    offsetSSRC = nil
    offsetSamples.removeAll()
    lastArrivalUptime = nil
    intervalTotal = 0
    intervalSamples = 0
    reportCount = 0
    ntpOffsetSeconds = 0
    lastReportUptime = 0
  }
}
