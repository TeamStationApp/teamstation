import Foundation

/// `rtmp://host[:port]/app/streamName` — the only URL shape classic RTMP ingest accepts.
public struct RTMPURL: Sendable, Equatable {
  public var host: String
  public var port: Int
  public var app: String
  public var stream: String

  public var tcURL: String { "rtmp://\(host):\(port)/\(app)" }
  public var description: String { "\(tcURL)/\(stream)" }

  public enum ParseError: Error, CustomStringConvertible, Equatable {
    case empty
    case notRTMP
    case rtmpsUnsupported
    case missingHost
    case missingApp
    case missingStream

    public var description: String {
      switch self {
      case .empty: "set a stream URL in Settings"
      case .notRTMP: "stream URL must start with rtmp://"
      case .rtmpsUnsupported: "rtmps:// is not supported yet — use rtmp://"
      case .missingHost: "stream URL is missing a host"
      case .missingApp: "stream URL needs an application name, e.g. rtmp://host/live/key"
      case .missingStream: "stream URL needs a stream key after the application name"
      }
    }
  }

  public static func parse(_ raw: String) -> Result<RTMPURL, ParseError> {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return .failure(.empty) }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("rtmps://") { return .failure(.rtmpsUnsupported) }
    guard lower.hasPrefix("rtmp://") else { return .failure(.notRTMP) }

    guard let url = URL(string: trimmed), let host = url.host, !host.isEmpty else {
      return .failure(.missingHost)
    }
    let port = url.port ?? 1935
    let parts = url.path.split(separator: "/").map(String.init).filter { !$0.isEmpty }
    guard let app = parts.first, !app.isEmpty else { return .failure(.missingApp) }
    let stream = parts.dropFirst().joined(separator: "/")
    guard !stream.isEmpty else { return .failure(.missingStream) }
    return .success(RTMPURL(host: host, port: port, app: app, stream: stream))
  }
}
