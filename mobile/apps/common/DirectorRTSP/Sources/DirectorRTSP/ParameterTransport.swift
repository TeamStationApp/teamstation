import Foundation

/// One reply to a parameter request, whatever carried it.
public struct ParameterReply: Sendable, Equatable {
  public var statusCode: Int
  public var reasonPhrase: String
  public var body: String

  public init(statusCode: Int, reasonPhrase: String, body: String) {
    self.statusCode = statusCode
    self.reasonPhrase = reasonPhrase
    self.body = body
  }

  public var isSuccess: Bool { (200 ..< 300).contains(statusCode) }
}

public enum ParameterTransportState: Sendable, Equatable {
  case idle
  case connecting
  case ready
  /// The camera answered `OPTIONS` without `SET_PARAMETER`: an older build.
  case unsupported
  case failed(String)
}

/// What `RemoteCameraControl` needs from the wire: send a `text/parameters` body, get one back.
///
/// A protocol rather than the RTSP session itself so the model's polling, coalescing and
/// error handling are unit-tested against a scripted double with no socket in the process.
public protocol ParameterTransport: AnyObject, Sendable {
  var state: ParameterTransportState { get }
  func start()
  func stop()
  /// `GET_PARAMETER` with `body` (`*` for everything).
  func get(_ body: String) async throws -> ParameterReply
  /// `SET_PARAMETER` with `body`.
  func set(_ body: String) async throws -> ParameterReply
}
