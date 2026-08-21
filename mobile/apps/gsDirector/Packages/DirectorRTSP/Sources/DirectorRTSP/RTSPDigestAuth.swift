import CryptoKit
import Foundation

/// A `WWW-Authenticate` challenge.
///
/// Kept small on purpose: none of the cameras in use demands authentication, so this is defensive
/// cover for a camera that gets a password set later, not a load-bearing path.
public struct RTSPAuthChallenge: Sendable, Equatable {
  public enum Scheme: String, Sendable {
    case basic
    case digest
  }

  public let scheme: Scheme
  public let realm: String
  public let nonce: String?
  public let opaque: String?
  public let algorithm: String?
  public let qop: String?

  public init(
    scheme: Scheme,
    realm: String,
    nonce: String? = nil,
    opaque: String? = nil,
    algorithm: String? = nil,
    qop: String? = nil
  ) {
    self.scheme = scheme
    self.realm = realm
    self.nonce = nonce
    self.opaque = opaque
    self.algorithm = algorithm
    self.qop = qop
  }

  public static func parse(_ header: String) -> RTSPAuthChallenge? {
    let trimmed = header.trimmingCharacters(in: .whitespaces)
    guard let space = trimmed.firstIndex(of: " ") else { return nil }
    guard let scheme = Scheme(rawValue: String(trimmed[trimmed.startIndex ..< space]).lowercased()) else {
      return nil
    }

    var parameters: [String: String] = [:]
    for pair in Self.splitParameters(String(trimmed[trimmed.index(after: space)...])) {
      guard let separator = pair.firstIndex(of: "=") else { continue }
      let name = String(pair[pair.startIndex ..< separator]).trimmingCharacters(in: .whitespaces).lowercased()
      var value = String(pair[pair.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
      if value.hasPrefix("\""), value.hasSuffix("\""), value.count >= 2 {
        value = String(value.dropFirst().dropLast())
      }
      parameters[name] = value
    }

    return RTSPAuthChallenge(
      scheme: scheme,
      realm: parameters["realm"] ?? "",
      nonce: parameters["nonce"],
      opaque: parameters["opaque"],
      algorithm: parameters["algorithm"],
      qop: parameters["qop"]
    )
  }

  /// Commas inside quoted values are not separators, and splitting on every comma corrupts any
  /// realm containing one.
  private static func splitParameters(_ text: String) -> [String] {
    var result: [String] = []
    var current = ""
    var inQuotes = false
    for character in text {
      switch character {
      case "\"":
        inQuotes.toggle()
        current.append(character)
      case "," where !inQuotes:
        result.append(current)
        current = ""
      default:
        current.append(character)
      }
    }
    if !current.isEmpty { result.append(current) }
    return result
  }
}

public enum RTSPAuthorization {
  /// Builds the `Authorization` header value for a challenge (RFC 2617 MD5).
  public static func header(
    for challenge: RTSPAuthChallenge,
    method: RTSPMethod,
    uri: String,
    username: String,
    password: String,
    clientNonce: String = UUID().uuidString.replacingOccurrences(of: "-", with: ""),
    nonceCount: Int = 1
  ) -> String {
    switch challenge.scheme {
    case .basic:
      let credentials = Data("\(username):\(password)".utf8).base64EncodedString()
      return "Basic \(credentials)"

    case .digest:
      let nonce = challenge.nonce ?? ""
      let ha1 = md5("\(username):\(challenge.realm):\(password)")
      let ha2 = md5("\(method.rawValue):\(uri)")

      var fields = [
        "username=\"\(username)\"",
        "realm=\"\(challenge.realm)\"",
        "nonce=\"\(nonce)\"",
        "uri=\"\(uri)\""
      ]

      let response: String
      if let qop = challenge.qop, qop.split(separator: ",").contains(where: {
        $0.trimmingCharacters(in: .whitespaces) == "auth"
      }) {
        let counter = String(format: "%08x", nonceCount)
        response = md5("\(ha1):\(nonce):\(counter):\(clientNonce):auth:\(ha2)")
        fields.append("qop=auth")
        fields.append("nc=\(counter)")
        fields.append("cnonce=\"\(clientNonce)\"")
      } else {
        response = md5("\(ha1):\(nonce):\(ha2)")
      }

      fields.append("response=\"\(response)\"")
      if let opaque = challenge.opaque { fields.append("opaque=\"\(opaque)\"") }
      return "Digest " + fields.joined(separator: ", ")
    }
  }

  static func md5(_ text: String) -> String {
    Insecure.MD5.hash(data: Data(text.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }
}
