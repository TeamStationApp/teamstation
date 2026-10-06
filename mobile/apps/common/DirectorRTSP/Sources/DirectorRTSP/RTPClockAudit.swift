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
    /// The last time this stream's own NTP/RTP pairing moved: a report whose wall clock is not
    /// where its RTP ticks, at the rate measured so far, put it. That is the camera's clock
    /// stepping, and only that: a report held up on the way still pairs its two clocks correctly.
    var lastRelationJump: (atUptime: Double, seconds: Double)?
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
  /// When every report started reading more than `stepThresholdSeconds` below the filtered offset:
  /// the camera's clock stepped back, or its reports are being delayed. Held for
  /// `stepHoldSeconds`, it is the clock: transit spikes come and go, a clock step stays.
  private var lowSince: Double?
  /// A camera's wall clock stepping back by more than this is adopted once it has held for
  /// `stepHoldSeconds`. On 2026-10-05 the iPhone's clock stepped back 240 ms mid-stream and the
  /// window's maximum kept the old offset for its whole ten minutes: every capture time 240 ms early,
  /// the sound stepped and its margin halved.
  static let stepThresholdSeconds: Double = 0.05
  static let stepHoldSeconds: Double = 10
  /// Seconds of reports a stream's rate must rest on before its pairing is judged to have moved.
  static let relationRateSeconds: Double = 5
  /// How long before the low reading began the pairing may have moved and still explain it.
  static let relationLeadSeconds: Double = 5
  /// The previous sessions' observations of the same camera, kept through a reconnect. The camera's
  /// clock did not change when its link dropped, so the least-delayed report from before the drop is
  /// still the best estimate after it; without them the first report of a new session, often
  /// delayed by the reconnect itself, set the offset alone and moved every capture time.
  private var carriedOffsetSamples: [OffsetSample] = []
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
  /// Our wall clock less our continuous uptime, as read with the last report: what turns a capture
  /// time on uptime into one on the wall clock for the paths that still want one. Only that
  /// conversion follows a wall-clock step; the offset itself is measured against uptime and does not.
  private(set) var wallMinusUptimeSeconds: Double = 0
  /// Uptime when the last report landed, so staleness can be reported rather than inferred.
  private(set) var lastReportUptime: Double = 0
  /// Times the camera's wall clock was seen to step back and the offset followed it.
  private(set) var clockSteps: UInt64 = 0

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
  ///
  /// The largest that two more agree with, to within `agreementSeconds`, rather than the largest
  /// alone: flight time only lowers an observation, so one above the envelope is a report whose
  /// pairing is wrong, and a single one used to carry the whole mapping. On 2026-10-05, under a
  /// struggling phone, isolated reports read 0.5-1.3 s above the rest, and every capture time moved
  /// by that for as long as the window held them.
  ///
  /// Observations are kept as the camera's clock less our **continuous uptime** at arrival, never
  /// less our wall clock: the iPad's wall clock is stepped by NTP, and a 100 ms step of it once moved
  /// both cameras' offsets and stepped their sound. This is the same envelope on our wall clock, for
  /// display and for the paths that place on it.
  var filteredOffsetSeconds: Double {
    filteredUptimeOffsetSeconds.map { $0 - wallMinusUptimeSeconds } ?? ntpOffsetSeconds
  }

  /// The camera's clock less our continuous uptime: the upper envelope of the observations.
  var filteredUptimeOffsetSeconds: Double? {
    Self.envelope((offsetSamples + carriedOffsetSamples).map(\.offset))
  }

  static let agreementSeconds: Double = 0.03

  /// Whether the offset can be placed by yet: the largest observation has two more within
  /// `agreementSeconds` of it, or the first was `agreementWaitSeconds` ago. A connection's first
  /// report is often held up by the connection itself: placed by it, a session's first sound went in
  /// seconds early and the next report started a new timeline. Waiting for agreement costs a fresh
  /// connection its first second or two of sound; after a reconnect the carried observations agree
  /// at once.
  func offsetIsAgreed(at uptime: Double) -> Bool {
    let samples = offsetSamples + carriedOffsetSamples
    let sorted = samples.map(\.offset).sorted(by: >)
    if sorted.count >= 3, sorted[0] - sorted[2] <= Self.agreementSeconds { return true }
    guard let first = samples.map(\.atUptime).min() else { return false }
    return uptime - first >= Self.agreementWaitSeconds
  }

  static let agreementWaitSeconds: Double = 5

  /// Below this many observations there is no envelope to stand out from, and the largest is used.
  static let envelopeMinimumSamples = 10

  /// The upper envelope of `values`: the largest with two others within `agreementSeconds` below
  /// it, or with none that do, the third largest. The largest while there are too few to judge.
  static func envelope(_ values: [Double]) -> Double? {
    let sorted = values.sorted(by: >)
    guard sorted.count >= envelopeMinimumSamples else { return sorted.first }
    for index in 0 ..< sorted.count - 2 where sorted[index] - sorted[index + 2] <= agreementSeconds {
      return sorted[index]
    }
    return sorted[2]
  }

  /// How many observations the filtered value rests on. One sample is not a filter.
  var offsetSampleCount: Int { offsetSamples.count + carriedOffsetSamples.count }

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
    captureUptimeOnLocalClock(rtpTimestamp: rtpTimestamp, ssrc: ssrc, clockRate: clockRate)
      .map { $0 + wallMinusUptimeSeconds }
  }

  /// When a frame carrying `rtpTimestamp` was captured, on our **continuous uptime**: what the sound
  /// path places by, so nothing about where it lands goes through the iPad's wall clock.
  func captureUptimeOnLocalClock(rtpTimestamp: UInt32, ssrc: UInt32, clockRate: Double = 90_000) -> Double? {
    // No offset observed yet is no answer: an uptime offset defaulted to zero placed a session's
    // first sound decades away, and the first real report then started a new timeline.
    guard let anchor = anchor(forSSRC: ssrc), clockRate > 0,
          let uptimeOffset = filteredUptimeOffsetSeconds
    else { return nil }
    guard abs(uptimeOffset - wallMinusUptimeSeconds) <= Self.maximumClockSkewSeconds else { return nil }
    let ticks = Int32(bitPattern: rtpTimestamp &- anchor.rtpTimestamp)
    let cameraWall = anchor.ntpSeconds + Double(ticks) / clockRate
    return cameraWall - uptimeOffset
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
      if step < Self.half, track.accumulatedSeconds >= Self.relationRateSeconds, track.accumulatedTicks > 0 {
        let rate = Double(track.accumulatedTicks) / track.accumulatedSeconds
        let jump = elapsed - Double(step) / rate
        if abs(jump) > Self.stepThresholdSeconds { track.lastRelationJump = (arrivalUptime, jump) }
      }
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
      ntpOffsetSeconds = primary.ntpDate.timeIntervalSince1970 - wallClockNow.timeIntervalSince1970
      wallMinusUptimeSeconds = wallClockNow.timeIntervalSince1970 - arrivalUptime
      let observed = primary.ntpDate.timeIntervalSince1970 - arrivalUptime
      let sessionBest = Self.envelope(offsetSamples.map(\.offset))
      let carriedBest = Self.envelope(carriedOffsetSamples.map(\.offset))
      if let filtered = Self.envelope((offsetSamples + carriedOffsetSamples).map(\.offset)),
         observed < filtered - Self.stepThresholdSeconds {
        let since = lowSince ?? arrivalUptime
        lowSince = since
        // Low for a while is not enough on its own: reports held up on the way, by a hot phone
        // or a congested link, read low for as long as the holding lasts. On 2026-10-05 a phone
        // holding its sends 0.3-2 s at a time was adopted as a clock step over and over. A step
        // is followed when the camera's own pairing moved with it, or when what it contradicts
        // is only the previous session's estimate.
        let paired = tracks[busiest]?.lastRelationJump.map {
          $0.atUptime >= since - Self.relationLeadSeconds && $0.seconds <= -Self.stepThresholdSeconds
        } ?? false
        let inherited = carriedBest.map { carried in
          sessionBest.map { carried > $0 + Self.stepThresholdSeconds } ?? true
        } ?? false
        if arrivalUptime - since >= Self.stepHoldSeconds, paired || inherited {
          // The clock stepped: what was measured before it no longer describes it.
          offsetSamples.removeAll { $0.atUptime < since }
          carriedOffsetSamples.removeAll()
          clockSteps &+= 1
          lowSince = nil
        }
      } else {
        lowSince = nil
      }
      offsetSamples.append(OffsetSample(atUptime: arrivalUptime, offset: observed))
      let cutoff = arrivalUptime - Self.offsetWindowSeconds
      offsetSamples.removeAll { $0.atUptime < cutoff }
      carriedOffsetSamples.removeAll { $0.atUptime < cutoff }
    }
  }

  /// A reconnect gives the camera a new timeline and possibly a new SSRC, so nothing measured
  /// against the old one carries over, except, with `keepingClockOffset`, what the camera's wall
  /// clock was measured to be against ours: that belongs to the camera, not to the session.
  mutating func reset(keepingClockOffset: Bool = false) {
    carriedOffsetSamples = keepingClockOffset ? carriedOffsetSamples + offsetSamples : []
    tracks.removeAll()
    lowSince = nil
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
