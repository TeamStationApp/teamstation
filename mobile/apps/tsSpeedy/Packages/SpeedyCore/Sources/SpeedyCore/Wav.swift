import Foundation

/// The samples of one of TS Speedy's clips. Only the format the clips are made in is accepted: PCM,
/// 16-bit, mono, 24 kHz. Anything else is an error that names the clip, so a bad file fails loudly
/// rather than playing as noise.
public enum Wav {
  public static let rate = 24000

  public enum Failure: Error, Equatable, CustomStringConvertible {
    case notWave(String)
    case format(String, String)
    case truncated(String)

    public var description: String {
      switch self {
      case let .notWave(name): return "\(name): not a RIFF WAVE file"
      case let .format(name, what): return "\(name): \(what)"
      case let .truncated(name): return "\(name): truncated"
      }
    }
  }

  public static func samples(_ data: Data, name: String) throws -> [Int16] {
    let bytes = [UInt8](data)
    guard bytes.count >= 12, ascii(bytes, 0) == "RIFF", ascii(bytes, 8) == "WAVE" else {
      throw Failure.notWave(name)
    }
    var formatSeen = false
    var offset = 12
    while offset + 8 <= bytes.count {
      let id = ascii(bytes, offset)
      let size = Int(uint32(bytes, offset + 4))
      let body = offset + 8
      guard body + size <= bytes.count else { throw Failure.truncated(name) }
      if id == "fmt " {
        guard size >= 16 else { throw Failure.truncated(name) }
        let codec = uint16(bytes, body)
        let channels = uint16(bytes, body + 2)
        let sampleRate = Int(uint32(bytes, body + 4))
        let bits = uint16(bytes, body + 14)
        guard codec == 1 else { throw Failure.format(name, "codec \(codec), not PCM") }
        guard channels == 1 else { throw Failure.format(name, "\(channels) channels, not mono") }
        guard sampleRate == rate else { throw Failure.format(name, "\(sampleRate) Hz, not \(rate)") }
        guard bits == 16 else { throw Failure.format(name, "\(bits)-bit, not 16") }
        formatSeen = true
      } else if id == "data" {
        guard formatSeen else { throw Failure.format(name, "data before fmt") }
        var samples = [Int16](repeating: 0, count: size / 2)
        for index in samples.indices {
          let at = body + index * 2
          samples[index] = Int16(bitPattern: UInt16(bytes[at]) | UInt16(bytes[at + 1]) << 8)
        }
        return samples
      }
      offset = body + size + (size & 1)
    }
    throw Failure.truncated(name)
  }

  /// A canonical 44-byte-header WAV of `samples` at 24 kHz, mono, 16-bit.
  public static func data(_ samples: [Int16]) -> Data {
    var out = Data()
    func put32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) } }
    func put16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { out.append(contentsOf: $0) } }
    let size = UInt32(samples.count * 2)
    out.append(contentsOf: Array("RIFF".utf8))
    put32(36 + size)
    out.append(contentsOf: Array("WAVEfmt ".utf8))
    put32(16)
    put16(1)
    put16(1)
    put32(UInt32(rate))
    put32(UInt32(rate * 2))
    put16(2)
    put16(16)
    out.append(contentsOf: Array("data".utf8))
    put32(size)
    for sample in samples { put16(UInt16(bitPattern: sample)) }
    return out
  }

  /// RMS level in dBFS; minus infinity for silence.
  public static func levelDB(_ samples: [Int16]) -> Double {
    guard !samples.isEmpty else { return -.infinity }
    let sum = samples.reduce(0.0) { $0 + Double($1) * Double($1) }
    let rms = (sum / Double(samples.count)).squareRoot()
    return rms == 0 ? -.infinity : 20 * log10(rms / 32768)
  }

  private static func ascii(_ bytes: [UInt8], _ at: Int) -> String {
    String(decoding: bytes[at..<at + 4], as: UTF8.self)
  }

  private static func uint16(_ bytes: [UInt8], _ at: Int) -> Int {
    Int(bytes[at]) | Int(bytes[at + 1]) << 8
  }

  private static func uint32(_ bytes: [UInt8], _ at: Int) -> UInt32 {
    UInt32(bytes[at]) | UInt32(bytes[at + 1]) << 8 | UInt32(bytes[at + 2]) << 16 | UInt32(bytes[at + 3]) << 24
  }
}
