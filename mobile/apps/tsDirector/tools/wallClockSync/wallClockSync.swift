// Reads the wall clock back out of an exported TS Director file, picture and sound.
//
// Built and run by `scripts/verifyWallClockSync.js`; not part of the app.
//
// The fixture cameras draw the time they generated each frame as 32 binary cells, and sound a
// 1 kHz beep at every whole wall-clock second. This decodes both with AVFoundation — not ffmpeg,
// whose edit-list handling shows the wrong frames on these exports — and reports, as JSON:
//
//   duration   what the file says it lasts, and what its video track actually spans
//   samples    at each probe time, which wall-clock millisecond the picture shows
//   beeps      the file time of every beep onset, and the picture's clock at that instant
//
// The caller decides what is right. This only measures.
//
//   wallClockSync <file> [--every 2] [--probes 1.5,3,4.5] [--width 1280]

import AVFoundation
import CoreVideo
import Foundation

struct Options {
  var file: URL
  var every: Double = 2
  var probes: [Double] = []
  var fixtureWidth: Double = 1280
}

func parse() -> Options {
  var args = Array(CommandLine.arguments.dropFirst())
  guard let path = args.first else {
    FileHandle.standardError.write("usage: wallClockSync <file> [--every s] [--probes a,b] [--width 1280]\n".data(using: .utf8)!)
    exit(2)
  }
  args.removeFirst()
  var options = Options(file: URL(fileURLWithPath: path))
  while !args.isEmpty {
    let flag = args.removeFirst()
    let value = args.isEmpty ? "" : args.removeFirst()
    switch flag {
    case "--every": options.every = Double(value) ?? 2
    case "--probes": options.probes = value.split(separator: ",").compactMap { Double($0) }
    case "--width": options.fixtureWidth = Double(value) ?? 1280
    default: break
    }
  }
  return options
}

/// Marker geometry, in fixture pixels. Must match `LIVE_MARKER` in `rtspLoopServer.js`.
enum Marker {
  static let bits = 32
  static let originX = 40.0
  static let originY = 40.0
  static let stride = 36.0
  static let cell = 32.0
  /// A cell that is always white, one slot past the last bit. A frame where it is not white is
  /// not showing the marker at all — a black hold, a different camera, an overlay — and must not
  /// be read as a number.
  static let sentinelSlot = 32
}

/// Mean luma of the middle of a cell, 0...255.
func cellLuma(_ base: UnsafeRawPointer, bytesPerRow: Int, width: Int, height: Int,
              slot: Int, scale: Double) -> Double {
  let x0 = Int((Marker.originX + Double(slot) * Marker.stride + Marker.cell * 0.25) * scale)
  let y0 = Int((Marker.originY + Marker.cell * 0.25) * scale)
  let size = max(2, Int(Marker.cell * 0.5 * scale))
  var total = 0.0
  var count = 0
  for y in y0 ..< min(height, y0 + size) {
    let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: UInt8.self)
    for x in x0 ..< min(width, x0 + size) {
      let pixel = row.advanced(by: x * 4)
      total += 0.114 * Double(pixel[0]) + 0.587 * Double(pixel[1]) + 0.299 * Double(pixel[2])
      count += 1
    }
  }
  return count > 0 ? total / Double(count) : 0
}

func readMarker(_ buffer: CVPixelBuffer, fixtureWidth: Double) -> UInt32? {
  CVPixelBufferLockBaseAddress(buffer, .readOnly)
  defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
  guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
  let width = CVPixelBufferGetWidth(buffer)
  let height = CVPixelBufferGetHeight(buffer)
  let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
  let scale = Double(width) / fixtureWidth
  let sentinel = cellLuma(base, bytesPerRow: bytesPerRow, width: width, height: height,
                          slot: Marker.sentinelSlot, scale: scale)
  guard sentinel > 160 else { return nil }
  var value: UInt32 = 0
  for bit in 0 ..< Marker.bits {
    let luma = cellLuma(base, bytesPerRow: bytesPerRow, width: width, height: height,
                        slot: bit, scale: scale)
    if luma > 128 { value |= (1 << UInt32(bit)) }
  }
  return value
}

/// The picture shown at file time `seconds`: the last frame that starts at or before it.
func marker(in asset: AVURLAsset, track: AVAssetTrack, at seconds: Double,
            fixtureWidth: Double) -> (pts: Double, value: UInt32?)? {
  guard let reader = try? AVAssetReader(asset: asset) else { return nil }
  // Start a little early: the frame on screen at `seconds` may have begun before it, and a held
  // frame begins at the start of the hole.
  let from = max(0, seconds - 0.2)
  reader.timeRange = CMTimeRange(
    start: CMTime(seconds: from, preferredTimescale: 600),
    duration: CMTime(seconds: 0.4, preferredTimescale: 600)
  )
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
  ])
  output.alwaysCopiesSampleData = false
  guard reader.canAdd(output) else { return nil }
  reader.add(output)
  guard reader.startReading() else { return nil }
  defer { reader.cancelReading() }
  var chosen: (pts: Double, value: UInt32?)?
  while let sample = output.copyNextSampleBuffer() {
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
    if pts <= seconds + 0.0005 || chosen == nil {
      chosen = (pts, readMarker(buffer, fixtureWidth: fixtureWidth))
    }
    if pts > seconds { break }
  }
  return chosen
}

/// File times at which a beep starts: the envelope rising through half-scale after at least
/// 300 ms of quiet.
func beepOnsets(in asset: AVURLAsset) async throws -> [Double] {
  guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return [] }
  let reader = try AVAssetReader(asset: asset)
  let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 32,
    AVLinearPCMIsFloatKey: true,
    AVLinearPCMIsNonInterleaved: false,
    AVLinearPCMIsBigEndianKey: false,
    AVSampleRateKey: 48_000,
    AVNumberOfChannelsKey: 1
  ])
  guard reader.canAdd(output) else { return [] }
  reader.add(output)
  guard reader.startReading() else { return [] }
  var onsets: [Double] = []
  var quietSince: Double = -1
  var loud = false
  let rate = 48_000.0
  let window = 48 // 1 ms
  while let sample = output.copyNextSampleBuffer() {
    let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
    guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
    var length = 0
    var pointer: UnsafeMutablePointer<Int8>?
    CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                totalLengthOut: &length, dataPointerOut: &pointer)
    guard let pointer else { continue }
    let count = length / MemoryLayout<Float>.size
    pointer.withMemoryRebound(to: Float.self, capacity: count) { samples in
      var index = 0
      while index < count {
        let end = min(count, index + window)
        var peak: Float = 0
        for i in index ..< end { peak = max(peak, abs(samples[i])) }
        let t = pts + Double(index) / rate
        if peak < 0.05 {
          if loud { loud = false; quietSince = t }
          if quietSince < 0 { quietSince = t }
        } else if peak > 0.25, !loud {
          if quietSince >= 0, t - quietSince >= 0.3 { onsets.append(t) }
          loud = true
        }
        index = end
      }
    }
  }
  return onsets
}

func run() async throws {
  let options = parse()
  let asset = AVURLAsset(url: options.file)
  let duration = try await asset.load(.duration).seconds
  guard let video = try await asset.loadTracks(withMediaType: .video).first else {
    print("{\"error\":\"no video track\"}")
    exit(1)
  }
  let range = try await video.load(.timeRange)
  let videoSeconds = range.duration.seconds
  let audioTracks = try await asset.loadTracks(withMediaType: .audio)
  var audioSeconds = 0.0
  if let audio = audioTracks.first {
    audioSeconds = try await audio.load(.timeRange).duration.seconds
  }

  var probes = options.probes
  if probes.isEmpty {
    var t = 0.5
    while t < duration - 0.25 { probes.append(t); t += options.every }
  }
  var samples: [[String: Any]] = []
  for t in probes {
    if let reading = marker(in: asset, track: video, at: t, fixtureWidth: options.fixtureWidth) {
      samples.append(["t": t, "pts": reading.pts, "marker": reading.value.map { Int($0) } as Any])
    } else {
      samples.append(["t": t, "marker": NSNull()])
    }
  }

  var beeps: [[String: Any]] = []
  for onset in try await beepOnsets(in: asset) {
    let reading = marker(in: asset, track: video, at: onset, fixtureWidth: options.fixtureWidth)
    beeps.append([
      "t": onset,
      "pts": reading?.pts as Any,
      "marker": (reading?.value).map { Int($0) } as Any
    ])
  }

  let report: [String: Any] = [
    "file": options.file.path,
    "duration": duration,
    "videoSeconds": videoSeconds,
    "audioSeconds": audioSeconds,
    "videoTracks": 1,
    "audioTracks": audioTracks.count,
    "samples": samples,
    "beeps": beeps
  ]
  let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}

let done = DispatchSemaphore(value: 0)
Task {
  do { try await run() } catch { print("{\"error\":\"\(error)\"}") }
  done.signal()
}
done.wait()
