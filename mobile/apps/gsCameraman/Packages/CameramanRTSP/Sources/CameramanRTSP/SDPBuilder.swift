import CameramanCore
import CameramanEncode
import Foundation

/// Builds the session description returned by `DESCRIBE`.
///
/// The decoder configuration goes in here as well as in-band, because a client that waits for the
/// in-band copy shows nothing until the next keyframe.
public struct SDPBuilder: Sendable {
  /// Dynamic payload types from the 96–127 range. Fixed rather than negotiated, which is what every
  /// camera this pipeline talks to does.
  public static let videoPayloadType: UInt8 = 96
  public static let audioPayloadType: UInt8 = 97

  public struct VideoTrack: Sendable {
    public var codec: StreamCodec
    public var parameterSets: [Data]
    public var width: Int
    public var height: Int

    public init(codec: StreamCodec, parameterSets: [Data], width: Int, height: Int) {
      self.codec = codec
      self.parameterSets = parameterSets
      self.width = width
      self.height = height
    }
  }

  public struct AudioTrack: Sendable {
    public var audioSpecificConfig: Data
    public var sampleRate: Int
    public var channelCount: Int

    public init(audioSpecificConfig: Data, sampleRate: Int, channelCount: Int) {
      self.audioSpecificConfig = audioSpecificConfig
      self.sampleRate = sampleRate
      self.channelCount = channelCount
    }
  }

  public var identity: DeviceIdentity
  public var video: VideoTrack
  public var audio: AudioTrack?
  public var videoSSRC: UInt32
  public var audioSSRC: UInt32

  public init(
    identity: DeviceIdentity,
    video: VideoTrack,
    audio: AudioTrack?,
    videoSSRC: UInt32,
    audioSSRC: UInt32
  ) {
    self.identity = identity
    self.video = video
    self.audio = audio
    self.videoSSRC = videoSSRC
    self.audioSSRC = audioSSRC
  }

  /// CRLF-terminated, per RFC 4566 §5. Some clients tolerate bare LF; VLC and ffmpeg both want CRLF.
  public func build() -> String {
    var lines: [String] = [
      "v=0",
      // A zero address with a zero network type is the standard "unicast, address unknown" form; the
      // transport is settled by SETUP, not here.
      "o=- 0 0 IN IP4 0.0.0.0",
      "s=\(identity.name)",
      "t=0 0",
      "a=tool:GS Cameraman",
      "a=control:*",
      "a=range:npt=now-",
      // Live capture has no seek, and a client that thinks otherwise sends a PLAY with a Range it
      // cannot get.
      "a=type:broadcast"
    ]

    lines.append(contentsOf: videoLines())
    if let audio { lines.append(contentsOf: audioLines(audio)) }

    return lines.joined(separator: "\r\n") + "\r\n"
  }

  private func videoLines() -> [String] {
    var lines = [
      "m=video 0 RTP/AVP \(Self.videoPayloadType)",
      "c=IN IP4 0.0.0.0",
      "a=rtpmap:\(Self.videoPayloadType) \(video.codec.sdpEncodingName)/\(H264Packetizer.clockRate)",
      "a=control:\(SDPBuilder.videoTrackControl)"
    ]

    switch video.codec {
    case .h264:
      // Comma-separated base64, SPS then PPS.
      let sets = video.parameterSets.map { $0.base64EncodedString() }.joined(separator: ",")
      var parameters = [ "packetization-mode=1", "sprop-parameter-sets=\(sets)" ]
      // profile-level-id is what a client uses to decide whether it can decode the stream at all, and
      // it has to agree with the SPS or the decision is made on the wrong numbers.
      if let sps = video.parameterSets.first,
         let profileLevelID = ParameterSets.h264ProfileLevelID(sps: sps) {
        parameters.insert("profile-level-id=\(profileLevelID)", at: 0)
      }
      lines.append("a=fmtp:\(Self.videoPayloadType) \(parameters.joined(separator: "; "))")
    case .hevc:
      // Separate attributes in VPS, SPS, PPS order, which is the order the receiver has to feed them
      // to the decoder.
      var parameters: [String] = []
      let names = [ "sprop-vps", "sprop-sps", "sprop-pps" ]
      for (name, set) in zip(names, video.parameterSets) {
        parameters.append("\(name)=\(set.base64EncodedString())")
      }
      if !parameters.isEmpty {
        lines.append("a=fmtp:\(Self.videoPayloadType) \(parameters.joined(separator: "; "))")
      }
    }

    lines.append("a=framesize:\(Self.videoPayloadType) \(video.width)-\(video.height)")
    lines.append(cnameLine(ssrc: videoSSRC))
    return lines
  }

  /// RFC 5576 §6.1. This must be the same string the RTCP SDES CNAME carries, which is why both read
  /// `identity.cname`. It lets a client identify the camera from the DESCRIBE alone, without waiting
  /// for the first RTCP packet.
  private func cnameLine(ssrc: UInt32) -> String {
    "a=ssrc:\(ssrc) cname:\(identity.cname)"
  }

  private func audioLines(_ audio: AudioTrack) -> [String] {
    let rtpmap = "\(Self.audioPayloadType) mpeg4-generic/\(audio.sampleRate)/\(audio.channelCount)"
    let parameters = [
      "profile-level-id=1",
      "mode=AAC-hbr",
      "sizelength=\(AACPacketizer.sizeLength)",
      "indexlength=\(AACPacketizer.indexLength)",
      "indexdeltalength=\(AACPacketizer.indexDeltaLength)",
      "config=\(AudioSpecificConfigBuilder.hex(audio.audioSpecificConfig))"
    ]

    return [
      "m=audio 0 RTP/AVP \(Self.audioPayloadType)",
      "c=IN IP4 0.0.0.0",
      "a=rtpmap:\(rtpmap)",
      "a=control:\(SDPBuilder.audioTrackControl)",
      "a=fmtp:\(Self.audioPayloadType) \(parameters.joined(separator: "; "))",
      cnameLine(ssrc: audioSSRC)
    ]
  }

  public static let videoTrackControl = "trackID=0"
  public static let audioTrackControl = "trackID=1"
}
