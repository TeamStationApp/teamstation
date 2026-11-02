import ObjectiveC
import UIKit
import XCTest

/// `TSDeclaredAge`, called by name: this bundle takes no pods and cannot import the app.
final class DeclaredAgeTests: XCTestCase {
  private var declaredAge: AnyObject {
    NSClassFromString("TSDeclaredAge")!
  }

  private func answer(_ input: [String: Any]) -> NSDictionary {
    let value = declaredAge.perform(
      NSSelectorFromString("declaredAgeAnswer:"),
      with: input as NSDictionary
    )
    return value!.takeUnretainedValue() as! NSDictionary
  }

  private func payloadAgeGate() -> Int {
    let value = declaredAge.perform(NSSelectorFromString("payloadAgeGate"))
    return (value!.takeUnretainedValue() as! NSNumber).intValue
  }

  func testAgeGateIs13() {
    XCTAssertEqual(payloadAgeGate(), 13)
  }

  func testBelow26DoesNotFetch() {
    let body = answer(["osAtLeast26": false, "debugLower": "", "hasPresenter": true])
    XCTAssertEqual(body["status"] as? String, "unsupported")
    XCTAssertEqual((body["fetched"] as? NSNumber)?.boolValue, false)
  }

  func testNoPresenterIsUnready() {
    let body = answer(["osAtLeast26": true, "debugLower": "", "hasPresenter": false])
    XCTAssertEqual(body["status"] as? String, "unready")
    XCTAssertEqual((body["fetched"] as? NSNumber)?.boolValue, false)
  }

  func testDebugLowerBoundSkipsTheFetch() {
    let body = answer([
      "osAtLeast26": true,
      "debugLower": "12",
      "hasPresenter": false,
      "outcome": "declinedSharing"
    ])
    XCTAssertEqual(body["status"] as? String, "sharing")
    XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, 12)
    XCTAssertNil(body["upperBound"])
    XCTAssertEqual((body["fetched"] as? NSNumber)?.boolValue, false)
  }

  func testEmptyAndNonNumericDebugStillFetch() {
    for raw in ["", "nope", "13.0"] {
      let body = answer([
        "osAtLeast26": true,
        "debugLower": raw,
        "hasPresenter": true,
        "outcome": "declinedSharing"
      ])
      XCTAssertEqual(body["status"] as? String, "declined", raw)
      XCTAssertEqual((body["fetched"] as? NSNumber)?.boolValue, true, raw)
      XCTAssertEqual((body["fetchedAgeGate"] as? NSNumber)?.intValue, 13, raw)
    }
  }

  func testDeclinedSharing() {
    let body = answer([
      "osAtLeast26": true,
      "debugLower": "",
      "hasPresenter": true,
      "outcome": "declinedSharing"
    ])
    XCTAssertEqual(body["status"] as? String, "declined")
    XCTAssertEqual((body["fetchedAgeGate"] as? NSNumber)?.intValue, payloadAgeGate())
  }

  func testSharingKeepsBothBounds() {
    let body = answer([
      "osAtLeast26": true,
      "debugLower": "",
      "hasPresenter": true,
      "outcome": "sharing",
      "lower": 13,
      "upper": 15
    ])
    XCTAssertEqual(body["status"] as? String, "sharing")
    XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, 13)
    XCTAssertEqual((body["upperBound"] as? NSNumber)?.intValue, 15)
    XCTAssertEqual((body["fetchedAgeGate"] as? NSNumber)?.intValue, 13)
  }

  func testSharingOmitsNilBounds() {
    let body = answer([
      "osAtLeast26": true,
      "debugLower": "",
      "hasPresenter": true,
      "outcome": "sharing"
    ])
    XCTAssertEqual(body["status"] as? String, "sharing")
    XCTAssertNil(body["lowerBound"])
    XCTAssertNil(body["upperBound"])
  }

  func testThrownOutcomesAreUnavailable() {
    for outcome in ["notAvailable", "invalidRequest", "other"] {
      let body = answer([
        "osAtLeast26": true,
        "debugLower": "",
        "hasPresenter": true,
        "outcome": outcome
      ])
      XCTAssertEqual(body["status"] as? String, "unavailable", outcome)
      XCTAssertEqual((body["fetched"] as? NSNumber)?.boolValue, true, outcome)
    }
  }

  func testRequestUsesADebugLowerBound() {
    setenv("TS_DECLARED_AGE_LOWER", "12", 1)
    defer { unsetenv("TS_DECLARED_AGE_LOWER") }
    _ = declaredAge.perform(NSSelectorFromString("requestForTest"))
    let body = declaredAge.perform(NSSelectorFromString("lastAnswer"))!
      .takeUnretainedValue() as! NSDictionary
    XCTAssertEqual(body["status"] as? String, "sharing")
    XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, 12)
    XCTAssertNil(body["upperBound"])
  }

  func testRequestWithoutAPresenterIsUnready() {
    unsetenv("TS_DECLARED_AGE_LOWER")
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
    let window = scene.keyWindow ?? scene.windows.first!
    let root = window.rootViewController
    window.rootViewController = nil
    defer { window.rootViewController = root }
    _ = declaredAge.perform(NSSelectorFromString("requestForTest"))
    let settled = expectation(for: NSPredicate { [self] _, _ in
      self.declaredAge.perform(NSSelectorFromString("lastAnswer")) != nil
    }, evaluatedWith: nil)
    wait(for: [settled], timeout: 5)
    let body = declaredAge.perform(NSSelectorFromString("lastAnswer"))!
      .takeUnretainedValue() as! NSDictionary
    XCTAssertEqual(body["status"] as? String, "unready")
  }

  func testLiveRequestWithoutStandInIsUnavailable() {
    unsetenv("TS_DECLARED_AGE_LOWER")
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first!
    let window = scene.keyWindow ?? scene.windows.first!
    let root = window.rootViewController
    let cover = UIViewController()
    root?.present(cover, animated: false)
    defer { root?.dismiss(animated: false) }
    let presented = expectation(for: NSPredicate { _, _ in
      root?.presentedViewController != nil
    }, evaluatedWith: nil)
    wait(for: [presented], timeout: 5)
    _ = declaredAge.perform(NSSelectorFromString("requestForTest"))
    let settled = expectation(for: NSPredicate { [self] _, _ in
      self.declaredAge.perform(NSSelectorFromString("lastAnswer")) != nil
    }, evaluatedWith: nil)
    wait(for: [settled], timeout: 30)
    let body = declaredAge.perform(NSSelectorFromString("lastAnswer"))!
      .takeUnretainedValue() as! NSDictionary
    XCTAssertEqual(body["status"] as? String, "unavailable")
  }
}
