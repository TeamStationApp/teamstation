import Foundation
import Testing

@testable import CameramanUI

@Suite("Encoder idle policy")
struct EncoderIdlePolicyTests {
  @Test("Nobody playing means no video encode, once the SDP has its parameter sets")
  func idleWithoutClients() {
    #expect(EncoderIdlePolicy.shouldEncodeVideo(playingClients: 0, encodeWhenIdle: false, hasParameterSets: true) == false)
    #expect(EncoderIdlePolicy.shouldEncodeVideo(playingClients: 1, encodeWhenIdle: false, hasParameterSets: true))
    #expect(EncoderIdlePolicy.shouldEncodeVideo(playingClients: 3, encodeWhenIdle: false, hasParameterSets: true))
  }

  @Test("The encoder runs until it has produced parameter sets, or DESCRIBE would have nothing to say")
  func runsUntilParameterSetsExist() {
    #expect(EncoderIdlePolicy.shouldEncodeVideo(playingClients: 0, encodeWhenIdle: false, hasParameterSets: false))
  }

  @Test("encodeWhenIdle keeps both encoders running with no client")
  func diagnosticOverride() {
    #expect(EncoderIdlePolicy.shouldEncodeVideo(playingClients: 0, encodeWhenIdle: true, hasParameterSets: true))
    #expect(EncoderIdlePolicy.shouldEncodeAudio(playingClients: 0, encodeWhenIdle: true))
  }

  @Test("Audio follows the client count alone")
  func audio() {
    #expect(EncoderIdlePolicy.shouldEncodeAudio(playingClients: 0, encodeWhenIdle: false) == false)
    #expect(EncoderIdlePolicy.shouldEncodeAudio(playingClients: 1, encodeWhenIdle: false))
  }

  @Test("A keyframe is forced only on the transition from nobody to somebody")
  func keyframeOnFirstClient() {
    #expect(EncoderIdlePolicy.needsKeyframe(previousClients: 0, currentClients: 1))
    #expect(EncoderIdlePolicy.needsKeyframe(previousClients: 0, currentClients: 2))
    #expect(EncoderIdlePolicy.needsKeyframe(previousClients: 1, currentClients: 2) == false)
    #expect(EncoderIdlePolicy.needsKeyframe(previousClients: 1, currentClients: 0) == false)
    #expect(EncoderIdlePolicy.needsKeyframe(previousClients: 0, currentClients: 0) == false)
  }
}
