import CNDIMac
import Foundation

/// Receives one NDI source on this Mac and reports what actually arrives.
///
/// The farm proves the app can receive *SpeedHQ from this SDK*. It cannot answer whether a given
/// third-party sender works, and NDI|HX is a different codec path entirely — the SDK decodes
/// H.264/H.265 through Video Toolbox rather than its own SpeedHQ decoder. When the iPad receives
/// nothing from an HX camera, the question is whether the stream is unreceivable or the app is at
/// fault, and only a second receiver on known-good ground can separate the two. This is that
/// receiver, created with the same colour format and bandwidth the app asks for so a difference in
/// outcome is a difference in platform, not in request.
func runReceive(nameFragment: String, seconds: Double, lowest: Bool = false, tally: Bool = false) -> Int32 {
  guard NDIlib_initialize() else {
    FileHandle.standardError.write(Data("NDIlib_initialize failed\n".utf8))
    return 1
  }

  var findSettings = NDIlib_find_create_t()
  findSettings.show_local_sources = true
  guard let finder = NDIlib_find_create_v2(&findSettings) else {
    FileHandle.standardError.write(Data("NDIlib_find_create_v2 failed\n".utf8))
    return 1
  }
  defer { NDIlib_find_destroy(finder) }

  // Discovery is not instant, and asking for the source list once returns whatever has arrived so
  // far — which on a quiet network is nothing.
  var chosen: String?
  let findDeadline = Date().addingTimeInterval(10)
  while Date() < findDeadline {
    _ = NDIlib_find_wait_for_sources(finder, 1_000)
    var count: UInt32 = 0
    guard let list = NDIlib_find_get_current_sources(finder, &count) else { continue }
    var names: [String] = []
    for index in 0 ..< Int(count) {
      guard let raw = list[index].p_ndi_name else { continue }
      names.append(String(cString: raw))
    }
    if !names.isEmpty { print("found \(names.count): \(names.joined(separator: " | "))") }
    if let match = names.first(where: { $0.contains(nameFragment) }) {
      chosen = match
      break
    }
  }

  guard let sourceName = chosen else {
    FileHandle.standardError.write(Data("no source matching \(nameFragment)\n".utf8))
    return 1
  }
  print("connecting to \(sourceName)")

  let receiver: NDIlib_recv_instance_t? = sourceName.withCString { name in
    "gsNdiCameras receive".withCString { receiverName in
      var source = NDIlib_source_t()
      source.p_ndi_name = name
      source.p_url_address = nil
      var settings = NDIlib_recv_create_v3_t()
      settings.source_to_connect_to = source
      settings.color_format = NDIlib_recv_color_format_fastest
      settings.bandwidth = lowest ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest
      settings.allow_video_fields = false
      settings.p_ndi_recv_name = receiverName
      return NDIlib_recv_create_v3(&settings)
    }
  }
  guard let receiver else {
    FileHandle.standardError.write(Data("NDIlib_recv_create_v3 failed\n".utf8))
    return 1
  }
  defer { NDIlib_recv_destroy(receiver) }

  // Some HX senders are documented as streaming only to a receiver that declares itself on
  // programme or preview, so a silent stream is not proof of a silent sender until this is tried.
  if tally {
    var state = NDIlib_tally_t()
    state.on_program = true
    state.on_preview = true
    NDIlib_recv_set_tally(receiver, &state)
    print("tally: on_program=true on_preview=true")
  }

  var video = 0
  var audio = 0
  var metadata = 0
  var nothing = 0
  var described = false
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    var videoFrame = NDIlib_video_frame_v2_t()
    var audioFrame = NDIlib_audio_frame_v3_t()
    var metadataFrame = NDIlib_metadata_frame_t()
    let kind = NDIlib_recv_capture_v3(receiver, &videoFrame, &audioFrame, &metadataFrame, 200)
    switch kind {
    case NDIlib_frame_type_video:
      video += 1
      if !described {
        described = true
        let fourCC = videoFrame.FourCC.rawValue
        let tag = String(bytes: (0 ..< 4).map { UInt8((fourCC >> (8 * $0)) & 0xFF) }, encoding: .ascii) ?? "?"
        print(
          "first video frame: \(videoFrame.xres)x\(videoFrame.yres) "
            + "fourcc=\(tag) rate=\(videoFrame.frame_rate_N)/\(videoFrame.frame_rate_D) "
            + "stride=\(videoFrame.line_stride_in_bytes) format=\(videoFrame.frame_format_type.rawValue)"
        )
      }
      NDIlib_recv_free_video_v2(receiver, &videoFrame)
    case NDIlib_frame_type_audio:
      audio += 1
      NDIlib_recv_free_audio_v3(receiver, &audioFrame)
    case NDIlib_frame_type_metadata:
      metadata += 1
      // A sender that delivers no media may still say why in metadata, and it is the only channel
      // left when video and audio are both silent.
      if let raw = metadataFrame.p_data {
        print("metadata: \(String(cString: raw))")
      }
      NDIlib_recv_free_metadata(receiver, &metadataFrame)
    default:
      nothing += 1
    }
  }

  let connections = NDIlib_recv_get_no_connections(receiver)
  print(
    "over \(String(format: "%.1f", seconds))s: video=\(video) (\(String(format: "%.1f", Double(video) / seconds))/s) "
      + "audio=\(audio) metadata=\(metadata) empty=\(nothing) connections=\(connections)"
  )
  return video > 0 ? 0 : 2
}
