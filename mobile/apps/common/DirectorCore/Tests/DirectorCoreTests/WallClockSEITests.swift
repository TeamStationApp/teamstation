import Foundation
import Testing
@testable import DirectorCore

/// The vectors the server's codec is held to, read from the repository rather than copied, so the
/// two sides cannot drift apart without one of them failing.
private struct Vectors: Decodable {
  struct Vector: Decodable {
    let name: String
    let wallMs: Int64
    let corrected: Bool
    let payloadHex: String
    let h264: String
    let hevc: String
  }

  let uuid: String
  let version: Int
  let payloadType: Int
  let payloadSize: Int
  let vectors: [Vector]

  /// `src/test/wallClockSeiVectors.json`, found by walking up from this file to the repository root.
  static func load() throws -> Vectors {
    var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
      let file = directory.appendingPathComponent("src/test/wallClockSeiVectors.json")
      if FileManager.default.fileExists(atPath: file.path) {
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: file))
      }
      directory.deleteLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
  }
}

private func hex(_ bytes: some Sequence<UInt8>) -> String {
  bytes.map { String(format: "%02x", $0) }.joined()
}

@Suite("Wall-clock SEI")
struct WallClockSEITests {
  // MARK: - S4: the Swift bytes equal the shared vectors

  @Test("The constants are the ones the vectors were made with")
  func constants() throws {
    let vectors = try Vectors.load()
    #expect(hex(WallClockSEI.uuid) == vectors.uuid)
    #expect(Int(WallClockSEI.version) == vectors.version)
    #expect(Int(WallClockSEI.payloadType) == vectors.payloadType)
    #expect(WallClockSEI.payloadSize == vectors.payloadSize)
    #expect(vectors.vectors.count >= 4)
  }

  @Test("Every vector encodes to the same H.264 and HEVC bytes as the server's codec")
  func vectorsMatch() throws {
    for vector in try Vectors.load().vectors {
      let h264 = WallClockSEI.encode(.h264, wallMs: vector.wallMs, corrected: vector.corrected)
      let hevc = WallClockSEI.encode(.hevc, wallMs: vector.wallMs, corrected: vector.corrected)
      #expect(hex(h264) == vector.h264, "\(vector.name)")
      #expect(hex(hevc) == vector.hevc, "\(vector.name)")
    }
  }

  @Test("Every vector's payload is the message the unit carries before emulation prevention")
  func payloads() throws {
    for vector in try Vectors.load().vectors {
      let nal = [UInt8](WallClockSEI.encode(.h264, wallMs: vector.wallMs, corrected: vector.corrected))
      let rbsp = Self.removingEmulationPrevention(Array(nal.dropFirst()))
      // Type, size, the payload, then the stop bit.
      #expect(rbsp.first == WallClockSEI.payloadType)
      #expect(Int(rbsp[1]) == WallClockSEI.payloadSize)
      #expect(hex(rbsp[2 ..< 2 + WallClockSEI.payloadSize]) == vector.payloadHex, "\(vector.name)")
      #expect(rbsp.last == 0x80)
      #expect(rbsp[rbsp.count - 2] & 1 == (vector.corrected ? 1 : 0))
    }
  }

  // MARK: - The pieces

  @Test("The SEI NAL types and headers: 6 for H.264, prefix SEI 39 for HEVC")
  func headers() {
    #expect(WallClockSEI.seiNALType(.h264) == 6)
    #expect(WallClockSEI.seiNALType(.hevc) == 39)
    #expect(WallClockSEI.encode(.h264, wallMs: 1, corrected: true).first == 0x06)
    #expect([UInt8](WallClockSEI.encode(.hevc, wallMs: 1, corrected: true).prefix(2)) == [ 0x4E, 0x01 ])
  }

  @Test("Slices are H.264 types 1 to 5 and HEVC's VCL types, and nothing else")
  func slices() {
    for type: UInt8 in 0 ... 31 {
      #expect(WallClockSEI.isSlice(.h264, header: 0x60 | type) == (1 ... 5).contains(type), "H.264 \(type)")
    }
    for type: UInt8 in 0 ... 63 {
      #expect(WallClockSEI.isSlice(.hevc, header: type << 1) == (type < 32), "HEVC \(type)")
    }
  }

  @Test("Emulation prevention escapes 00 00 followed by 00 to 03, and nothing else")
  func emulationPrevention() {
    #expect(WallClockSEI.addEmulationPrevention([ 0, 0, 0 ]) == [ 0, 0, 3, 0 ])
    #expect(WallClockSEI.addEmulationPrevention([ 0, 0, 3 ]) == [ 0, 0, 3, 3 ])
    #expect(WallClockSEI.addEmulationPrevention([ 0, 0, 4 ]) == [ 0, 0, 4 ])
    #expect(WallClockSEI.addEmulationPrevention([ 0, 1, 0, 0, 1 ]) == [ 0, 1, 0, 0, 3, 1 ])
    #expect(WallClockSEI.addEmulationPrevention([ 0, 0, 0, 0, 0 ]) == [ 0, 0, 3, 0, 0, 3, 0 ])
    #expect(WallClockSEI.addEmulationPrevention([]) == [])
  }

  @Test("A wall before 1970 is written as its two's complement")
  func negativeWall() {
    let nal = [UInt8](WallClockSEI.encode(.h264, wallMs: -1, corrected: false))
    let rbsp = Self.removingEmulationPrevention(Array(nal.dropFirst()))
    #expect(Array(rbsp[19 ..< 27]) == [UInt8](repeating: 0xFF, count: 8))
  }

  /// Takes out the `03` that follows every two zero bytes: the test's own reader, so the encoder is
  /// not checked against itself.
  private static func removingEmulationPrevention(_ ebsp: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var zeros = 0
    for byte in ebsp {
      if zeros >= 2, byte == 3 {
        zeros = 0
        continue
      }
      out.append(byte)
      zeros = byte == 0 ? zeros + 1 : 0
    }
    return out
  }
}
