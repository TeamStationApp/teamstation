import DirectorCore
import DirectorPipeline
import Testing

@Suite("Audio waveform monitor")
struct AudioWaveformMonitorTests {
  @Test("A constant buffer fills the sweep at native amplitude")
  func constantBufferFillsSweep() {
    let monitor = AudioWaveformMonitor()
    let amplitude: Float = 0.5
    let sample = Int16((amplitude * Float(Int16.max)).rounded())
    var points = [Float](repeating: 0, count: AudioWaveformMonitor.pointCount)
    for index in points.indices { points[index] = Float(sample) / Float(Int16.max) }
    monitor.append(source: SourceID("CAM1"), points: points)
    let snapshot = monitor.snapshot(for: SourceID("CAM1"))
    #expect(snapshot.samples.count == AudioWaveformMonitor.pointCount)
    #expect(abs(snapshot.samples[0] - amplitude) < 0.02)
    #expect(abs(snapshot.samples[snapshot.samples.count - 1] - amplitude) < 0.02)
  }

  @Test("An unknown camera is a silent sweep")
  func unknownCameraIsSilent() {
    let snapshot = AudioWaveformMonitor().snapshot(for: SourceID("missing"))
    #expect(snapshot.samples.allSatisfy { $0 == 0 })
  }
}

@Suite("Audio PCM gain")
struct AudioPCMTests {
  @Test("Unity multiplier leaves samples alone and twice-full-scale saturates")
  func scaleUnityAndClip() {
    var unity: [Int16] = [ 1000, -1000 ]
    AudioPCM.scale(&unity, multiplier: 1)
    #expect(unity == [ 1000, -1000 ])

    var hot: [Int16] = [ Int16.max / 2, Int16.min / 2 ]
    AudioPCM.scale(&hot, multiplier: 4)
    #expect(hot[0] == Int16.max)
    #expect(hot[1] == Int16.min)
  }
}
