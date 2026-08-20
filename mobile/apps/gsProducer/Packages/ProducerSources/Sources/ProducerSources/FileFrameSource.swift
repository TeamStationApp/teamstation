import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ProducerCore

/// Decodes a fixture file at wall-clock pace and republishes it as if it were a live camera.
///
/// Used by the `file4` profile for content-realistic encode-fidelity tests: the fixture's
/// burned-in `FrameMarker` values are the expected set, and the archive is checked to contain
/// exactly those values, in order.
public final class FileFrameSource: FrameSource, @unchecked Sendable {
  public let sourceID: SourceID
  public let displayName: String

  private let url: URL
  private let loops: Bool
  private let clock: ProducerClock
  private let queue: DispatchQueue

  private let lock = NSLock()
  private var reader: AVAssetReader?
  private var output: AVAssetReaderTrackOutput?
  private var timer: DispatchSourceTimer?
  private var running = false
  private var frameID: UInt64 = 0
  private var loopOffset = CMTime.zero
  private var lastPresentationTime = CMTime.zero
  private var resolvedFormat: SourceFormat?
  private var nominalFrameRate: Double = 30

  public init(
    sourceID: SourceID,
    displayName: String,
    url: URL,
    loops: Bool = true,
    clock: ProducerClock = SystemClock()
  ) {
    self.sourceID = sourceID
    self.displayName = displayName
    self.url = url
    self.loops = loops
    self.clock = clock
    self.queue = DispatchQueue(
      label: "co.gamestation.producer.file.\(sourceID.slug)",
      qos: .userInitiated
    )
  }

  public var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return running
  }

  public var format: SourceFormat? {
    lock.lock()
    defer { lock.unlock() }
    return resolvedFormat
  }

  public func start(sinks: FrameSinks) throws {
    guard FileManager.default.fileExists(atPath: url.path) else {
      throw FrameSourceError.unavailable("fixture missing at \(url.path) — run `socket npm run fixtures`")
    }

    lock.lock()
    guard !running else {
      lock.unlock()
      return
    }
    running = true
    lock.unlock()

    Task { [weak self] in
      guard let self else { return }
      do {
        let track = try await Self.loadVideoTrack(url: url)
        let size = try await track.load(.naturalSize)
        let rate = try await track.load(.nominalFrameRate)
        let frameRate = rate > 0 ? Double(rate) : 30

        storeFormat(
          SourceFormat(
            width: Int(size.width),
            height: Int(size.height),
            frameRate: frameRate,
            pixelFormat: kCVPixelFormatType_32BGRA
          ),
          frameRate: frameRate
        )

        try makeReader()
        startTimer(sinks: sinks, frameRate: frameRate)
      } catch {
        markStopped()
      }
    }
  }

  public func stop() {
    lock.lock()
    running = false
    let timer = self.timer
    self.timer = nil
    reader?.cancelReading()
    reader = nil
    output = nil
    lock.unlock()
    timer?.cancel()
  }

  // MARK: - Internals

  // The lock is taken in these synchronous helpers rather than inline, because `NSLock.lock()`
  // is unavailable directly inside the async start path.
  private func storeFormat(_ format: SourceFormat, frameRate: Double) {
    lock.lock()
    defer { lock.unlock() }
    resolvedFormat = format
    nominalFrameRate = frameRate
  }

  private func markStopped() {
    lock.lock()
    defer { lock.unlock() }
    running = false
  }

  private static func loadVideoTrack(url: URL) async throws -> AVAssetTrack {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else {
      throw FrameSourceError.unavailable("no video track in \(url.lastPathComponent)")
    }
    return track
  }

  private func makeReader() throws {
    let asset = AVURLAsset(url: url)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw FrameSourceError.unavailable("no video track in \(url.lastPathComponent)")
    }
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
      track: track,
      outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]
      ]
    )
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
      throw FrameSourceError.failedToStart("reader rejected the BGRA output")
    }
    reader.add(output)
    guard reader.startReading() else {
      throw FrameSourceError.failedToStart(reader.error?.localizedDescription ?? "startReading failed")
    }

    lock.lock()
    self.reader = reader
    self.output = output
    lock.unlock()
  }

  private func startTimer(sinks: FrameSinks, frameRate: Double) {
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: 1 / frameRate, leeway: .milliseconds(1))
    timer.setEventHandler { [weak self] in
      self?.pump(sinks: sinks)
    }
    lock.lock()
    self.timer = timer
    lock.unlock()
    timer.resume()
  }

  private func pump(sinks: FrameSinks) {
    lock.lock()
    guard running, let output else {
      lock.unlock()
      return
    }
    lock.unlock()

    guard let sampleBuffer = output.copyNextSampleBuffer() else {
      handleEndOfFile(sinks: sinks)
      return
    }
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

    lock.lock()
    let id = frameID
    frameID += 1
    let offset = loopOffset
    lock.unlock()

    let sourceTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let presentationTime = CMTimeAdd(sourceTime, offset)

    lock.lock()
    lastPresentationTime = presentationTime
    lock.unlock()

    sinks.pixel?(PixelFrame(
      sourceID: sourceID,
      pixelBuffer: pixelBuffer,
      presentationTime: presentationTime,
      wallClock: clock.now,
      frameID: id,
      markerValue: FrameMarker.read(from: pixelBuffer)
    ))
  }

  private func handleEndOfFile(sinks: FrameSinks) {
    lock.lock()
    let shouldLoop = loops && running
    let frameRate = nominalFrameRate
    if shouldLoop {
      loopOffset = CMTimeAdd(lastPresentationTime, CMTime(seconds: 1 / frameRate, preferredTimescale: 600))
      reader?.cancelReading()
      reader = nil
      output = nil
    } else {
      running = false
    }
    lock.unlock()

    guard shouldLoop else {
      stop()
      return
    }
    try? makeReader()
  }
}
