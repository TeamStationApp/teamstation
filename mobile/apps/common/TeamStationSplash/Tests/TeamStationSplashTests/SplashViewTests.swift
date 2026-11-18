#if canImport(UIKit)
  import TeamStationSplashCore
  import UIKit
  import XCTest

  @testable import TeamStationSplash

  @MainActor
  final class SplashViewTests: XCTestCase {
    private func window(_ width: CGFloat = 402, _ height: CGFloat = 874) -> UIWindow {
      let window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
      window.rootViewController = UIViewController()
      window.makeKeyAndVisible()
      return window
    }

    private let firstContent = Notification.Name("SplashViewTests.firstContent")

    func testInstallingPutsOneModalSplashAboveTheRootView() throws {
      let window = window()
      let before = SplashOverlay.installCount
      let overlay = SplashOverlay.install(in: window, firstContent: firstContent, frozenMs: nil)
      XCTAssertEqual(SplashOverlay.installCount, before + 1)
      XCTAssertIdentical(window.subviews.last, overlay.view)
      XCTAssertEqual(window.subviews.filter { $0 is SplashView }.count, 1)
      XCTAssertTrue(overlay.view.accessibilityViewIsModal)
      XCTAssertEqual(overlay.view.accessibilityIdentifier, "tsSplash")
      XCTAssertEqual(overlay.view.accessibilityLabel, "TeamStation")
      let value = try XCTUnwrap(overlay.view.accessibilityValue)
      XCTAssertTrue(value.hasPrefix("loading 402x874@"), value)
      overlay.dismiss(animated: false)
    }

    func testInstallingReadsTheHookFromLaunchArguments() {
      let window = window()
      let overlay = SplashOverlay.install(in: window, firstContent: firstContent, develop: false)
      XCTAssertNil(overlay.view.frozenMs, "the test runner passes no -TSSplashFreezeAt")
      overlay.dismiss(animated: false)
      XCTAssertNil(overlay.view.superview)
    }

    func testItSaysWhileItIsShowingAndAnnouncesItsDismissal() {
      let window = window()
      let overlay = SplashOverlay.install(in: window, firstContent: firstContent, frozenMs: nil)
      XCTAssertTrue(SplashOverlay.isShowing)
      let announced = expectation(forNotification: SplashOverlay.didDismiss, object: overlay)
      overlay.dismiss(animated: false)
      wait(for: [announced], timeout: 1)
      XCTAssertFalse(SplashOverlay.isShowing)
    }

    func testADroppedOverlayStillDismisses() {
      let window = window()
      weak var dropped: SplashOverlay?
      do {
        let overlay = SplashOverlay.install(in: window, firstContent: firstContent, frozenMs: nil)
        dropped = overlay
      }
      XCTAssertNotNil(dropped, "held until it dismisses")
      dropped?.dismiss(animated: false)
      XCTAssertNil(dropped)
    }

    func testTheValueTurnsReadyOnFirstContent() throws {
      let view = SplashView(frame: CGRect(x: 0, y: 0, width: 390.5, height: 844), frozenMs: 0)
      view.contentDidAppear()
      let value = try XCTUnwrap(view.accessibilityValue)
      XCTAssertTrue(value.hasPrefix("ready 390.5x844@"), value)
    }

    func testItDecodesTheStadiumThenStartsTheTimeline() {
      let window = window()
      let overlay = SplashOverlay(frame: window.bounds, firstContent: firstContent, frozenMs: nil)
      window.addSubview(overlay.view)
      let started = expectation(description: "started")
      overlay.view.start { started.fulfill() }
      wait(for: [started], timeout: 10)
      XCTAssertNotNil(overlay.view.startedAt)
      XCTAssertNotNil(overlay.view.stadiumSharp.contents)
      for brand in [overlay.view.markSharp, overlay.view.markBlurred, overlay.view.wordmarkSharp, overlay.view.wordmarkBlurred] {
        XCTAssertNotNil(brand.contents)
      }
      XCTAssertNotNil(overlay.view.stadiumBlurred.contents)
      XCTAssertNil(overlay.view.placeholder.superlayer)
      overlay.dismiss(animated: false)
    }

    func testTheAnimationsCarryTheTimelinesKeyframesAndCurves() throws {
      // In a window, as the app's is: beginning commits the animations to its render tree.
      let window = window(390, 844)
      let view = SplashView(frame: window.bounds, frozenMs: nil)
      window.addSubview(view)
      view.layoutIfNeeded()
      view.begin(with: nil)
      defer { view.removeFromSuperview() }
      let scale = try XCTUnwrap(view.stadium.animation(forKey: "transform.scale") as? CAKeyframeAnimation)
      XCTAssertEqual(scale.values as? [Double], [2.8, 1.0])
      XCTAssertEqual(scale.keyTimes, [0, 1])
      // From the start, it begins as it is committed, not at a moment already past.
      XCTAssertEqual(scale.beginTime, view.stadium.convertTime(CACurrentMediaTime(), from: nil), accuracy: 0.1)
      let opacity = try XCTUnwrap(view.stadium.animation(forKey: "opacity") as? CAKeyframeAnimation)
      XCTAssertEqual(opacity.keyTimes, [0, 0.45, 0.7, 1])
      XCTAssertEqual(opacity.timingFunctions?.count, 3)
      var points: [Float] = [0, 0]
      opacity.timingFunctions?[0].getControlPoint(at: 1, values: &points)
      XCTAssertEqual(points, [0.25, 0.1])
      XCTAssertEqual(opacity.duration, 2)
      let move = try XCTUnwrap(view.wordmarkMove.animation(forKey: "transform.translation.y") as? CAKeyframeAnimation)
      XCTAssertEqual(move.values as? [Double], [10, 0])
      let dimming = try XCTUnwrap(view.dimming.animation(forKey: "opacity") as? CAKeyframeAnimation)
      XCTAssertEqual(try XCTUnwrap(dimming.values?.last as? Double), 1 - 0.2 / 1.05, accuracy: 1e-9)
      // The model holds the last frame once the animations end.
      XCTAssertEqual(view.dark.opacity, 1)
      XCTAssertEqual(view.stadium.opacity, 0)
    }

    func testTheScreenUnderneathTakesNoInputUntilTheSplashLeaves() {
      let window = window()
      let content = UIView(frame: window.bounds)
      let disabled = UIView(frame: window.bounds)
      disabled.isUserInteractionEnabled = false
      window.addSubview(content)
      window.addSubview(disabled)
      let overlay = SplashOverlay.install(in: window, firstContent: firstContent, frozenMs: 0)
      // The Siri Remote's presses and focus, like touches, cannot reach what the splash hides.
      XCTAssertFalse(content.isUserInteractionEnabled)
      XCTAssertFalse(disabled.isUserInteractionEnabled)
      XCTAssertTrue(overlay.view.isUserInteractionEnabled)
      overlay.dismiss(animated: false)
      XCTAssertTrue(content.isUserInteractionEnabled)
      XCTAssertFalse(disabled.isUserInteractionEnabled, "a view that took no input before still takes none")
    }

    func testWithoutTheStadiumFrameZeroStaysUnderTheBrand() {
      let view = SplashView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), frozenMs: nil)
      view.layoutIfNeeded()
      view.begin(with: nil)
      XCTAssertNotNil(view.placeholder.superlayer)
      XCTAssertNotNil(view.startedAt)
    }

    func testTheCapCountsFromInstallEvenBeforeTheTimelineStarts() {
      let overlay = SplashOverlay(frame: CGRect(x: 0, y: 0, width: 390, height: 844), firstContent: firstContent, frozenMs: nil)
      let installed = CACurrentMediaTime()
      overlay.check(now: installed + 7.9)
      XCTAssertFalse(overlay.dismissed)
      // The images never decoded, and no content appeared: the cap still holds.
      overlay.check(now: installed + 8.1)
      XCTAssertTrue(overlay.dismissed)
    }

    func testTheBrandsBlurIsAddedSoGlyphsStayOpaque() {
      let view = SplashView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), frozenMs: nil)
      XCTAssertEqual(view.markBlurred.compositingFilter as? String, "plusL")
      XCTAssertEqual(view.wordmarkBlurred.compositingFilter as? String, "plusL")
      XCTAssertNil(view.markSharp.compositingFilter)
      // The pair is summed inside its group, which only exists while the group's opacity is
      // below 1: wherever the blur is above 0, it is.
      for ms in stride(from: 0.0, to: 2000, by: 50) {
        let frame = SplashSampler.frame(ms: ms)
        if frame.markBlur > 0.001 {
          XCTAssertLessThan(frame.markOpacity, 1, "\(ms) ms")
          XCTAssertLessThan(frame.wordmarkOpacity, 1, "\(ms) ms")
        }
      }
    }

    func testTheTimelineCountsFromTheCommitOfItsAnimations() throws {
      let window = window()
      let view = SplashView(frame: window.bounds, frozenMs: nil)
      window.addSubview(view)
      view.layoutIfNeeded()
      view.begin(with: nil)
      // Committed already: the render tree is playing frame 0 now, not at the end of this turn.
      let scale = try XCTUnwrap(view.stadium.presentation()?.value(forKeyPath: "transform.scale") as? Double)
      XCTAssertGreaterThan(scale, 2.5)
      XCTAssertLessThan(view.elapsedMs(), 50)
      view.removeFromSuperview()
    }

    func testANewSizeMovesTheLayersAndKeepsPlaying() throws {
      let view = SplashView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), frozenMs: nil)
      view.layoutIfNeeded()
      view.begin(with: nil)
      view.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
      view.layoutIfNeeded()
      let g = SplashGeometry(width: 844, height: 390)
      XCTAssertEqual(view.brand.position.x, 422, accuracy: 0.01)
      XCTAssertEqual(view.brand.position.y, 390 * 0.45, accuracy: 0.01)
      XCTAssertEqual(view.brand.bounds.width, g.side, accuracy: 0.01)
      XCTAssertEqual(view.stadiumSharp.frame.width, g.cover.width, accuracy: 0.01)
      // Picked up where it had got to.
      XCTAssertGreaterThan(try XCTUnwrap(view.stadium.animation(forKey: "transform.scale")).beginTime, 0)
      XCTAssertTrue(try XCTUnwrap(view.accessibilityValue).contains("844x390"))
    }

    func testAFrozenViewHoldsItsSampledFrame() {
      let view = SplashView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), frozenMs: 700)
      view.layoutIfNeeded()
      view.begin(with: nil)
      let frame = SplashSampler.frame(ms: 700)
      XCTAssertNil(view.stadium.animationKeys())
      XCTAssertEqual(Double(view.stadium.opacity), frame.stadiumOpacity, accuracy: 1e-6)
      XCTAssertEqual(Double(view.brand.opacity), frame.markOpacity, accuracy: 1e-6)
      XCTAssertEqual(Double(view.markBlurred.opacity), frame.markBlur / 12, accuracy: 1e-6)
      XCTAssertEqual(view.stadium.transform.m11, frame.stadiumScale, accuracy: 1e-6)
    }

    func testItWaitsForContentThenFadesAndRestoresAccessibility() {
      let window = window()
      let overlay = SplashOverlay(frame: window.bounds, firstContent: firstContent, frozenMs: nil)
      window.addSubview(overlay.view)
      overlay.view.begin(with: nil)
      overlay.started()
      overlay.check()
      XCTAssertFalse(overlay.dismissed)
      NotificationCenter.default.post(name: firstContent, object: nil)
      XCTAssertTrue(overlay.view.accessibilityValue?.hasPrefix("ready") == true)
      XCTAssertFalse(overlay.dismissed, "the timeline has not ended")
      let gone = expectation(description: "removed")
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.6) {
        if overlay.view.superview == nil { gone.fulfill() }
      }
      wait(for: [gone], timeout: 4)
      XCTAssertTrue(overlay.dismissed)
      XCTAssertFalse(overlay.view.accessibilityViewIsModal)
      XCTAssertFalse(overlay.view.isAccessibilityElement)
      overlay.dismiss()
    }

    func testAFrozenOverlayNeverDismisses() {
      let window = window()
      let overlay = SplashOverlay(frame: window.bounds, firstContent: firstContent, frozenMs: 0)
      window.addSubview(overlay.view)
      overlay.view.begin(with: nil)
      overlay.started()
      overlay.contentDidAppear()
      XCTAssertFalse(overlay.dismissed)
      XCTAssertNotNil(overlay.view.superview)
    }

    func testTheMixesFollowTheTracks() {
      XCTAssertEqual(SplashView.dimming(1.05), 0)
      XCTAssertEqual(SplashView.dimming(2), 0)
      XCTAssertEqual(SplashView.stadiumBlurMix(2), 0.5)
      XCTAssertEqual(SplashView.brandBlurMix(24), 1)
      XCTAssertNotNil(SplashView.url("splashStadium", "heic"))
    }
  }
#endif
