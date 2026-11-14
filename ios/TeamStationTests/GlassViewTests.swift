import UIKit
import XCTest

@MainActor
final class GlassViewTests: XCTestCase {
  func testSubtleBlurCanReturnToOrdinaryMaterialAndRelease() throws {
    let type = try XCTUnwrap(NSClassFromString("TSGlassView") as? UIView.Type)
    weak var released: UIView?
    try autoreleasepool {
      let glass = type.init(frame: CGRect(x: 0, y: 0, width: 36, height: 36))
      released = glass
      glass.setValue(8, forKey: "glassRadius")
      glass.setValue(true, forKey: "glassSubtleBlur")
      glass.layoutIfNeeded()
      let effect = try XCTUnwrap(glass.subviews.first as? UIVisualEffectView)
      XCTAssertEqual(effect.frame, glass.bounds)
      XCTAssertEqual(effect.layer.cornerRadius, 8)
      XCTAssertEqual(effect.backgroundColor, UIColor.clear)
      let animator = try XCTUnwrap(glass.value(forKey: "blurAnimator") as? UIViewPropertyAnimator)
      XCTAssertEqual(animator.fractionComplete, 0.18, accuracy: 0.001)
      XCTAssertFalse(glass.isUserInteractionEnabled)

      // Reused native views must discard the partial effect when the option changes.
      glass.setValue(false, forKey: "glassSubtleBlur")
      XCTAssertNil(glass.value(forKey: "blurAnimator"))
      XCTAssertNotNil(effect.effect)
      glass.setValue(true, forKey: "glassBackdropBlur")
      XCTAssertTrue(effect.effect is UIBlurEffect)
      glass.setValue(true, forKey: "glassSubtleBlur")
      XCTAssertNotNil(glass.value(forKey: "blurAnimator"))
    }
    XCTAssertNil(released, "The partial blur animator must not retain its owning view")
  }

  func testForegroundRestoresPartialBlurWithoutChangingOrdinaryMaterial() throws {
    let type = try XCTUnwrap(NSClassFromString("TSGlassView") as? UIView.Type)
    let glass = type.init(frame: CGRect(x: 0, y: 0, width: 36, height: 36))
    glass.setValue(true, forKey: "glassSubtleBlur")
    let old = try XCTUnwrap(glass.value(forKey: "blurAnimator") as? UIViewPropertyAnimator)
    old.fractionComplete = 1
    NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
    let restored = try XCTUnwrap(glass.value(forKey: "blurAnimator") as? UIViewPropertyAnimator)
    XCTAssertFalse(old === restored)
    XCTAssertEqual(restored.fractionComplete, 0.18, accuracy: 0.001)
    glass.setValue(false, forKey: "glassSubtleBlur")
    let effect = try XCTUnwrap(glass.subviews.first as? UIVisualEffectView)
    let ordinary = effect.effect
    NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
    XCTAssertEqual(ordinary.map { String(describing: Swift.type(of: $0)) }, effect.effect.map { String(describing: Swift.type(of: $0)) })
    XCTAssertNil(glass.value(forKey: "blurAnimator"))
  }

  func testSubtleBlurIsExportedToReactNative() throws {
    let manager = try XCTUnwrap(NSClassFromString("TSGlassViewManager") as? NSObject.Type)
    let selector = NSSelectorFromString("propConfig_glassSubtleBlur")
    XCTAssertTrue(manager.responds(to: selector))
    let config = manager.perform(selector)?.takeUnretainedValue() as? [String]
    XCTAssertEqual(config?.first, "BOOL")
  }
}
