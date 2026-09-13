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
func runReceive(nameFragment: String, seconds: Double, lowest: Bool = false, tally: Bool = false, url: String? = nil, extraIPs: String? = nil) -> Int32 {
  guard NDIlib_initialize() else {
    FileHandle.standardError.write(Data("NDIlib_initialize failed\n".utf8))
    return 1
  }

  // Connecting by address skips discovery entirely, which is the only way to tell a sender that
  // has stopped advertising from one that has stopped sending. A Hollyland Cosmo C2 came back from
  // a reboot listening on its port while publishing an mDNS service name with no SRV or A record
  // behind it: browsable, unresolvable, and invisible to every NDI receiver on the network.
  if let url {
    print("connecting directly to \(url), bypassing discovery")
    let receiver: NDIlib_recv_instance_t? = url.withCString { address in
      "gsNdiCameras direct".withCString { receiverName in
        var source = NDIlib_source_t()
        source.p_ndi_name = nil
        source.p_url_address = address
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
      FileHandle.standardError.write(Data("NDIlib_recv_create_v3 failed for \(url)\n".utf8))
      return 1
    }
    defer { NDIlib_recv_destroy(receiver) }
    var video = 0, audio = 0, described = false
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      var videoFrame = NDIlib_video_frame_v2_t()
      var audioFrame = NDIlib_audio_frame_v3_t()
      var metadataFrame = NDIlib_metadata_frame_t()
      switch NDIlib_recv_capture_v3(receiver, &videoFrame, &audioFrame, &metadataFrame, 200) {
      case NDIlib_frame_type_video:
        video += 1
        if !described {
          described = true
          let fourCC = videoFrame.FourCC.rawValue
          let tag = String(bytes: (0 ..< 4).map { UInt8((fourCC >> (8 * $0)) & 0xFF) }, encoding: .ascii) ?? "?"
          print("first video frame: \(videoFrame.xres)x\(videoFrame.yres) fourcc=\(tag) "
            + "rate=\(videoFrame.frame_rate_N)/\(videoFrame.frame_rate_D)")
        }
        NDIlib_recv_free_video_v2(receiver, &videoFrame)
      case NDIlib_frame_type_audio:
        audio += 1
        NDIlib_recv_free_audio_v3(receiver, &audioFrame)
      case NDIlib_frame_type_metadata:
        NDIlib_recv_free_metadata(receiver, &metadataFrame)
      default:
        break
      }
    }
    print("direct connect over \(String(format: "%.1f", seconds))s: video=\(video) "
      + "(\(String(format: "%.1f", Double(video) / seconds))/s) audio=\(audio) "
      + "connections=\(NDIlib_recv_get_no_connections(receiver))")
    return video > 0 ? 0 : 2
  }

  // Addresses handed to the finder directly. Each NDI machine runs a query service on TCP 5960
  // whose whole purpose is answering "what sources are you running?" from an IP alone, so a subnet
  // sweep for that port plus this parameter finds cameras that mDNS has failed to advertise.
  var findSettings = NDIlib_find_create_t()
  findSettings.show_local_sources = true
  let extra = extraIPs.map { strdup($0) } ?? nil
  defer { if let extra { free(extra) } }
  findSettings.p_extra_ips = extra.map { UnsafePointer($0) }
  if let extraIPs { print("finder extra_ips: \(extraIPs)") }
  guard let finder = NDIlib_find_create_v2(&findSettings) else {
    FileHandle.standardError.write(Data("NDIlib_find_create_v2 failed\n".utf8))
    return 1
  }
  defer { NDIlib_find_destroy(finder) }

  // Discovery is not instant, and asking for the source list once returns whatever has arrived so
  // far — which on a quiet network is nothing.
  var chosen: String?
  var chosenURL: String = ""
  let findDeadline = Date().addingTimeInterval(10)
  while Date() < findDeadline {
    _ = NDIlib_find_wait_for_sources(finder, 1_000)
    var count: UInt32 = 0
    guard let list = NDIlib_find_get_current_sources(finder, &count) else { continue }
    var names: [String] = []
    for index in 0 ..< Int(count) {
      guard let raw = list[index].p_ndi_name else { continue }
      let name = String(cString: raw)
      names.append(name)
      if name.contains(nameFragment) {
        chosenURL = list[index].p_url_address.map { String(cString: $0) } ?? ""
      }
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
  print("connecting to \(sourceName)\(chosenURL.isEmpty ? " (finder gave no url)" : " at \(chosenURL)")")

  let receiver: NDIlib_recv_instance_t? = sourceName.withCString { name in
    "gsNdiCameras receive".withCString { receiverName in
      // The address the finder already resolved, handed over with the name. Connecting by name
      // alone makes the receiver resolve it again through its own finder, which has none of the
      // extra IPs — so a camera discovered only because of them cannot then be connected to.
      return chosenURL.withCString { address in
        var source = NDIlib_source_t()
        source.p_ndi_name = name
        source.p_url_address = chosenURL.isEmpty ? nil : address
        var settings = NDIlib_recv_create_v3_t()
        settings.source_to_connect_to = source
        settings.color_format = NDIlib_recv_color_format_fastest
        settings.bandwidth = lowest ? NDIlib_recv_bandwidth_lowest : NDIlib_recv_bandwidth_highest
        settings.allow_video_fields = false
        settings.p_ndi_recv_name = receiverName
        return NDIlib_recv_create_v3(&settings)
      }
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
  // The sender's own clock. Counting arrivals cannot tell a sender emitting 60 fps from one
  // emitting 120 of which half are lost on the way, but the gap between consecutive sender
  // timestamps can: it is written before the frame leaves, so it is unaffected by anything the
  // network or this receiver does.
  var timestampGaps: [Double] = []
  var timecodeGaps: [Double] = []
  var previousTimestamp: Int64 = 0
  var previousTimecode: Int64 = 0
  var firstTimestamp: Int64 = 0
  var lastTimestamp: Int64 = 0
  let ticksPerSecond = 10_000_000.0
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
      if videoFrame.timestamp != NDIlib_recv_timestamp_undefined, videoFrame.timestamp > 0 {
        if previousTimestamp != 0 {
          timestampGaps.append(Double(videoFrame.timestamp - previousTimestamp) / ticksPerSecond)
        } else {
          firstTimestamp = videoFrame.timestamp
        }
        previousTimestamp = videoFrame.timestamp
        lastTimestamp = videoFrame.timestamp
      }
      if videoFrame.timecode != NDIlib_send_timecode_synthesize, videoFrame.timecode > 0 {
        if previousTimecode != 0 {
          timecodeGaps.append(Double(videoFrame.timecode - previousTimecode) / ticksPerSecond)
        }
        previousTimecode = videoFrame.timecode
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

  func describe(_ label: String, _ gaps: [Double]) {
    guard !gaps.isEmpty else {
      print("\(label): none reported by the sender")
      return
    }
    let sorted = gaps.sorted()
    let median = sorted[sorted.count / 2]
    print(
      "\(label): n=\(gaps.count) median=\(String(format: "%.5f", median))s "
        + "(= \(String(format: "%.2f", 1 / median)) fps) "
        + "min=\(String(format: "%.5f", sorted.first!)) max=\(String(format: "%.5f", sorted.last!))"
    )
    // The shape, not just the middle: a median that disagrees with the span-derived rate is a
    // skewed distribution, and the quartiles say how skewed.
    func percentile(_ fraction: Double) -> String {
      String(format: "%.5f", sorted[min(sorted.count - 1, Int(Double(sorted.count) * fraction))])
    }
    let mean = gaps.reduce(0, +) / Double(gaps.count)
    print(
      "\(label): p10=\(percentile(0.1)) p25=\(percentile(0.25)) p75=\(percentile(0.75)) "
        + "p90=\(percentile(0.9)) mean=\(String(format: "%.5f", mean))s"
    )
    if let path = ProcessInfo.processInfo.environment["GS_NDI_GAPS_OUT"] {
      try? gaps.map { String(format: "%.6f", $0) }.joined(separator: "\n")
        .write(toFile: path, atomically: true, encoding: .utf8)
    }
  }
  describe("sender timestamp gap", timestampGaps)
  describe("sender timecode gap", timecodeGaps)
  if firstTimestamp != 0, lastTimestamp > firstTimestamp {
    let span = Double(lastTimestamp - firstTimestamp) / ticksPerSecond
    print(
      "sender span: \(String(format: "%.3f", span))s for \(video) frames "
        + "= \(String(format: "%.2f", Double(video - 1) / span)) fps by the sender's own clock"
    )
  }

  // The only instrument that separates "the sender emits 60" from "the sender emits 120 and half
  // are lost": timestamp gaps look identical in both cases, because a receiver that loses every
  // other frame of a 120 fps stream sees exactly the 1/60 spacing a 60 fps stream would give.
  // The SDK counts what it discarded, so it can answer directly.
  var total = NDIlib_recv_performance_t()
  var dropped = NDIlib_recv_performance_t()
  NDIlib_recv_get_performance(receiver, &total, &dropped)
  print(
    "SDK performance: video total=\(total.video_frames) dropped=\(dropped.video_frames), "
      + "audio total=\(total.audio_frames) dropped=\(dropped.audio_frames)"
  )
  var queue = NDIlib_recv_queue_t()
  NDIlib_recv_get_queue(receiver, &queue)
  print("SDK queue at exit: video=\(queue.video_frames) audio=\(queue.audio_frames)")

  let connections = NDIlib_recv_get_no_connections(receiver)
  print(
    "over \(String(format: "%.1f", seconds))s: video=\(video) (\(String(format: "%.1f", Double(video) / seconds))/s) "
      + "audio=\(audio) metadata=\(metadata) empty=\(nothing) connections=\(connections)"
  )
  return video > 0 ? 0 : 2
}
