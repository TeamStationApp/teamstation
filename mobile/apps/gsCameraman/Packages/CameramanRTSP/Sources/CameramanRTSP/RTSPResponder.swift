import CameramanCore
import Foundation

/// Turns one client's requests into responses.
///
/// Pure and synchronous on purpose: the whole RTSP method sequence, including the error paths a real
/// client provokes, is testable without a socket, a camera or an encoder.
public struct RTSPResponder: Sendable {
  public struct Setup: Sendable, Equatable {
    public enum Track: Sendable, Equatable {
      case video
      case audio
    }

    public var track: Track
    public var dataChannel: UInt8
    public var controlChannel: UInt8

    public init(track: Track, dataChannel: UInt8, controlChannel: UInt8) {
      self.track = track
      self.dataChannel = dataChannel
      self.controlChannel = controlChannel
    }
  }

  public enum State: Sendable, Equatable {
    case initial
    case ready
    case playing
  }

  /// What the connection should do after answering, beyond sending the response.
  public enum Effect: Sendable, Equatable {
    case none
    case startStreaming(video: Setup, audio: Setup?)
    case stopStreaming
    case close
  }

  public struct Outcome: Sendable {
    public var response: RTSPServerResponse
    public var effect: Effect
  }

  /// A `GET_PARAMETER` with a body, or a `SET_PARAMETER`. The body is `text/parameters`; what the
  /// names mean is `CameraParameters`' business, not this state machine's.
  public struct ParameterRequest: Sendable, Equatable {
    public enum Method: Sendable, Equatable {
      case get
      case set
    }

    public var method: Method
    public var body: String

    public init(method: Method, body: String) {
      self.method = method
      self.body = body
    }
  }

  public struct ParameterResponse: Sendable, Equatable {
    public var statusCode: Int
    public var reasonPhrase: String
    /// `text/parameters`; empty means no body.
    public var body: String

    public init(statusCode: Int = 200, reasonPhrase: String = "OK", body: String = "") {
      self.statusCode = statusCode
      self.reasonPhrase = reasonPhrase
      self.body = body
    }
  }

  /// Answers parameter requests. Synchronous, because the connection needs the reply before it
  /// can read the next request on the socket; the phone hops to the main actor inside it.
  public typealias ParameterHandler = @Sendable (ParameterRequest) -> ParameterResponse

  public static let supportedMethods =
    "OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER"
  public static let parametersContentType = "text/parameters"

  /// RFC 2326 §12.37. A client that sends no keepalive is dropped after this, which is what stops a
  /// phone that walked out of range from holding the stream open forever.
  public static let sessionTimeout = 60

  public let sessionIdentifier: String
  public let sdp: String
  public let hasAudio: Bool
  /// Nil means the server has no parameters to offer: a named `GET` is then `451` and a `SET` is
  /// `501`, which is what this server answered before it had any.
  public let parameters: ParameterHandler?

  public private(set) var state: State = .initial
  public private(set) var videoSetup: Setup?
  public private(set) var audioSetup: Setup?

  public init(
    sessionIdentifier: String,
    sdp: String,
    hasAudio: Bool,
    parameters: ParameterHandler? = nil
  ) {
    self.sessionIdentifier = sessionIdentifier
    self.sdp = sdp
    self.hasAudio = hasAudio
    self.parameters = parameters
  }

  public mutating func respond(to request: RTSPServerRequest) -> Outcome {
    let cseq = request.cseq

    // Once a session exists, a request carrying the wrong identifier must not be allowed to act on
    // it. RFC 2326 §11.3.14 is the status code for that.
    if let session = request.session, session != sessionIdentifier {
      return Outcome(
        response: .status(454, "Session Not Found", cseq: cseq),
        effect: .none
      )
    }

    switch request.method {
    case "OPTIONS":
      return Outcome(response: options(cseq: cseq), effect: .none)
    case "DESCRIBE":
      return Outcome(response: describe(request, cseq: cseq), effect: .none)
    case "SETUP":
      return setup(request, cseq: cseq)
    case "PLAY":
      return play(cseq: cseq)
    case "PAUSE":
      return pause(cseq: cseq)
    case "TEARDOWN":
      state = .initial
      videoSetup = nil
      audioSetup = nil
      return Outcome(
        response: RTSPServerResponse(headers: base(cseq: cseq, includeSession: true)),
        effect: .close
      )
    case "GET_PARAMETER":
      // Empty body means "keepalive", which is how every client holds a session open. A body names
      // parameters; `*` is all of them. Neither needs a session: these are server-level values.
      guard !request.body.isEmpty else {
        return Outcome(
          response: RTSPServerResponse(headers: base(cseq: cseq, includeSession: state != .initial)),
          effect: .none
        )
      }
      return Outcome(response: parameters(.get, request, cseq: cseq), effect: .none)
    case "SET_PARAMETER":
      guard parameters != nil else {
        return Outcome(response: .status(501, "Not Implemented", cseq: cseq), effect: .none)
      }
      // RFC 2326 §10.9 allows an empty `SET_PARAMETER` as a keepalive too.
      guard !request.body.isEmpty else {
        return Outcome(
          response: RTSPServerResponse(headers: base(cseq: cseq, includeSession: state != .initial)),
          effect: .none
        )
      }
      return Outcome(response: parameters(.set, request, cseq: cseq), effect: .none)
    default:
      return Outcome(response: .status(501, "Not Implemented", cseq: cseq), effect: .none)
    }
  }

  private func parameters(
    _ method: ParameterRequest.Method,
    _ request: RTSPServerRequest,
    cseq: String?
  ) -> RTSPServerResponse {
    guard let parameters else {
      return .status(451, "Parameter Not Understood", cseq: cseq)
    }
    let body = String(decoding: request.body, as: UTF8.self)
    let answer = parameters(ParameterRequest(method: method, body: body))
    var headers = base(cseq: cseq, includeSession: state != .initial)
    if !answer.body.isEmpty {
      headers.append((name: "Content-Type", value: Self.parametersContentType))
    }
    return RTSPServerResponse(
      statusCode: answer.statusCode,
      reasonPhrase: answer.reasonPhrase,
      headers: headers,
      body: Data(answer.body.utf8)
    )
  }

  private func options(cseq: String?) -> RTSPServerResponse {
    var headers = base(cseq: cseq, includeSession: false)
    headers.append((name: "Public", value: Self.supportedMethods))
    return RTSPServerResponse(headers: headers)
  }

  private func describe(_ request: RTSPServerRequest, cseq: String?) -> RTSPServerResponse {
    // A client that asks for a format this server cannot produce must be told so rather than handed
    // an SDP it did not ask for.
    if let accept = request.headers["accept"],
       !accept.lowercased().contains("application/sdp") {
      return .status(406, "Not Acceptable", cseq: cseq)
    }

    var headers = base(cseq: cseq, includeSession: false)
    headers.append((name: "Content-Type", value: "application/sdp"))
    // RFC 2326 §12.11: without this the client resolves relative track controls against the request
    // URI, which differs from the URI this server considers canonical.
    headers.append((name: "Content-Base", value: request.uri.hasSuffix("/") ? request.uri : request.uri + "/"))
    return RTSPServerResponse(headers: headers, body: Data(sdp.utf8))
  }

  private mutating func setup(_ request: RTSPServerRequest, cseq: String?) -> Outcome {
    guard state != .playing else {
      // Changing transport mid-stream would mean renegotiating channels the sender is already using.
      return Outcome(response: .status(455, "Method Not Valid In This State", cseq: cseq), effect: .none)
    }
    guard let transportValue = request.headers["transport"] else {
      return Outcome(response: .status(400, "Bad Request", cseq: cseq), effect: .none)
    }
    guard let transport = TransportHeader.parse(transportValue) else {
      // RFC 2326 §11.3.9, the specific code for "none of your offered transports".
      return Outcome(response: .status(461, "Unsupported Transport", cseq: cseq), effect: .none)
    }
    guard let track = Self.track(forURI: request.uri, hasAudio: hasAudio) else {
      return Outcome(response: .status(404, "Not Found", cseq: cseq), effect: .none)
    }

    // Honour the client's channel numbers when it names them. ffmpeg assigns them itself and reads
    // its own numbers back, so overriding them silently sends media on channels it ignores.
    let channels = transport.interleavedChannels ?? Self.defaultChannels(for: track)
    let setup = Setup(track: track, dataChannel: channels.data, controlChannel: channels.control)

    switch track {
    case .video: videoSetup = setup
    case .audio: audioSetup = setup
    }
    state = .ready

    var headers = base(cseq: cseq, includeSession: true)
    headers.append((name: "Transport", value: transport.responseValue(
      dataChannel: setup.dataChannel,
      controlChannel: setup.controlChannel
    )))
    return Outcome(response: RTSPServerResponse(headers: headers), effect: .none)
  }

  private mutating func play(cseq: String?) -> Outcome {
    guard let videoSetup else {
      // Nothing was set up, so there is no transport to send on.
      return Outcome(response: .status(455, "Method Not Valid In This State", cseq: cseq), effect: .none)
    }

    state = .playing
    var headers = base(cseq: cseq, includeSession: true)
    // Live capture has no known start, so the range is open-ended. `RTP-Info` is added by the
    // connection, which is the only part that knows the sequence numbers it is about to send.
    headers.append((name: "Range", value: "npt=now-"))
    return Outcome(
      response: RTSPServerResponse(headers: headers),
      effect: .startStreaming(video: videoSetup, audio: audioSetup)
    )
  }

  private mutating func pause(cseq: String?) -> Outcome {
    guard state == .playing else {
      return Outcome(response: .status(455, "Method Not Valid In This State", cseq: cseq), effect: .none)
    }
    state = .ready
    return Outcome(
      response: RTSPServerResponse(headers: base(cseq: cseq, includeSession: true)),
      effect: .stopStreaming
    )
  }

  private func base(cseq: String?, includeSession: Bool) -> [(name: String, value: String)] {
    var headers: [(name: String, value: String)] = []
    if let cseq { headers.append((name: "CSeq", value: cseq)) }
    headers.append((name: "Server", value: "GS Cameraman/1.0"))
    if includeSession {
      headers.append((
        name: "Session",
        value: "\(sessionIdentifier);timeout=\(Self.sessionTimeout)"
      ))
    }
    return headers
  }

  /// Matches the track from the control URL the SDP advertised. A URI naming no known track has to be
  /// a 404 rather than a guess, since guessing sends video down a channel the client reads as audio.
  static func track(forURI uri: String, hasAudio: Bool) -> Setup.Track? {
    if uri.contains(SDPBuilder.videoTrackControl) { return .video }
    if uri.contains(SDPBuilder.audioTrackControl) { return hasAudio ? .audio : nil }
    return nil
  }

  static func defaultChannels(for track: Setup.Track) -> (data: UInt8, control: UInt8) {
    switch track {
    case .video: (InterleavedChannel.video, InterleavedChannel.videoControl)
    case .audio: (InterleavedChannel.audio, InterleavedChannel.audioControl)
    }
  }

  /// RFC 2326 gives no format for this beyond "8 or more octets". A random 64-bit value makes a
  /// second client's guess at another client's session implausible.
  public static func generateSessionIdentifier() -> String {
    String(UInt64.random(in: UInt64(1) << 40 ... UInt64.max), radix: 16, uppercase: false)
  }
}
