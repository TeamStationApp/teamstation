import CoreMedia
import Foundation
import DirectorCore

/// Latest native PCM sweep per camera, for the cameras-list oscilloscope.
///
/// Samples are stored **before** input gain so the UI can scale them as the operator drags. The
/// audio thread only writes; `TimelineView` polls `snapshot` at display rate.
public final class AudioWaveformMonitor: @unchecked Sendable {
  public static let pointCount = 96

  public struct Snapshot: Sendable, Equatable {
    public var samples: [Float]

    public init(samples: [Float] = Array(repeating: 0, count: AudioWaveformMonitor.pointCount)) {
      self.samples = samples
    }
  }

  private let lock = NSLock()
  private var traces: [SourceID: [Float]] = [:]

  public init() {}

  public func append(source: SourceID, sampleBuffer: CMSampleBuffer) {
    guard let points = AudioPCM.waveformPoints(from: sampleBuffer, count: Self.pointCount) else { return }
    lock.lock()
    traces[source] = points
    lock.unlock()
  }

  public func append(source: SourceID, points: [Float]) {
    lock.lock()
    traces[source] = points
    lock.unlock()
  }

  public func snapshot(for source: SourceID) -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    guard let samples = traces[source] else { return Snapshot() }
    return Snapshot(samples: samples)
  }

  public func remove(source: SourceID) {
    lock.lock()
    traces[source] = nil
    lock.unlock()
  }
}
