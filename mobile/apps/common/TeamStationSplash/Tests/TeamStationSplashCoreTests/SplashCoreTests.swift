import Foundation
import XCTest

@testable import TeamStationSplashCore

/// The browser's computed values, written by scripts/splash/buildSplashAssets.mjs.
private struct Samples: Decodable {
  struct Row: Decodable {
    let ms: Double
    let stadium: [String: Double]
    let dark: [String: Double]
    let glow: [String: Double]
    let mark: [String: Double]
    let wordmark: [String: Double]
  }

  let samples: [String: [Row]]

  static func load() throws -> Samples {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { url.deleteLastPathComponent() }
    let file = url.appendingPathComponent("src/test/fixtures/splashSamples.json")
    return try JSONDecoder().decode(Samples.self, from: Data(contentsOf: file))
  }
}

final class SplashSamplerTests: XCTestCase {
  func testItMatchesTheBrowserAtEverySample() throws {
    let samples = try Samples.load()
    var rows = 0
    for (size, list) in samples.samples {
      for row in list {
        let frame = SplashSampler.frame(ms: row.ms)
        let pairs: [(String, Double, Double?)] = [
          ("stadium.scale", frame.stadiumScale, row.stadium["scale"]),
          ("stadium.opacity", frame.stadiumOpacity, row.stadium["opacity"]),
          ("stadium.brightness", frame.stadiumBrightness, row.stadium["brightness"]),
          ("stadium.contrast", frame.stadiumContrast, row.stadium["contrast"]),
          ("stadium.blur", frame.stadiumBlur, row.stadium["blur"]),
          ("dark.opacity", frame.darkOpacity, row.dark["opacity"]),
          ("glow.opacity", frame.glowOpacity, row.glow["opacity"]),
          ("glow.scale", frame.glowScale, row.glow["scale"]),
          ("mark.opacity", frame.markOpacity, row.mark["opacity"]),
          ("mark.scale", frame.markScale, row.mark["scale"]),
          ("mark.blur", frame.markBlur, row.mark["blur"]),
          ("wordmark.opacity", frame.wordmarkOpacity, row.wordmark["opacity"]),
          ("wordmark.translateY", frame.wordmarkTranslateY, row.wordmark["translateY"]),
          ("wordmark.scale", frame.wordmarkScale, row.wordmark["scale"]),
        ]
        for (name, ours, theirs) in pairs {
          XCTAssertEqual(ours, try XCTUnwrap(theirs), accuracy: 0.002, "\(size) \(row.ms) ms \(name)")
        }
        rows += 1
      }
    }
    XCTAssertEqual(rows, 4 * 41)
  }

  func testTheCurveIsCSSs() {
    let linear = CubicBezier(0, 0, 1, 1)
    XCTAssertEqual(linear(0.3), 0.3, accuracy: 1e-6)
    let ease = CubicBezier([0.25, 0.1, 0.25, 1])
    XCTAssertEqual(ease(0), 0)
    XCTAssertEqual(ease(1), 1)
    XCTAssertEqual(ease(0.5), 0.8024, accuracy: 1e-3)
    // x = t³ is flat at its start, so Newton's slope vanishes there and
    // bisection finds t ≈ ∛progress instead.
    let flat = CubicBezier(0, 0, 0, 1)
    let progress = 1e-5
    let t = pow(progress, 1.0 / 3)
    XCTAssertEqual(flat(progress), 3 * t * t - 2 * t * t * t, accuracy: 1e-4)
  }

  func testEachSegmentIsEasedOnItsOwn() {
    let track = SplashTrack([(0, 0), (0.5, 10), (1, 0)])
    let linear = CubicBezier(0, 0, 1, 1)
    XCTAssertEqual(SplashSampler.value(track, easing: linear, progress: 0.25), 5, accuracy: 1e-6)
    XCTAssertEqual(SplashSampler.value(track, easing: linear, progress: 0.75), 5, accuracy: 1e-6)
    XCTAssertEqual(SplashSampler.value(track, easing: linear, progress: -1), 0)
    XCTAssertEqual(SplashSampler.value(track, easing: linear, progress: 2), 0)
    XCTAssertEqual(SplashSampler.progress(-5), 0)
    XCTAssertEqual(SplashSampler.progress(99_999), 1)
  }

  func testTheEndsAreTheKeyframes() {
    XCTAssertEqual(SplashSampler.frame(ms: 0).stadiumScale, 2.8)
    XCTAssertEqual(SplashSampler.frame(ms: 2000).darkOpacity, 1)
    XCTAssertEqual(SplashSampler.frame(ms: 5000).wordmarkTranslateY, SplashTimeline.wordmarkRestY)
  }
}

final class SplashGeometryTests: XCTestCase {
  func testWiderWindowsCropLessOfTheStadium() {
    let phone = SplashGeometry(width: 390, height: 844)
    XCTAssertEqual(phone.visible.width, 0.252, accuracy: 0.001)
    XCTAssertEqual(phone.cover.x + phone.cover.width / 2, 195, accuracy: 0.01)
    let tv = SplashGeometry(width: 1920, height: 1080)
    XCTAssertEqual(tv.visible.width, 0.969, accuracy: 0.001)
    let iPad = SplashGeometry(width: 1194, height: 834)
    XCTAssertGreaterThan(iPad.visible.width, phone.visible.width)
    XCTAssertLessThan(iPad.visible.width, tv.visible.width)
    let wide = SplashGeometry(width: 2400, height: 1000)
    XCTAssertEqual(wide.visible.width, 0.99, accuracy: 0.001)
    XCTAssertLessThan(wide.visible.height, 0.8)
  }

  func testTheMarkFitsAnyWindow() {
    for (w, h, side) in [(390.0, 844.0, 210.0), (1194, 834, 207.5), (834, 1194, 297.1), (1920, 1080, 268.7)] {
      XCTAssertEqual(SplashGeometry(width: w, height: h).side, side, accuracy: 0.05, "\(w)x\(h)")
    }
    XCTAssertEqual(SplashGeometry(width: 390, height: 844).k, 1)
  }

  func testSplitViewAndStageManagerWindowsStayCentred() {
    for (w, h) in [(320.0, 1024.0), (700, 500)] {
      let g = SplashGeometry(width: w, height: h)
      XCTAssertGreaterThan(g.side, 0)
      XCTAssertEqual(g.cover.x + g.cover.width / 2, w / 2, accuracy: 0.01)
      XCTAssertEqual(g.markCenter.x, w / 2)
      XCTAssertEqual(g.markCenter.y, h * 0.45, accuracy: 1e-9)
      XCTAssertLessThanOrEqual(g.cover.x, 0)
      XCTAssertGreaterThanOrEqual(g.cover.x + g.cover.width, w)
    }
  }

  func testFrameZeroIsCroppedAboutTheFixedPoint() {
    let crop = SplashGeometry.frameZeroCrop()
    XCTAssertEqual(crop, SplashBox(x: 1769, y: 1066, width: 1966, height: 1098))
    let small = SplashGeometry.frameZeroCrop(imageWidth: 1376, imageHeight: 768)
    XCTAssertEqual(small.width / 1376, crop.width / 5504, accuracy: 0.001)
  }

  func testBrandRectanglesScaleWithTheSide() {
    let g = SplashGeometry(width: 780, height: 1688)
    let box = g.brand(SplashRect(x: -0.5, y: 0.25, width: 1, height: 0.5))
    XCTAssertEqual(box, SplashBox(x: -210, y: 105, width: 420, height: 210))
  }

  func testGradientsReachTheFarthestCorner() {
    let circle = SplashGradient(centerX: 0.5, centerY: 0.45, stops: [])
    XCTAssertEqual(circle.radius(width: 100, height: 100), (50.0 * 50 + 55 * 55).squareRoot(), accuracy: 1e-9)
    let stop = SplashStop(at: 0, rgb: 0x76c33c, alpha: 1)
    XCTAssertEqual(stop.red, 118.0 / 255, accuracy: 1e-9)
    XCTAssertEqual(stop.green, 195.0 / 255, accuracy: 1e-9)
    XCTAssertEqual(stop.blue, 60.0 / 255, accuracy: 1e-9)
  }
}

final class SplashPolicyTests: XCTestCase {
  func testItHoldsUntilContentHasAppeared() {
    let policy = SplashPolicy()
    XCTAssertEqual(policy.decision(sinceInstallMs: 2500, timelineMs: 2000), .hold)
    XCTAssertEqual(policy.decision(sinceInstallMs: 7999, timelineMs: 7000), .hold)
  }

  func testItHoldsUntilTheTimelineHasEnded() {
    var policy = SplashPolicy()
    policy.contentDidAppear()
    XCTAssertEqual(policy.decision(sinceInstallMs: 300, timelineMs: 300), .hold)
    XCTAssertEqual(policy.decision(sinceInstallMs: 2500, timelineMs: 1999), .hold)
    XCTAssertEqual(policy.decision(sinceInstallMs: 2500, timelineMs: nil), .hold)
  }

  func testItDismissesAtTheEndOnceContentHasAppeared() {
    var policy = SplashPolicy()
    policy.contentDidAppear()
    XCTAssertTrue(policy.contentAppeared)
    XCTAssertEqual(policy.decision(sinceInstallMs: 2600, timelineMs: 2000), .dismiss)
  }

  func testTheCapCountsFromInstallWithoutContentOrATimeline() {
    XCTAssertEqual(SplashPolicy().decision(sinceInstallMs: 8000, timelineMs: nil), .dismiss)
    // A slow decode does not push the cap back.
    XCTAssertEqual(SplashPolicy().decision(sinceInstallMs: 8000, timelineMs: 5000), .dismiss)
  }

  func testAFrozenSplashNeverDismisses() {
    var policy = SplashPolicy(frozen: true)
    policy.contentDidAppear()
    XCTAssertEqual(policy.decision(sinceInstallMs: 60_000, timelineMs: 60_000), .hold)
  }
}

final class SplashLaunchOptionsTests: XCTestCase {
  private func defaults(_ value: Any?) -> UserDefaults {
    let suite = "SplashLaunchOptionsTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    if let value { defaults.set(value, forKey: SplashLaunchOptions.key) }
    return defaults
  }

  func testItReadsAnyNumberIncludingZero() {
    for (value, ms) in [(0 as Any, 0.0), (0.7, 700), (2, 2000), ("1.4", 1400)] {
      XCTAssertEqual(
        SplashLaunchOptions.freezeMs(defaults: defaults(value), debug: false, simulator: true, develop: false),
        ms,
        "\(value)"
      )
    }
  }

  func testItIsNilWhenTheKeyIsMissingOrNotANumber() {
    XCTAssertNil(SplashLaunchOptions.freezeMs(defaults: defaults(nil), debug: true, simulator: true, develop: true))
    XCTAssertNil(SplashLaunchOptions.freezeMs(defaults: defaults("soon"), debug: true, simulator: false, develop: false))
    XCTAssertNil(SplashLaunchOptions.freezeMs(defaults: defaults(-1), debug: true, simulator: false, develop: false))
    XCTAssertNil(SplashLaunchOptions.freezeMs(defaults: defaults(Date()), debug: true, simulator: false, develop: false))
  }

  func testEachConditionAloneHonoursIt() {
    let set = defaults(0.7)
    XCTAssertEqual(SplashLaunchOptions.freezeMs(defaults: set, debug: true, simulator: false, develop: false), 700)
    XCTAssertEqual(SplashLaunchOptions.freezeMs(defaults: set, debug: false, simulator: true, develop: false), 700)
    XCTAssertEqual(SplashLaunchOptions.freezeMs(defaults: set, debug: false, simulator: false, develop: true), 700)
    XCTAssertNil(SplashLaunchOptions.freezeMs(defaults: set, debug: false, simulator: false, develop: false))
  }

  func testThisProcessIsADebugBuild() {
    XCTAssertEqual(SplashLaunchOptions.current(develop: false, defaults: defaults(1)), 1000)
  }
}
