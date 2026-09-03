import Foundation

public extension VideoCodec {
  /// What the operator's camera list calls this codec.
  var displayName: String {
    switch self {
    case .h264: "H.264"
    case .hevc: "HEVC"
    }
  }
}

public enum VideoCodec: String, Sendable, Equatable {
  case h264
  case hevc
}

/// The session description a `DESCRIBE` returns, reduced to the handful of facts needed to set up
/// and decode the streams.
public struct SDPDescription: Sendable, Equatable {
  public struct RTPMap: Sendable, Equatable {
    public let payloadType: Int
    public let encodingName: String
    public let clockRate: Int
    public let channels: Int?
  }

  public struct Media: Sendable, Equatable {
    public enum Kind: String, Sendable {
      case video
      case audio
      case other
    }

    public let kind: Kind
    public let payloadTypes: [Int]
    public let control: String?
    public let rtpMap: RTPMap?
    /// `fmtp` parameters, keys lower-cased. Values keep their original case because they carry
    /// base64 and hex payloads.
    public let formatParameters: [String: String]
    /// `a=ssrc:<id> cname:<value>` per RFC 5576. The same identifier the sender repeats in its RTCP
    /// SDES, so a camera can be recognised across an address change. Absent on cameras that do not
    /// send it, which is most of them.
    public let cname: String?
    /// `a=ssrc:<id> name:<value>` — the human-readable label, when the sender includes one.
    public let name: String?

    public var videoCodec: VideoCodec? {
      switch rtpMap?.encodingName.uppercased() {
      case "H264": .h264
      case "H265", "HEVC": .hevc
      default: nil
      }
    }

    /// Decoder configuration carried in the SDP. Also arrives in-band on these cameras, but a
    /// decoder that waits for the in-band copy shows a black tile until the next keyframe.
    public var parameterSets: [Data] {
      switch videoCodec {
      case .h264:
        // Comma-separated base64: SPS first, then PPS.
        (formatParameters["sprop-parameter-sets"] ?? "")
          .split(separator: ",")
          .compactMap { Data(base64Encoded: String($0).trimmingCharacters(in: .whitespaces)) }
      case .hevc:
        // Order matters to `CMVideoFormatDescriptionCreateFromHEVCParameterSets`.
        [ "sprop-vps", "sprop-sps", "sprop-pps" ]
          .compactMap { formatParameters[$0] }
          .compactMap { Data(base64Encoded: $0.trimmingCharacters(in: .whitespaces)) }
      case nil:
        []
      }
    }

    /// AAC's `AudioSpecificConfig`, sent as hex in `config=`.
    public var audioSpecificConfig: Data? {
      formatParameters["config"].flatMap { Data(hexEncoded: $0) }
    }

    public var aacFraming: AACFraming? {
      guard rtpMap?.encodingName.lowercased() == "mpeg4-generic" else { return nil }
      return AACFraming(
        sizeLength: formatParameters["sizelength"].flatMap { Int($0) } ?? 13,
        indexLength: formatParameters["indexlength"].flatMap { Int($0) } ?? 3,
        indexDeltaLength: formatParameters["indexdeltalength"].flatMap { Int($0) } ?? 3
      )
    }
  }

  /// Session-level `a=control`, usually `*`. Kept apart from the media controls so it cannot be
  /// mistaken for a track.
  public let sessionControl: String?
  public let sessionName: String?
  public let media: [Media]

  public var video: Media? { media.first { $0.kind == .video } }
  public var audio: Media? { media.first { $0.kind == .audio } }
  public var streamCNAME: String? { video?.cname ?? audio?.cname }
  public var streamName: String? { video?.name ?? audio?.name }

  public static func parse(_ text: String) -> SDPDescription {
    var sessionControl: String?
    var sessionName: String?
    var media: [Media] = []

    var kind: Media.Kind?
    var payloadTypes: [Int] = []
    var control: String?
    var rtpMap: RTPMap?
    var formatParameters: [String: String] = [:]
    var cname: String?
    var sdesName: String?

    func flush() {
      guard let kind else { return }
      media.append(Media(
        kind: kind,
        payloadTypes: payloadTypes,
        control: control,
        rtpMap: rtpMap,
        formatParameters: formatParameters,
        cname: cname,
        name: sdesName
      ))
    }

    for rawLine in text.components(separatedBy: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      guard line.count > 2, line.dropFirst().first == "=" else { continue }
      let field = line.first
      let value = String(line.dropFirst(2))

      switch field {
      case "s":
        sessionName = value
      case "m":
        flush()
        let parts = value.split(separator: " ").map(String.init)
        kind = switch parts.first?.lowercased() {
        case "video": .video
        case "audio": .audio
        default: .other
        }
        payloadTypes = parts.count > 3 ? parts[3...].compactMap { Int($0) } : []
        control = nil
        rtpMap = nil
        formatParameters = [:]
        cname = nil
        sdesName = nil
      case "a":
        let (name, attribute) = Self.splitAttribute(value)
        switch name {
        case "control":
          // Before the first `m=` line this is the session control, not a track.
          if kind == nil { sessionControl = attribute } else { control = attribute }
        case "rtpmap":
          rtpMap = Self.parseRTPMap(attribute)
        case "fmtp":
          formatParameters = Self.parseFormatParameters(attribute)
        case "ssrc":
          cname = Self.parseSSRCAttribute(attribute, named: "cname") ?? cname
          sdesName = Self.parseSSRCAttribute(attribute, named: "name") ?? sdesName
        default:
          break
        }
      default:
        break
      }
    }
    flush()

    return SDPDescription(sessionControl: sessionControl, sessionName: sessionName, media: media)
  }

  /// Resolves a track's `a=control` against the session's base, per RFC 2326 C.1.1.
  ///
  /// Cameras send all three forms: an absolute URL, a bare `trackID=0`, and `*` meaning "the base
  /// itself". Getting this wrong produces a `SETUP` on a URL the camera answers with `404`.
  public static func absoluteControlURL(control: String?, base: String) -> String {
    guard let control, !control.isEmpty, control != "*" else { return base }
    if control.lowercased().hasPrefix("rtsp://") { return control }
    if control.hasPrefix("/") {
      guard let range = base.range(of: "://"),
            let pathStart = base[range.upperBound...].firstIndex(of: "/")
      else { return base + control }
      return String(base[base.startIndex ..< pathStart]) + control
    }
    return base.hasSuffix("/") ? base + control : base + "/" + control
  }

  /// `1234567 cname:phone@example` reduced to the value of the named attribute.
  ///
  /// A sender lists several attributes for one SSRC on separate lines, so this reads one line and
  /// returns nil for the ones that carry something else.
  private static func parseSSRCAttribute(_ value: String, named wanted: String) -> String? {
    let parts = value.split(separator: " ", maxSplits: 1)
    guard parts.count == 2, UInt32(parts[0]) != nil else { return nil }
    let (name, argument) = splitAttribute(String(parts[1]))
    guard name == wanted, !argument.isEmpty else { return nil }
    return argument.trimmingCharacters(in: .whitespaces)
  }

  private static func splitAttribute(_ value: String) -> (name: String, argument: String) {
    guard let separator = value.firstIndex(of: ":") else {
      return (value.lowercased(), "")
    }
    return (
      String(value[value.startIndex ..< separator]).lowercased(),
      String(value[value.index(after: separator)...])
    )
  }

  /// `96 H265/90000` or `98 mpeg4-generic/32000/2`.
  private static func parseRTPMap(_ value: String) -> RTPMap? {
    let parts = value.split(separator: " ", maxSplits: 1)
    guard parts.count == 2, let payloadType = Int(parts[0]) else { return nil }
    let fields = parts[1].split(separator: "/").map(String.init)
    guard let encoding = fields.first else { return nil }
    return RTPMap(
      payloadType: payloadType,
      encodingName: encoding,
      clockRate: fields.count > 1 ? Int(fields[1]) ?? 90_000 : 90_000,
      channels: fields.count > 2 ? Int(fields[2]) : nil
    )
  }

  /// `96 packetization-mode=1; profile-level-id=4DC01F; sprop-parameter-sets=Z0...,aM...`
  ///
  /// Both spellings occur on these cameras — the video line separates with `; ` and the audio line
  /// with a bare `;` — and base64 values contain `=`, so only the first one may split a pair.
  private static func parseFormatParameters(_ value: String) -> [String: String] {
    let withoutPayloadType = value.split(separator: " ", maxSplits: 1)
    guard withoutPayloadType.count == 2 else { return [:] }

    var result: [String: String] = [:]
    for pair in withoutPayloadType[1].split(separator: ";") {
      let trimmed = pair.trimmingCharacters(in: .whitespaces)
      guard let separator = trimmed.firstIndex(of: "=") else { continue }
      let name = String(trimmed[trimmed.startIndex ..< separator]).lowercased()
      result[name] = String(trimmed[trimmed.index(after: separator)...])
    }
    return result
  }
}

public struct AACFraming: Sendable, Equatable {
  public let sizeLength: Int
  public let indexLength: Int
  public let indexDeltaLength: Int

  public init(sizeLength: Int, indexLength: Int, indexDeltaLength: Int) {
    self.sizeLength = sizeLength
    self.indexLength = indexLength
    self.indexDeltaLength = indexDeltaLength
  }
}

/// The first bits of an `AudioSpecificConfig`: enough to build a decoder input format.
public struct AudioSpecificConfig: Sendable, Equatable {
  public static let sampleRates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050,
    16_000, 12_000, 11_025, 8_000, 7_350
  ]

  public let objectType: Int
  public let sampleRate: Int
  public let channelCount: Int

  public init?(_ data: Data) {
    guard data.count >= 2 else { return nil }
    var reader = BitReader(data)
    guard
      let objectType = reader.read(bits: 5),
      let frequencyIndex = reader.read(bits: 4)
    else { return nil }

    let sampleRate: Int
    if frequencyIndex == 0x0F {
      guard let explicit = reader.read(bits: 24) else { return nil }
      sampleRate = Int(explicit)
    } else {
      guard frequencyIndex < Self.sampleRates.count else { return nil }
      sampleRate = Self.sampleRates[Int(frequencyIndex)]
    }
    guard let channels = reader.read(bits: 4) else { return nil }

    self.objectType = Int(objectType)
    self.sampleRate = sampleRate
    self.channelCount = max(1, Int(channels))
  }
}

extension Data {
  /// Decodes an even-length hex string, ignoring surrounding whitespace.
  init?(hexEncoded text: String) {
    let characters = Array(text.trimmingCharacters(in: .whitespaces))
    guard characters.count.isMultiple(of: 2) else { return nil }
    var bytes = [UInt8]()
    bytes.reserveCapacity(characters.count / 2)
    for index in stride(from: 0, to: characters.count, by: 2) {
      guard let byte = UInt8(String(characters[index ... index + 1]), radix: 16) else { return nil }
      bytes.append(byte)
    }
    self.init(bytes)
  }
}
