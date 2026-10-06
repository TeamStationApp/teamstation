import CameramanCore
import CameramanEncode
import CoreMedia
import DirectorRTSP
import Foundation
import Testing

/// Each AAC packet is stamped at the capture time of the sound it decodes to (U-C1). Stamped at the
/// chunk it was cut against, every iPhone's sound sat 2,112 samples (44 ms) late: the encoder's
/// priming.
@Suite("Audio encoder timing")
struct AudioEncoderTimingTests {
  @Test("A click decodes at the time its packet's stamp says, whatever the capture buffer size", arguments: [ 1_024, 940, 4_096, 480 ])
  func probe(bufferSamples: Int) throws {
    let encoder = AudioEncoder()
    let box = FrameBox()
    encoder.onFrame = { box.append($0) }
    encoder.configure(sampleRate: 48_000, channelCount: 1)
    _ = encoder.pendingBytes
    let total = 48_000
    var pcm = [Int16](repeating: 0, count: total)
    let click = 10_000
    for i in 0 ..< 48 { pcm[click + i] = Int16(20_000 * sin(Double(i) * 2 * .pi * 3_000 / 48_000)) }
    var at = 0
    while at < total {
      let n = min(bufferSamples, total - at)
      let buffer = try #require(AudioEncoderSilenceTests.pcmBuffer(samples: n, rate: 48_000, pts: 100 + Double(at) / 48_000, value: 0, pcm: Array(pcm[at ..< at + n])))
      encoder.encode(SampleBufferRef(buffer), silent: false)
      _ = encoder.pendingBytes
      at += n
    }
    let frames = box.all
    let config = try #require(encoder.audioSpecificConfig)
    let parsed = try #require(AudioSpecificConfig(config))
    let decoder = try #require(AACAudioDecoder(config: parsed, magicCookie: config, outputSampleRate: 48_000))
    var decoded: [Int16] = []
    var starts: [Double] = []
    for frame in frames {
      guard let out = decoder.decode(frame.data) else { continue }
      starts.append(frame.captureTime ?? frame.presentationTime)
      decoded += stride(from: 0, to: out.samples.count, by: out.channelCount).map { out.samples[$0] }
    }
    let peak = decoded.indices.max { abs(Int(decoded[$0])) < abs(Int(decoded[$1])) } ?? 0
    // First sample above a tenth of the peak.
    let level = abs(Int(decoded[peak])) / 10
    let onset = decoded.firstIndex { abs(Int($0)) > level } ?? 0
    let au = onset / 1_024
    let stamped = starts[au] + Double(onset % 1_024) / 48_000
    let truth = 100 + Double(click) / 48_000
    #expect(abs(stamped - truth) < 0.000_5, "stamped \((stamped - truth) * 1_000) ms from the truth")
    // Packets are exactly 1,024 samples apart, starting the priming before the first sample.
    #expect(abs((frames.first?.presentationTime ?? 0) - (100 - 2_112.0 / 48_000)) < 1e-9)
    for (a, b) in zip(frames, frames.dropFirst()) {
      #expect(abs(b.presentationTime - a.presentationTime - 1_024.0 / 48_000) < 1e-9)
    }
  }

  @Test("Sound lost before the encoder leaves the packets beside the gap at their own samples' time", arguments: [ 1_024, 940, 480 ])
  func gap(bufferSamples: Int) throws {
    let encoder = AudioEncoder()
    let box = FrameBox()
    encoder.onFrame = { box.append($0) }
    encoder.configure(sampleRate: 48_000, channelCount: 1)
    _ = encoder.pendingBytes
    // 30,720 samples fed; the capture clock jumps 0.4 s at sample 20,480, as when 0.4 s of buffers
    // never reached the encoder. A click on each side of the gap.
    let total = 30_720, cut = 20_480, lost = 0.4
    var pcm = [Int16](repeating: 0, count: total)
    let clicks = [ 19_000, 22_000 ]
    for click in clicks {
      for i in 0 ..< 48 { pcm[click + i] = Int16(20_000 * sin(Double(i) * 2 * .pi * 3_000 / 48_000)) }
    }
    var at = 0
    while at < total {
      let n = min(bufferSamples, total - at, at < cut ? cut - at : total)
      let pts = 100 + Double(at) / 48_000 + (at >= cut ? lost : 0)
      let buffer = try #require(AudioEncoderSilenceTests.pcmBuffer(samples: n, rate: 48_000, pts: pts, value: 0, pcm: Array(pcm[at ..< at + n])))
      encoder.encode(SampleBufferRef(buffer), silent: false)
      _ = encoder.pendingBytes
      at += n
    }
    let config = try #require(encoder.audioSpecificConfig)
    let parsed = try #require(AudioSpecificConfig(config))
    let decoder = try #require(AACAudioDecoder(config: parsed, magicCookie: config, outputSampleRate: 48_000))
    var decoded: [Int16] = []
    var starts: [Double] = []
    for frame in box.all {
      guard let out = decoder.decode(frame.data) else { continue }
      starts.append(try #require(frame.captureTime))
      decoded += stride(from: 0, to: out.samples.count, by: out.channelCount).map { out.samples[$0] }
    }
    for (click, from) in zip(clicks, [ 0, 22_000 ]) {
      let window = decoded[from...]
      let peak = window.indices.max { abs(Int(decoded[$0])) < abs(Int(decoded[$1])) } ?? from
      let level = abs(Int(decoded[peak])) / 10
      let onset = window.firstIndex { abs(Int($0)) > level } ?? from
      let stamped = starts[onset / 1_024] + Double(onset % 1_024) / 48_000
      let truth = 100 + Double(click) / 48_000 + (click >= cut ? lost : 0)
      #expect(abs(stamped - truth) < 0.000_5, "click at \(click): stamped \((stamped - truth) * 1_000) ms from the truth")
    }
    // No packet is stamped later than the newest sound fed: a packet stamped past the gap with sound
    // from before it put the sender report, and every sound placed by it, up to the gap late.
    let newest = 100 + Double(total) / 48_000 + lost
    #expect(box.all.allSatisfy { ($0.captureTime ?? 0) < newest })
  }

  @Test("Under irregular sound loss every packet keeps its own samples' capture time, in order", arguments: [ 940, 1_024, 480 ])
  func irregularLoss(bufferSamples: Int) throws {
    let encoder = AudioEncoder()
    let box = FrameBox()
    encoder.onFrame = { box.append($0) }
    encoder.configure(sampleRate: 48_000, channelCount: 1)
    _ = encoder.pendingBytes
    // Twenty seconds of capture buffers; seeded runs of them never reach the encoder, as the
    // struggling-phone injection drops them. `fed` maps each fed sample's count to its capture time.
    var state: UInt64 = 11
    func unit() -> Double {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      return Double(state >> 11) / Double(UInt64(1) << 53)
    }
    var fed: [(count: Int, capture: Double)] = []
    var count = 0
    var buffer = 0
    var dropping = 0
    while Double(buffer * bufferSamples) / 48_000 < 20 {
      let capture = 100 + Double(buffer * bufferSamples) / 48_000
      buffer += 1
      if dropping > 0 { dropping -= 1; continue }
      if unit() < 0.05 { dropping = 1 + Int(unit() * 15); continue }
      fed.append((count, capture))
      let pcm = [Int16](repeating: 0, count: bufferSamples)
      let sample = try #require(AudioEncoderSilenceTests.pcmBuffer(samples: bufferSamples, rate: 48_000, pts: capture, value: 0, pcm: pcm))
      encoder.encode(SampleBufferRef(sample), silent: false)
      _ = encoder.pendingBytes
      count += bufferSamples
    }
    // The capture time of the fed sample at `position` on the count timeline.
    func truth(_ position: Int) -> Double? {
      guard let last = fed.last(where: { $0.count <= position }) else { return nil }
      return last.capture + Double(position - last.count) / 48_000
    }
    let frames = box.all
    #expect(frames.count > 600)
    var previous: Double?
    for (index, frame) in frames.enumerated() {
      let capture = try #require(frame.captureTime)
      if let previous { #expect(capture > previous, "packet \(index) goes back") }
      previous = capture
      // Content starts 2,112 samples before the chunk it was cut against.
      let position = index * 1_024 - 2_112
      if position >= 0, let expected = truth(position) {
        #expect(abs(capture - expected) < 0.000_5, "packet \(index): \((capture - expected) * 1_000) ms")
      }
    }
  }
}
