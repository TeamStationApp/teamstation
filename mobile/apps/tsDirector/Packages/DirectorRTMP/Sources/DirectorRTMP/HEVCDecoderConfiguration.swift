import Foundation

/// Builds the HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1, the `hvcC` box body) that
/// Enhanced RTMP's SequenceStart carries for `hvc1`.
///
/// Everything in the record's header is read from the SPS: the profile, tier, level and constraint
/// flags from its profile_tier_level, and the chroma format and bit depths from the fields after it.
/// That is how FFmpeg's `hvcc.c` fills it, and for VideoToolbox's 1080p Main output it reproduces
/// VideoToolbox's own `hvcC` atom byte for byte, apart from `temporalIdNested`: VideoToolbox writes 0
/// where the SPS says 1, and the SPS's value is the one a decoder may rely on.
///
/// The fields a publisher cannot know without parsing the VUI are written as "unknown", which the
/// specification allows: `min_spatial_segmentation_idc` 0, `parallelismType` 0, `avgFrameRate` 0 and
/// `constantFrameRate` 0.
public enum HEVCDecoderConfiguration {
  /// NAL unit types of the three parameter sets.
  public static let vpsType: UInt8 = 32
  public static let spsType: UInt8 = 33
  public static let ppsType: UInt8 = 34

  /// The NAL unit type of an HEVC NAL unit: six bits after the forbidden zero bit.
  public static func nalType(_ nal: Data) -> UInt8? {
    nal.first.map { ($0 >> 1) & 0x3F }
  }

  /// The record for parameter sets in any order, each a bare NAL unit without a start code or
  /// length prefix. Nil when there is no VPS, SPS and PPS, or the SPS cannot be read.
  ///
  /// `lengthSize` is the size of the length prefix in front of each NAL unit in the coded frames,
  /// which is 4 for everything VideoToolbox produces.
  public static func record(parameterSets: [Data], lengthSize: Int = 4) -> Data? {
    let vps = parameterSets.filter { nalType($0) == vpsType }
    let sps = parameterSets.filter { nalType($0) == spsType }
    let pps = parameterSets.filter { nalType($0) == ppsType }
    guard !vps.isEmpty, let first = sps.first, !pps.isEmpty,
      let info = SPSInfo(sps: first),
      (1 ... 4).contains(lengthSize), lengthSize != 3
    else { return nil }

    var record = Data()
    record.append(1)
    record.append((info.profileSpace << 6) | (info.tierFlag << 5) | info.profileIDC)
    record.append(contentsOf: info.compatibilityFlags)
    record.append(contentsOf: info.constraintFlags)
    record.append(info.levelIDC)
    // reserved '1111' + min_spatial_segmentation_idc (0: unknown).
    record.append(contentsOf: [ 0xF0, 0x00 ])
    // reserved '111111' + parallelismType (0: unknown).
    record.append(0xFC)
    record.append(0xFC | (info.chromaFormatIDC & 0x03))
    record.append(0xF8 | (info.bitDepthLumaMinus8 & 0x07))
    record.append(0xF8 | (info.bitDepthChromaMinus8 & 0x07))
    // avgFrameRate (0: unknown).
    record.append(contentsOf: [ 0x00, 0x00 ])
    // constantFrameRate (0: unknown), numTemporalLayers, temporalIdNested, lengthSizeMinusOne.
    let temporalLayers = (info.maxSubLayersMinus1 + 1) & 0x07
    record.append((temporalLayers << 3) | ((info.temporalIDNesting & 1) << 2) | UInt8(lengthSize - 1))
    record.append(3)
    for (type, units) in [ (vpsType, vps), (spsType, sps), (ppsType, pps) ] {
      // array_completeness 1: every parameter set of this type is here, none arrives in band.
      record.append(0x80 | type)
      record.append(UInt8((units.count >> 8) & 0xFF))
      record.append(UInt8(units.count & 0xFF))
      for unit in units {
        record.append(UInt8((unit.count >> 8) & 0xFF))
        record.append(UInt8(unit.count & 0xFF))
        record.append(unit)
      }
    }
    return record
  }

  /// The SPS fields the record repeats.
  struct SPSInfo: Equatable {
    var maxSubLayersMinus1: UInt8
    var temporalIDNesting: UInt8
    var profileSpace: UInt8
    var tierFlag: UInt8
    var profileIDC: UInt8
    var compatibilityFlags: [UInt8]
    var constraintFlags: [UInt8]
    var levelIDC: UInt8
    var chromaFormatIDC: UInt8
    var bitDepthLumaMinus8: UInt8
    var bitDepthChromaMinus8: UInt8

    init?(sps: Data) {
      // The two-byte NAL header is not part of the RBSP.
      guard sps.count > 2 else { return nil }
      var reader = BitReader(bytes: Self.rbsp(Array(sps.dropFirst(2))))
      guard
        reader.skip(4),
        let maxSubLayersMinus1 = reader.read(3),
        let nesting = reader.read(1),
        let profileSpace = reader.read(2),
        let tier = reader.read(1),
        let profile = reader.read(5)
      else { return nil }
      var compatibility: [UInt8] = []
      for _ in 0 ..< 4 {
        guard let byte = reader.read(8) else { return nil }
        compatibility.append(UInt8(byte))
      }
      var constraints: [UInt8] = []
      for _ in 0 ..< 6 {
        guard let byte = reader.read(8) else { return nil }
        constraints.append(UInt8(byte))
      }
      guard let level = reader.read(8) else { return nil }

      // Sub-layer profile and level, which the record does not carry but which sit in front of the
      // fields it does.
      var profilePresent: [Bool] = []
      var levelPresent: [Bool] = []
      for _ in 0 ..< Int(maxSubLayersMinus1) {
        guard let profileFlag = reader.read(1), let levelFlag = reader.read(1) else { return nil }
        profilePresent.append(profileFlag == 1)
        levelPresent.append(levelFlag == 1)
      }
      if maxSubLayersMinus1 > 0 {
        guard reader.skip(2 * (8 - Int(maxSubLayersMinus1))) else { return nil }
      }
      for index in 0 ..< Int(maxSubLayersMinus1) {
        if profilePresent[index] { guard reader.skip(88) else { return nil } }
        if levelPresent[index] { guard reader.skip(8) else { return nil } }
      }

      guard reader.readExpGolomb() != nil, let chroma = reader.readExpGolomb() else { return nil }
      if chroma == 3 { guard reader.skip(1) else { return nil } }
      guard reader.readExpGolomb() != nil, reader.readExpGolomb() != nil,
        let conformanceWindow = reader.read(1)
      else { return nil }
      if conformanceWindow == 1 {
        for _ in 0 ..< 4 { guard reader.readExpGolomb() != nil else { return nil } }
      }
      guard let lumaDepth = reader.readExpGolomb(), let chromaDepth = reader.readExpGolomb() else {
        return nil
      }

      self.maxSubLayersMinus1 = UInt8(maxSubLayersMinus1)
      temporalIDNesting = UInt8(nesting)
      self.profileSpace = UInt8(profileSpace)
      tierFlag = UInt8(tier)
      profileIDC = UInt8(profile)
      compatibilityFlags = compatibility
      constraintFlags = constraints
      levelIDC = UInt8(level)
      chromaFormatIDC = UInt8(min(chroma, 3))
      bitDepthLumaMinus8 = UInt8(min(lumaDepth, 7))
      bitDepthChromaMinus8 = UInt8(min(chromaDepth, 7))
    }

    /// Drops the emulation prevention byte from every `00 00 03`, which the encoder inserted so the
    /// payload can never look like a start code.
    static func rbsp(_ bytes: [UInt8]) -> [UInt8] {
      var out: [UInt8] = []
      out.reserveCapacity(bytes.count)
      var zeros = 0
      for byte in bytes {
        if zeros >= 2, byte == 0x03 {
          zeros = 0
          continue
        }
        out.append(byte)
        zeros = byte == 0 ? zeros + 1 : 0
      }
      return out
    }
  }

  struct BitReader {
    let bytes: [UInt8]
    var position = 0

    init(bytes: [UInt8]) {
      self.bytes = bytes
    }

    mutating func read(_ count: Int) -> UInt32? {
      guard count <= 32, position + count <= bytes.count * 8 else { return nil }
      var value: UInt32 = 0
      for _ in 0 ..< count {
        let bit = (bytes[position >> 3] >> (7 - UInt8(position & 7))) & 1
        value = (value << 1) | UInt32(bit)
        position += 1
      }
      return value
    }

    mutating func skip(_ count: Int) -> Bool {
      guard position + count <= bytes.count * 8 else { return false }
      position += count
      return true
    }

    /// ue(v): leading zeros, a one, then that many bits.
    mutating func readExpGolomb() -> UInt32? {
      var zeros = 0
      while true {
        guard let bit = read(1) else { return nil }
        if bit == 1 { break }
        zeros += 1
        if zeros > 31 { return nil }
      }
      guard let tail = read(zeros) else { return nil }
      return (UInt32(1) << UInt32(zeros)) - 1 + tail
    }
  }
}
