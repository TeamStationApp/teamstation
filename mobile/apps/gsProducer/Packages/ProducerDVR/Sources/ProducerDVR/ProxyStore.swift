import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import ProducerCore
import ProducerPipeline
import ProducerSources
import UniformTypeIdentifiers
import VideoToolbox

/// The 1 fps still proxy that makes scrubbing instant.
///
/// Two properties are load-bearing:
///
/// 1. It taps a `CVPixelBuffer` the pipeline **already decoded** for preview, so it adds no decode
///    and no extra conversion (I7).
/// 2. It encodes through ImageIO, not VideoToolbox, so it costs **zero** encode sessions — the
///    scrub thumbnails stay available even when the hardware will not open another encoder.
///
/// Stills are packed into append-only chunk files with byte offsets in the shared index rather
/// than written as individual files: four cameras over a two-hour event is ~29,000 stills, and
/// 29,000 directory entries is a filesystem problem nobody needs.
public final class ProxyStore: ProxySink, @unchecked Sendable {
  public static let stillWidth = 640
  public static let stillHeight = 360
  public static let stillsPerChunk = 600

  private let sourceID: SourceID
  private let tileIndex: Int
  private let directory: URL
  private let index: ArchiveIndex
  private let telemetry: PipelineTelemetry
  private let converter: PixelConverter
  private let clock: ProducerClock
  private let queue: DispatchQueue
  private let jpegQuality: Double

  private let lock = NSLock()
  private var lastCaptureSecond: Int64 = .min
  private var chunkIndex = 0
  private var chunkOffset: Int64 = 0
  private var handle: FileHandle?
  private var stillCount: UInt64 = 0

  public init(
    sourceID: SourceID,
    tileIndex: Int,
    index: ArchiveIndex,
    telemetry: PipelineTelemetry,
    converter: PixelConverter,
    clock: ProducerClock,
    jpegQuality: Double = 0.6,
    directory: URL? = nil
  ) {
    self.sourceID = sourceID
    self.tileIndex = tileIndex
    self.index = index
    self.telemetry = telemetry
    self.converter = converter
    self.clock = clock
    self.jpegQuality = jpegQuality
    self.directory = directory ?? ProducerPaths.proxyDirectory(for: sourceID)
    self.queue = DispatchQueue(
      label: "co.gamestation.producer.proxy.\(sourceID.slug)",
      qos: .utility
    )
  }

  public var capturedStills: UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return stillCount
  }

  public func prepare() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    lock.lock()
    // Resume after a relaunch rather than overwriting: the timeline the operator can scrub
    // should survive an app restart mid-event.
    let existing = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    let chunks = existing.compactMap { name -> Int? in
      guard name.hasPrefix("proxy-"), name.hasSuffix(".blob") else { return nil }
      return Int(name.dropFirst("proxy-".count).dropLast(".blob".count))
    }
    chunkIndex = (chunks.max() ?? -1) + 1
    chunkOffset = 0
    lock.unlock()
  }

  public func close() {
    lock.lock()
    let handle = self.handle
    self.handle = nil
    lock.unlock()
    try? handle?.close()
  }

  /// Offer every converted frame; at most one per wall-clock second is kept.
  public func offer(_ frame: PixelFrame) {
    let second = Int64(frame.wallClock.seconds.rounded(.down))
    lock.lock()
    guard second != lastCaptureSecond else {
      lock.unlock()
      return
    }
    lastCaptureSecond = second
    lock.unlock()

    let pixelBuffer = frame.pixelBuffer
    let wall = frame.wallClock
    queue.async { [weak self] in
      self?.write(pixelBuffer: pixelBuffer, wall: wall)
    }
  }

  private func write(pixelBuffer: CVPixelBuffer, wall: WallClock) {
    guard let scaled = converter.scale(
      pixelBuffer,
      toWidth: Self.stillWidth,
      height: Self.stillHeight,
      format: kCVPixelFormatType_32BGRA
    ) else { return }
    guard let data = Self.encodeJPEG(scaled, quality: jpegQuality) else { return }

    lock.lock()
    if handle == nil || chunkOffset >= Int64(Self.stillsPerChunk) * 24_000 {
      try? handle?.close()
      handle = nil
    }
    if handle == nil {
      let url = directory.appendingPathComponent(Self.chunkName(chunkIndex))
      if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
      }
      handle = try? FileHandle(forWritingTo: url)
      try? handle?.seekToEnd()
      chunkOffset = Int64((try? handle?.offset()) ?? 0)
    }
    guard let handle else {
      lock.unlock()
      return
    }
    let offset = chunkOffset
    let chunk = Self.chunkName(chunkIndex)
    chunkOffset += Int64(data.count)
    stillCount += 1
    let currentChunkIndex = chunkIndex
    if chunkOffset >= Int64(Self.stillsPerChunk) * 24_000 {
      chunkIndex += 1
    }
    lock.unlock()

    do {
      try handle.write(contentsOf: data)
    } catch {
      telemetry.recordError("proxy chunk \(currentChunkIndex) write failed: \(error.localizedDescription)")
      return
    }

    do {
      try index.insertProxyStill(
        sourceID: sourceID,
        wall: wall,
        chunk: chunk,
        offset: offset,
        length: Int64(data.count)
      )
      telemetry.recordProxyStill(tile: tileIndex)
    } catch {
      telemetry.recordError("proxy index write failed: \(error)")
    }
  }

  public static func chunkName(_ index: Int) -> String {
    String(format: "proxy-%04d.blob", index)
  }

  static func encodeJPEG(_ pixelBuffer: CVPixelBuffer, quality: Double) -> Data? {
    var cgImage: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(pixelBuffer, options: nil, imageOut: &cgImage) == noErr,
          let cgImage else { return nil }

    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      data as CFMutableData,
      UTType.jpeg.identifier as CFString,
      1,
      nil
    ) else { return nil }
    CGImageDestinationAddImage(
      destination,
      cgImage,
      [ kCGImageDestinationLossyCompressionQuality: quality ] as CFDictionary
    )
    guard CGImageDestinationFinalize(destination) else { return nil }
    return data as Data
  }
}

/// Reads stills back out of the chunk files. Used by the scrub gesture, which needs a still in
/// well under a frame time so the picture tracks the finger.
public struct ProxyReader: Sendable {
  private let index: ArchiveIndex

  public init(index: ArchiveIndex) {
    self.index = index
  }

  /// `tolerance` bounds how far the returned still may sit from `wall`.
  ///
  /// Stills are written once a second, so anything further away than a couple of them means the
  /// timeline has no coverage at that moment. Without the bound the nearest match is returned no
  /// matter how distant, which shows the last frame of some earlier recording as though it were the
  /// requested time — and it does not change as the finger moves, because it stays the nearest match
  /// for every offset.
  public func still(
    for sourceID: SourceID,
    at wall: WallClock,
    tolerance: Double = 2
  ) -> (image: CGImage, wall: WallClock)? {
    guard let record = try? index.proxyStill(for: sourceID, nearest: wall) else { return nil }
    guard abs(record.wall - wall) <= tolerance else { return nil }
    return data(for: record).flatMap { data in
      guard
        let source = CGImageSourceCreateWithData(data as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
      else { return nil }
      return (image, record.wall)
    }
  }

  public func data(for record: ProxyStillRecord) -> Data? {
    let url = ProducerPaths.proxyDirectory(for: record.sourceID)
      .appendingPathComponent(record.chunk)
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    do {
      try handle.seek(toOffset: UInt64(record.offset))
      return try handle.read(upToCount: Int(record.length))
    } catch {
      return nil
    }
  }
}
