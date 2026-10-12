import CoreMedia
import Foundation
import VideoToolbox
import Testing
@testable import DirectorMedia
@testable import DirectorPipeline

@Suite("Program streamer pending encodes")
struct ProgramStreamerPendingTests {
  @Test("A failed or nil output callback still drains pendingEncodes")
  func failedCallbackDrainsPending() {
    let streamer = ProgramStreamer(telemetry: PipelineTelemetry(), converter: PixelConverter())
    streamer.simulateOutputCallbackForTesting(
      incrementPending: true,
      sample: nil,
      status: noErr
    )
    streamer.simulateOutputCallbackForTesting(
      incrementPending: true,
      sample: nil,
      status: -1
    )
    streamer.simulateOutputCallbackForTesting(
      incrementPending: true,
      sample: nil,
      status: noErr,
      flags: .frameDropped
    )
    #expect(streamer.pendingEncodesForTesting == 0)
  }
}
