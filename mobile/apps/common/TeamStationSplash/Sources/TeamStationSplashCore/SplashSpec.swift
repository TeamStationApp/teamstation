/// One colour stop of a radial gradient: where it sits (0–1 of the radius),
/// its colour as 0xRRGGBB, and its alpha.
public struct SplashStop: Sendable, Equatable {
  public let at: Double
  public let rgb: UInt32
  public let alpha: Double

  public init(at: Double, rgb: UInt32, alpha: Double) {
    self.at = at
    self.rgb = rgb
    self.alpha = alpha
  }

  public var red: Double { Double((rgb >> 16) & 0xff) / 255 }
  public var green: Double { Double((rgb >> 8) & 0xff) / 255 }
  public var blue: Double { Double(rgb & 0xff) / 255 }
}

/// A CSS `radial-gradient(circle at x y, …)`: a circle reaching the farthest
/// corner of its box, centred at a fraction of the box.
public struct SplashGradient: Sendable, Equatable {
  public let centerX: Double
  public let centerY: Double
  public let stops: [SplashStop]

  public init(centerX: Double, centerY: Double, stops: [SplashStop]) {
    self.centerX = centerX
    self.centerY = centerY
    self.stops = stops
  }

  /// The radius in points for a `width`×`height` box.
  public func radius(width: Double, height: Double) -> Double {
    let dx = max(centerX, 1 - centerX) * width
    let dy = max(centerY, 1 - centerY) * height
    return (dx * dx + dy * dy).squareRoot()
  }
}

/// One property's keyframes: (offset 0–1 of the run, value).
public struct SplashTrack: Sendable {
  public let keys: [(Double, Double)]

  public init(_ keys: [(Double, Double)]) {
    self.keys = keys
  }

  public var offsets: [Double] { keys.map(\.0) }
  public var values: [Double] { keys.map(\.1) }
}

/// A layer's tracks, all eased by the same curve on every segment.
public struct SplashLayerTracks: Sendable {
  public let easing: [Double]
  public let tracks: [String: SplashTrack]

  public init(easing: [Double], tracks: [String: SplashTrack]) {
    self.easing = easing
    self.tracks = tracks
  }

  public subscript(_ name: String) -> SplashTrack {
    guard let track = tracks[name] else { preconditionFailure("No splash track \(name)") }
    return track
  }
}

/// A rectangle in units of the mark's side, measured from the mark's centre.
public struct SplashRect: Sendable, Equatable {
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}
