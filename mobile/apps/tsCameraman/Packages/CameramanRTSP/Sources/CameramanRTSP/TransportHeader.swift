import Foundation

/// The `Transport` header a client sends with `SETUP`, per RFC 2326 §12.39.
///
/// Only TCP interleaving is accepted. UDP would mean discovering the client's address, holding two
/// sockets per track and handling NAT, and every client this camera serves — TS Director, ffmpeg and
/// VLC — falls back to interleaved when offered nothing else.
public struct TransportHeader: Sendable, Equatable {
  public enum Lower: Sendable, Equatable {
    case tcp
    case udp
  }

  public var lower: Lower
  /// Present only for interleaved TCP. The data channel; control is conventionally the next one up.
  public var interleavedChannels: (data: UInt8, control: UInt8)?
  public var isMulticast: Bool

  public init(
    lower: Lower,
    interleavedChannels: (data: UInt8, control: UInt8)? = nil,
    isMulticast: Bool = false
  ) {
    self.lower = lower
    self.interleavedChannels = interleavedChannels
    self.isMulticast = isMulticast
  }

  public static func == (lhs: TransportHeader, rhs: TransportHeader) -> Bool {
    lhs.lower == rhs.lower
      && lhs.isMulticast == rhs.isMulticast
      && lhs.interleavedChannels?.data == rhs.interleavedChannels?.data
      && lhs.interleavedChannels?.control == rhs.interleavedChannels?.control
  }

  /// A client may offer several transports separated by commas, in descending preference. The first
  /// one this server can honour wins; returning nil means none of them.
  public static func parse(_ value: String) -> TransportHeader? {
    for specification in value.split(separator: ",") {
      if let parsed = parseSpecification(String(specification)) { return parsed }
    }
    return nil
  }

  private static func parseSpecification(_ specification: String) -> TransportHeader? {
    let parameters = specification.split(separator: ";").map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard let profile = parameters.first?.uppercased() else { return nil }
    guard profile.hasPrefix("RTP/AVP") else { return nil }

    let isTCP = profile == "RTP/AVP/TCP"
    var isMulticast = false
    var channels: (data: UInt8, control: UInt8)?

    for parameter in parameters.dropFirst() {
      let parts = parameter.split(separator: "=", maxSplits: 1).map(String.init)
      switch parts[0].lowercased() {
      case "multicast":
        isMulticast = true
      case "interleaved":
        guard parts.count == 2 else { continue }
        channels = parseChannels(parts[1])
      default:
        break
      }
    }

    guard isTCP, !isMulticast else { return nil }
    return TransportHeader(lower: .tcp, interleavedChannels: channels, isMulticast: false)
  }

  /// `interleaved=0-1`, or a bare `interleaved=0` which implies the control channel is the next one.
  private static func parseChannels(_ value: String) -> (data: UInt8, control: UInt8)? {
    let parts = value.split(separator: "-").map(String.init)
    guard let data = parts.first.flatMap({ UInt8($0) }) else { return nil }
    if parts.count > 1, let control = UInt8(parts[1]) { return (data, control) }
    guard data < UInt8.max else { return nil }
    return (data, data + 1)
  }

  /// The header echoed back in the SETUP response. The client reads the channel numbers from here, so
  /// they must be the ones the server will actually use rather than the ones requested.
  public func responseValue(dataChannel: UInt8, controlChannel: UInt8) -> String {
    "RTP/AVP/TCP;unicast;interleaved=\(dataChannel)-\(controlChannel)"
  }
}
