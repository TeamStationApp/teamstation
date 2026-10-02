import Foundation

/// Builds the 7-byte ADTS header that wraps a bare AAC access unit into a self-describing frame.
///
/// The RTP path never uses this — `mpeg4-generic` carries bare access units and a client that gets
/// ADTS-wrapped frames decodes seven bytes of header as audio. It exists so the encoder's real output
/// can be written to a file and decoded by ffprobe, which needs each frame to describe its own rate
/// and channel layout.
public enum ADTSHeader {
  /// Returns nil for a rate or channel count ADTS cannot express, rather than emitting a header that
  /// decodes at the wrong sample rate.
  public static func wrap(_ accessUnit: Data, sampleRate: Int, channelCount: Int) -> Data? {
    guard let header = make(
      payloadCount: accessUnit.count,
      sampleRate: sampleRate,
      channelCount: channelCount
    ) else { return nil }

    var frame = header
    frame.append(accessUnit)
    return frame
  }

  public static let headerCount = 7

  public static func make(payloadCount: Int, sampleRate: Int, channelCount: Int) -> Data? {
    guard let frequencyIndex = AudioSpecificConfigBuilder.sampleRateIndices
      .firstIndex(of: sampleRate) else { return nil }
    guard (1 ... 7).contains(channelCount) else { return nil }

    // The 13-bit length field covers the header as well as the payload.
    let frameLength = payloadCount + headerCount
    guard payloadCount > 0, frameLength < (1 << 13) else { return nil }

    // The profile field is the audio object type minus one, so AAC-LC (2) is written as 1.
    let profile = UInt8(AudioSpecificConfigBuilder.aacLCObjectType - 1)

    var header = Data(count: headerCount)
    header[0] = 0xFF
    // Syncword's low 4 bits, then MPEG-4, layer 00, and protection-absent so no CRC follows.
    header[1] = 0xF1
    header[2] = (profile << 6) | (UInt8(frequencyIndex) << 2) | (UInt8(channelCount) >> 2)
    header[3] = UInt8((channelCount & 0x3) << 6) | UInt8((frameLength >> 11) & 0x03)
    header[4] = UInt8((frameLength >> 3) & 0xFF)
    // Frame length's low 3 bits, then the top 5 of a buffer-fullness of 0x7FF, meaning variable rate.
    header[5] = UInt8((frameLength & 0x07) << 5) | 0x1F
    // Buffer fullness's low 6 bits, then one access unit per frame, written as 0.
    header[6] = 0xFC

    return header
  }
}
