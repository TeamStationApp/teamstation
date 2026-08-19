import Foundation

/// Builds the MPEG-4 `AudioSpecificConfig` that the SDP carries as `config=` and that a decoder
/// needs before it can interpret a single AAC packet.
///
/// Pure bit assembly, kept apart from the encoder so it can be checked against known-good values and
/// round-tripped through GS Producer's parser without an audio session.
public enum AudioSpecificConfigBuilder {
  /// Sample-rate indices from ISO/IEC 14496-3 Table 1.16, in order.
  public static let sampleRateIndices = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
    16_000, 12_000, 11_025, 8_000, 7_350
  ]

  /// AAC-LC, audio object type 2.
  public static let aacLCObjectType = 2

  /// Returns nil for a rate or channel count AAC cannot express, rather than emitting a config that
  /// decodes to the wrong sample rate.
  public static func aacLC(sampleRate: Int, channelCount: Int) -> Data? {
    guard let frequencyIndex = sampleRateIndices.firstIndex(of: sampleRate) else { return nil }
    // Channel configurations 1…7 are the standard layouts. 0 means "described elsewhere", which
    // nothing in this pipeline produces.
    guard (1 ... 7).contains(channelCount) else { return nil }

    // 5 bits object type, 4 bits frequency index, 4 bits channel configuration, then the three
    // GASpecificConfig flags — frameLengthFlag, dependsOnCoreCoder, extensionFlag — all zero.
    var bits = UInt32(aacLCObjectType) << 11
    bits |= UInt32(frequencyIndex) << 7
    bits |= UInt32(channelCount) << 3

    return Data([ UInt8((bits >> 8) & 0xFF), UInt8(bits & 0xFF) ])
  }

  /// The hex spelling SDP uses in `config=`. Lower case, no separators.
  public static func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }
}
