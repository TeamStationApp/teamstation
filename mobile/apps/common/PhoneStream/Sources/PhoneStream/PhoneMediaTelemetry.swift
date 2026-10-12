import DirectorMedia
import Foundation

/// The phone's own small `MediaTelemetry`: the counters a status line or a test reads, and the last
/// error the recording and the stream reported.
public final class PhoneMediaTelemetry: MediaTelemetry, @unchecked Sendable {
  public struct Snapshot: Sendable, Equatable {
    public var encodeSessions = 0
    public var streamKeyframes: UInt64 = 0
    public var streamPendingEncodes = 0
    public var idleKeyframes: UInt64 = 0
    public var encoderResets: UInt64 = 0
    public var encodeFailures: UInt64 = 0
    public var lastProgramFinish = ""
    public var lastError: String?
    public var lastRecordingError: String?
  }

  private let lock = NSLock()
  private var state = Snapshot()

  public init() {}

  public var snapshot: Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  private func mutate(_ change: (inout Snapshot) -> Void) {
    lock.lock()
    change(&state)
    lock.unlock()
  }

  public func recordEncodeSessionChange(delta: Int) { mutate { $0.encodeSessions += delta } }
  public func recordStreamKeyframe(ageSeconds: Double) { mutate { $0.streamKeyframes &+= 1 } }
  public func recordStreamKeyframeAge(_ seconds: Double) {}
  public func recordStreamPendingEncodes(_ count: Int) { mutate { $0.streamPendingEncodes = count } }
  public func recordStreamEncodeCallbackAge(_ seconds: Double) {}
  public func recordProgramFrameAge(_ seconds: Double) {}
  public func recordStreamIdleKeyframe() { mutate { $0.idleKeyframes &+= 1 } }
  public func recordStreamEncoderReset() { mutate { $0.encoderResets &+= 1 } }
  public func recordEncodeFailure(code: Int32) { mutate { $0.encodeFailures &+= 1 } }
  public func recordProgramFinish(_ detail: String) { mutate { $0.lastProgramFinish = detail } }
  public func recordError(_ message: String) { mutate { $0.lastError = message } }
  public func recordRecordingError(_ message: String) { mutate { $0.lastRecordingError = message } }
}
