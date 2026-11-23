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

  private func payloadAgeGates() -> [Int] {
    let value = declaredAge.perform(NSSelectorFromString("payloadAgeGates"))
    return (value!.takeUnretainedValue() as! [NSNumber]).map(\.intValue)
  }

  private func gates(_ body: NSDictionary) -> [Int]? {
    (body["fetchedAgeGates"] as? [NSNumber])?.map(\.intValue)
  }

  func testTheAgeGatesAre13And16And18() {
    XCTAssertEqual(payloadAgeGates(), [13, 16, 18])
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
      XCTAssertEqual(gates(body), [13, 16, 18], raw)
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
    XCTAssertEqual(gates(body), payloadAgeGates())
  }

  /// Each range the three gates give, Apple's own: both bounds kept, an adult's with none above.
  func testSharingKeepsBothBoundsOfEachBand() {
    let bands: [(lower: Int?, upper: Int?)] = [(nil, 12), (13, 15), (16, 17), (18, nil)]
    for band in bands {
      var input: [String: Any] = [
        "osAtLeast26": true,
        "debugLower": "",
        "hasPresenter": true,
        "outcome": "sharing"
      ]
      if let lower = band.lower { input["lower"] = lower }
      if let upper = band.upper { input["upper"] = upper }
      let body = answer(input)
      let name = "\(String(describing: band.lower))–\(String(describing: band.upper))"
      XCTAssertEqual(body["status"] as? String, "sharing", name)
      XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, band.lower, name)
      XCTAssertEqual((body["upperBound"] as? NSNumber)?.intValue, band.upper, name)
      XCTAssertEqual(gates(body), [13, 16, 18], name)
    }
  }

  func testADebugUpperBoundAtOrAboveTheLowerIsKept() {
    let range = answer(["osAtLeast26": true, "debugLower": "13", "debugUpper": "15", "hasPresenter": true])
    XCTAssertEqual((range["lowerBound"] as? NSNumber)?.intValue, 13)
    XCTAssertEqual((range["upperBound"] as? NSNumber)?.intValue, 15)
    XCTAssertEqual((range["fetched"] as? NSNumber)?.boolValue, false)
    for upper in ["12", "", "nope"] {
      let body = answer(["osAtLeast26": true, "debugLower": "13", "debugUpper": upper, "hasPresenter": true])
      XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, 13, upper)
      XCTAssertNil(body["upperBound"], upper)
    }
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

  func testRequestUsesADebugRange() {
    setenv("TS_DECLARED_AGE_LOWER", "13", 1)
    setenv("TS_DECLARED_AGE_UPPER", "15", 1)
    defer {
      unsetenv("TS_DECLARED_AGE_LOWER")
      unsetenv("TS_DECLARED_AGE_UPPER")
    }
    _ = declaredAge.perform(NSSelectorFromString("requestForTest"))
    let body = declaredAge.perform(NSSelectorFromString("lastAnswer"))!
      .takeUnretainedValue() as! NSDictionary
    XCTAssertEqual(body["status"] as? String, "sharing")
    XCTAssertEqual((body["lowerBound"] as? NSNumber)?.intValue, 13)
    XCTAssertEqual((body["upperBound"] as? NSNumber)?.intValue, 15)
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
