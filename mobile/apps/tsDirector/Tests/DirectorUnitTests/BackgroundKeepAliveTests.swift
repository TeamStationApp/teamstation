import AVFoundation
import CoreMedia
import DirectorPipeline
import DirectorSources
import Testing

@Suite("Background keep-alive")
struct BackgroundKeepAliveTests {
  @Test("Recording or streaming keeps the process eligible for background audio")
  func recordingOrStreamingStaysActive() {
    #expect(BackgroundKeepAlive.shouldStayActive(isRecording: true, isStreaming: false))
    #expect(BackgroundKeepAlive.shouldStayActive(isRecording: false, isStreaming: true))
    #expect(BackgroundKeepAlive.shouldStayActive(isRecording: true, isStreaming: true))
  }

  @Test("A preview-only session does not keep-alive")
  func previewOnlyDoesNotStayActive() {
    #expect(!BackgroundKeepAlive.shouldStayActive(isRecording: false, isStreaming: false))
  }
}

@Suite("Programme audio player")
struct ProgramAudioPlayerTests {
  @Test("A mixer-shaped int16 stereo chunk becomes float32 PCM of the same length")
  func mixerChunkConvertsToFloatPCM() throws {
    let channels = AudioMixer.channelCount
    let frames = 960
    var samples = [Int16](repeating: 0, count: frames * channels)
    samples[0] = 16384
    samples[1] = -16384
    let format = try #require(
      AudioSampleBuilder.makeFormatDescription(
        AudioSampleBuilder.interleavedInt16Description(
          sampleRate: AudioMixer.sampleRate,
          channels: UInt32(channels)
        )
      )
    )
    let buffer = try #require(
      AudioSampleBuilder.makeSampleBuffer(
        samples: samples,
        formatDescription: format,
        presentationTime: .zero
      )
    )
    let pcm = try #require(ProgramAudioPlayer.makePCMBuffer(from: buffer))
    #expect(pcm.frameLength == AVAudioFrameCount(frames))
    #expect(pcm.format.channelCount == 2)
    #expect(abs((pcm.floatChannelData?[0][0] ?? 0) - 0.5) < 0.01)
    #expect(abs((pcm.floatChannelData?[1][0] ?? 0) + 0.5) < 0.01)
  }
}
