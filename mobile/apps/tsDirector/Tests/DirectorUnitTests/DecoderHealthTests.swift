import Foundation
import Testing
import VideoToolbox
@testable import DirectorRTSP

/// A decode session that has gone permanently bad has to be thrown away rather than fed. Keeping
/// one cost the RTSP preview for a whole run on the bench: every frame failed from that point on,
/// while the archive — which never decodes — carried on writing, so the tile looked like a camera
/// that had quietly gone away.
@Suite("Decoder health")
struct DecoderHealthTests {
  @Test("A session that has stopped working is thrown away")
  func permanentFailuresRebuild() {
    #expect(VideoToolboxDecoder.isPermanent(kVTInvalidSessionErr))
    #expect(VideoToolboxDecoder.isPermanent(kVTVideoDecoderMalfunctionErr))
    #expect(VideoToolboxDecoder.isPermanent(kVTVideoDecoderNotAvailableNowErr))
  }

  /// Corrupt data is ordinary on a live network. Rebuilding for one damaged frame would mean
  /// rebuilding constantly and dropping every picture in flight each time.
  @Test("One bad frame is not a bad session")
  func transientFailuresKeepTheSession() {
    #expect(!VideoToolboxDecoder.isPermanent(kVTVideoDecoderBadDataErr))
    #expect(!VideoToolboxDecoder.isPermanent(noErr))
  }
}
