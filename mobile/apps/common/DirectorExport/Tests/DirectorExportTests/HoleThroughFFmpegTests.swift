#if os(macOS)
import AVFoundation
import Foundation
import Testing
import DirectorCore
import DirectorExport

/// A phone's export with a hole, read by FFmpeg: TeamStation's upload copies it into HLS with
/// `ffmpeg -c copy` (`remuxToHlsArgs` in `src/server/media/ffmpeg.ts`), and mpv and IINA read it
/// with the same demuxer. Mac only, where the tests can run FFmpeg; skipped when it is not
/// installed.
@Suite("A programme hole through FFmpeg", .serialized)
struct HoleThroughFFmpegTests {
  /// Where FFmpeg is, if it is installed.
  static let tools: (ffmpeg: String, ffprobe: String)? = {
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
      let ffmpeg = "\(directory)/ffmpeg"
      let ffprobe = "\(directory)/ffprobe"
      if FileManager.default.isExecutableFile(atPath: ffmpeg),
         FileManager.default.isExecutableFile(atPath: ffprobe) {
        return (ffmpeg, ffprobe)
      }
    }
    return nil
  }()

  struct Packet {
    var pts: Double
    var duration: Double
    var key: Bool
    var size: Int
  }

  /// A part, a ten-second absence, and a part that stops a second before the window does, with
  /// sound, as the phone exports it. FFmpeg finds every picture once, at its wall time, in the file
  /// and in the HLS copy TeamStation makes of it.
  @Test(
    "FFmpeg reads the hole at its wall time, with no picture replayed, in the file and in the upload's HLS copy",
    .enabled(if: tools != nil)
  )
  func holeReadsInFFmpeg() async throws {
    let tools = try #require(Self.tools)
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("hole-ffmpeg-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let marked = WallClockPlacementTests()
    let first = root.appendingPathComponent("a.mp4")
    let second = root.appendingPathComponent("b.mp4")
    try await marked.markedMovieWithAudio(at: first, firstValue: 1_000, frames: 15)
    try await marked.markedMovieWithAudio(at: second, firstValue: 500_000, frames: 15)
    let destination = root.appendingPathComponent("out.mp4")
    try await ArchiveRemux.stitch(
      files: [first, second],
      fileDurations: [0.5, 0.5],
      startWalls: [WallClock(seconds: 0), WallClock(seconds: 10.5)],
      windowStart: WallClock(seconds: 0),
      length: 12,
      settings: WallClockPlacementTests.encoding,
      destination: destination,
      blankGaps: true
    )

    // The file as mpv, IINA and the upload's demuxer read it.
    let direct = try packets(of: destination, ffprobe: tools.ffprobe)
    expectHole(direct, label: "file")

    // The upload's copy into HLS, with `remuxToHlsArgs`'s arguments for an H.264 file whose sound
    // priming is declared.
    let hls = root.appendingPathComponent("hls", isDirectory: true)
    try FileManager.default.createDirectory(at: hls, withIntermediateDirectories: true)
    try run(tools.ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", destination.path,
      "-c", "copy", "-tag:v", "avc1",
      "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
      "-hls_segment_options", "movflags=+frag_discont",
      "-hls_flags", "single_file+independent_segments",
      "-hls_segment_filename", hls.appendingPathComponent("video.mp4").path,
      "-master_pl_name", "master.m3u8",
      hls.appendingPathComponent("video.m3u8").path
    ])
    let copied = try packets(of: hls.appendingPathComponent("video.m3u8"), ffprobe: tools.ffprobe)
    expectHole(copied, label: "HLS copy")

    // The sound runs the whole take, holes and all.
    let sound = try run(tools.ffprobe, [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration",
      "-of", "csv=p=0", destination.path
    ])
    let soundSeconds = Double(sound.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    #expect(abs(soundSeconds - 12) < 0.05, "sound \(soundSeconds) s")
  }

  /// One picture every frame at 30 fps from 0 to 12 s, each once, on the frame grid and lasting one
  /// frame: the first part's at 0 to 0.5 s, then the hole black every frame with keyframes at the
  /// encoder's spacing (a second here), then the second part's first picture at 10.5 s on a
  /// keyframe, and one picture a frame to the end.
  private func expectHole(_ packets: [Packet], label: String) {
    let times = packets.map(\.pts)
    let frame = 1.0 / 30
    #expect(packets.count == 12 * 30, "\(label): \(packets.count) pictures in 12 s at 30 fps")
    #expect(
      zip(times, times.dropFirst()).allSatisfy { abs($1 - $0 - frame) < 0.0005 },
      "\(label): a frame missing, replayed or out of order \(times)"
    )
    #expect(
      times.allSatisfy { abs($0 * 30 - ($0 * 30).rounded()) < 0.015 },
      "\(label): a picture off the frame grid \(times)"
    )
    #expect(packets.allSatisfy { abs($0.duration - frame) < 0.0005 }, "\(label): a picture lasts \(packets.map(\.duration).max() ?? 0) s")
    let beforeHole = packets.filter { $0.pts < 0.49 }
    let hole = packets.filter { $0.pts > 0.49 && $0.pts < 10.49 }
    let afterHole = packets.filter { $0.pts > 10.49 }
    #expect(beforeHole.count == 15, "\(label): \(beforeHole.count) pictures before the hole, \(times)")
    #expect(abs((beforeHole.last?.pts ?? 0) - 14 * frame) < 0.002, "\(label): last before \(beforeHole.last?.pts ?? -1)")
    #expect(abs((beforeHole.last?.duration ?? 0) - frame) < 0.002, "\(label): it lasts \(beforeHole.last?.duration ?? -1)")
    #expect(hole.count == 300, "\(label): \(hole.count) pictures in the hole")
    let keys = hole.enumerated().filter(\.element.key).map(\.offset)
    #expect(zip([-1] + keys, keys + [hole.count]).allSatisfy { $1 - $0 <= 30 }, "\(label): keyframes in the hole at \(keys)")
    let perSecond = Double(hole.map(\.size).reduce(0, +)) / 10
    print("hole through FFmpeg, \(label): \(hole.count) packets, durations \(Set(hole.map(\.duration))), keyframes at \(keys.map { 0.5 + Double($0) * frame }), \(Int(perSecond)) bytes a second")
    #expect(perSecond < 20_000, "\(label): the hole costs \(perSecond) bytes a second")
    #expect(abs((afterHole.first?.pts ?? 0) - 10.5) < 0.002, "\(label): first after \(afterHole.first?.pts ?? -1)")
    #expect(afterHole.first?.key == true, "\(label): the picture after the hole is not a keyframe")
    #expect(afterHole.count == 45, "\(label): \(afterHole.count) pictures after the hole")
    let end = (packets.last?.pts ?? 0) + (packets.last?.duration ?? 0)
    #expect(abs(end - 12) < 0.002, "\(label): pictures end at \(end)")
  }

  /// The picture packets FFmpeg reads from `url`, in presentation order.
  private func packets(of url: URL, ffprobe: String) throws -> [Packet] {
    let csv = try run(ffprobe, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "packet=pts_time,duration_time,size,flags",
      "-of", "csv=p=0", url.path
    ])
    return csv.split(separator: "\n").compactMap { line in
      let fields = line.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
      guard fields.count >= 4, let pts = Double(fields[0]) else { return nil }
      return Packet(pts: pts, duration: Double(fields[1]) ?? 0, key: fields[3].hasPrefix("K"), size: Int(fields[2]) ?? 0)
    }
    .sorted { $0.pts < $1.pts }
  }

  @discardableResult
  private func run(_ tool: String, _ arguments: [String]) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: tool)
    process.arguments = arguments
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let failure = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw ArchiveRemux.Error.exportFailed(
        "\(tool) failed: \(String(decoding: failure, as: UTF8.self))"
      )
    }
    return String(decoding: data, as: UTF8.self)
  }
}
#endif
