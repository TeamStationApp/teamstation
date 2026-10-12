import Foundation

/// The wall clock a frame carries in its own bitstream: when its picture was taken, on TeamStation's
/// clock when Director had measured the difference and on Director's own otherwise.
///
/// Every copy the server makes of a stream is `-c copy` — the RTMP ingest, the live HLS, the recording
/// it becomes — so a frame stamped here keeps its moment all the way to a viewer, across an outage and
/// a reconnect, where the RTMP timestamps start again. That is what lets a player draw the scoreboard
/// in effect at the frame on screen.
///
/// It is a `user_data_unregistered` SEI message (payload type 5): NAL type 6 for H.264, prefix SEI
/// (NAL type 39) for HEVC. Its payload is
///
/// | Bytes | Field                                                    |
/// | ----- | -------------------------------------------------------- |
/// | 16    | `uuid`, which says the rest is ours                      |
/// | 1     | version, 1                                               |
/// | 8     | wall ms since 1970, signed, big-endian                   |
/// | 1     | flags: bit 0 set when the clock is the server's          |
///
/// The server reads the same bytes (`src/common/wallClockSei.ts`), and both sides check the vectors
/// in `src/test/wallClockSeiVectors.json`. Only Director writes it, so there is no reader here.
public enum WallClockSEI {
  /// Which bitstream a NAL unit belongs to.
  public enum Codec: Sendable, Equatable {
    case h264
    case hevc
  }

  /// Ours, and nobody else's: `5e2f0c4a-7d1b-4b6e-9c38-1f0a6d2e8b71`.
  public static let uuid: [UInt8] = [
    0x5E, 0x2F, 0x0C, 0x4A, 0x7D, 0x1B, 0x4B, 0x6E, 0x9C, 0x38, 0x1F, 0x0A, 0x6D, 0x2E, 0x8B, 0x71
  ]
  public static let version: UInt8 = 1
  /// `user_data_unregistered`.
  public static let payloadType: UInt8 = 5
  /// UUID, version, wall ms and flags.
  public static let payloadSize = 16 + 1 + 8 + 1

  /// The SEI NAL type in each codec: H.264's SEI, HEVC's prefix SEI.
  public static func seiNALType(_ codec: Codec) -> UInt8 {
    switch codec {
    case .h264: 6
    case .hevc: 39
    }
  }

  /// Whether a NAL unit, by its first header byte, is a coded slice: part of the frame's picture,
  /// which every SEI of the frame has to come before. H.264's slices are types 1 to 5; every HEVC
  /// type below 32 is a VCL unit.
  public static func isSlice(_ codec: Codec, header: UInt8) -> Bool {
    switch codec {
    case .h264: (1 ... 5).contains(header & 0x1F)
    case .hevc: (header >> 1) & 0x3F < 32
    }
  }

  /// The stamp as one NAL unit: header, the SEI message and its trailing bits, with emulation
  /// prevention applied. No start code and no length prefix, which are the container's.
  public static func encode(_ codec: Codec, wallMs: Int64, corrected: Bool) -> Data {
    // One message: type and size each fit in one byte, then the payload and the stop bit that ends
    // the RBSP.
    var rbsp: [UInt8] = [ payloadType, UInt8(payloadSize) ]
    rbsp += uuid
    rbsp.append(version)
    let wall = UInt64(bitPattern: wallMs)
    for shift in stride(from: 56, through: 0, by: -8) {
      rbsp.append(UInt8(truncatingIfNeeded: wall >> UInt64(shift)))
    }
    rbsp.append(corrected ? 1 : 0)
    rbsp.append(0x80)

    let header: [UInt8] = switch codec {
    case .h264: [ seiNALType(.h264) ]
    // nuh_layer_id 0, nuh_temporal_id_plus1 1.
    case .hevc: [ seiNALType(.hevc) << 1, 0x01 ]
    }
    return Data(header + addEmulationPrevention(rbsp))
  }

  /// Inserts `03` after every two zero bytes that a byte of 3 or less follows, so nothing inside the
  /// unit reads as a start code. A wall in this century always needs one: the version byte's `01`
  /// is followed by the wall's two leading zero bytes and then `01`.
  public static func addEmulationPrevention(_ rbsp: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(rbsp.count + rbsp.count / 2)
    var zeros = 0
    for byte in rbsp {
      if zeros >= 2, byte <= 3 {
        out.append(3)
        zeros = 0
      }
      out.append(byte)
      zeros = byte == 0 ? zeros + 1 : 0
    }
    return out
  }
}
