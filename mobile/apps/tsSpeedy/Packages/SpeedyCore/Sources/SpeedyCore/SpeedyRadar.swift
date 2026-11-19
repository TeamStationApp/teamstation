/// The one radar TS Speedy pairs. The app backs it with the shared `RadarFleet`; tests with a fake.
@MainActor
public protocol SpeedyRadar: AnyObject {
  var status: RadarStatus { get }
  /// After every change to `status`.
  var onChange: (() -> Void)? { get set }
  /// A reading: pitch and exit in mph, zero for a side the reading does not carry.
  var onSpeeds: ((Int, Int) -> Void)? { get set }
  func start()
  /// The readout left the screen: let the radar go, so no reading arrives and its link is free.
  func pause()
  /// The readout is back: take the radar again.
  func resume()
  /// Lists the unpaired radars in range in `status.nearby`.
  func startPairing()
  func stopPairing()
  /// Pairs `name`, replacing the radar paired before it.
  func pair(_ name: String)
  func unpair()
}

/// Plays a phrase's clips, one phrase after another.
@MainActor
public protocol PhrasePlayer: AnyObject {
  func play(_ clips: [String])
  /// Stops what is playing and drops what is waiting.
  func stop()
}
