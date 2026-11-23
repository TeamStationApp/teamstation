import Foundation
import UIKit

#if canImport(DeclaredAgeRange)
import DeclaredAgeRange
#endif

/**
 * The ages chat asks Apple about: 13, below which there is no chat; 16, so a
 * teenager's range is 13 to 15 or 16 to 17; and 18, an adult.
 */
enum DeclaredAgePayload {
  static let chatGate = 13
  static let olderTeenGate = 16
  static let adultGate = 18
  static let ageGates = [chatGate, olderTeenGate, adultGate]
}

/**
 * The declared-age answer the bridge resolves.
 *
 * A numeric `TS_DECLARED_AGE_LOWER` is a shared lower bound and never calls
 * the system; a numeric `TS_DECLARED_AGE_UPPER` at or above it is its upper
 * bound. Below iOS 26 the platform has no API. No view controller has not
 * settled. Everything else is the outcome of one fetch.
 */
func ageDecision(
  osAtLeast26: Bool,
  debugLower: String,
  debugUpper: String = "",
  hasPresenter: Bool,
  outcome: String,
  lower: Int?,
  upper: Int?
) -> (answer: [String: Any], fetchedAgeGates: [Int]?) {
  if let answer = standIn(debugLower, debugUpper) {
    return (answer, nil)
  }
  if !osAtLeast26 {
    return (["status": "unsupported"], nil)
  }
  if !hasPresenter {
    return (["status": "unready"], nil)
  }
  let fetched = DeclaredAgePayload.ageGates
  if outcome == "declinedSharing" {
    return (["status": "declined"], fetched)
  }
  if outcome == "sharing" {
    var body: [String: Any] = ["status": "sharing"]
    if let lower { body["lowerBound"] = lower }
    if let upper { body["upperBound"] = upper }
    return (body, fetched)
  }
  return (["status": "unavailable"], fetched)
}

/// The stand-in's answer, or nil when `lower` is not a whole number.
private func standIn(_ lower: String, _ upper: String) -> [String: Any]? {
  guard let bound = finiteInteger(lower) else { return nil }
  var body: [String: Any] = ["status": "sharing", "lowerBound": bound]
  if let top = finiteInteger(upper), top >= bound { body["upperBound"] = top }
  return body
}

private func finiteInteger(_ raw: String) -> Int? {
  guard raw.range(of: #"^-?\d+$"#, options: .regularExpression) != nil else {
    return nil
  }
  return Int(raw)
}

private func dictionary(_ answer: [String: Any]) -> NSDictionary {
  answer as NSDictionary
}

enum AppleDeclaredAge {
  /// The only call to `AgeRangeService.shared.requestAgeRange`.
  @available(iOS 26, *)
  static func fetch(in controller: UIViewController) async -> [String: Any] {
    #if canImport(DeclaredAgeRange)
    do {
      let response = try await AgeRangeService.shared.requestAgeRange(
        ageGates: DeclaredAgePayload.chatGate,
        DeclaredAgePayload.olderTeenGate,
        DeclaredAgePayload.adultGate,
        in: controller
      )
      switch response {
      case .declinedSharing:
        return ageDecision(osAtLeast26: true, debugLower: "", hasPresenter: true, outcome: "declinedSharing", lower: nil, upper: nil).answer
      case .sharing(let range):
        return ageDecision(osAtLeast26: true, debugLower: "", hasPresenter: true, outcome: "sharing", lower: range.lowerBound, upper: range.upperBound).answer
      @unknown default:
        return ["status": "unavailable"]
      }
    } catch {
      return ageDecision(
        osAtLeast26: true,
        debugLower: "",
        hasPresenter: true,
        outcome: "notAvailable",
        lower: nil,
        upper: nil
      ).answer
    }
    #else
    return ["status": "unsupported"]
    #endif
  }
}

private func presenter() -> UIViewController? {
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.flatMap(\.windows).first
  var controller = window?.rootViewController
  while let presented = controller?.presentedViewController {
    controller = presented
  }
  return controller
}

@objc(TSDeclaredAge)
public class TSDeclaredAge: NSObject {
  @objc public static func payloadAgeGates() -> NSArray {
    DeclaredAgePayload.ageGates.map { NSNumber(value: $0) } as NSArray
  }

  /// The decision table the hosted tests call. `fetchedAgeGates` is set only when a fetch would run.
  @objc public static func declaredAgeAnswer(_ input: NSDictionary) -> NSDictionary {
    let outcome = input["outcome"] as? String ?? ""
    let result = ageDecision(
      osAtLeast26: (input["osAtLeast26"] as? NSNumber)?.boolValue ?? false,
      debugLower: input["debugLower"] as? String ?? "",
      debugUpper: input["debugUpper"] as? String ?? "",
      hasPresenter: (input["hasPresenter"] as? NSNumber)?.boolValue ?? false,
      outcome: outcome,
      lower: (input["lower"] as? NSNumber)?.intValue,
      upper: (input["upper"] as? NSNumber)?.intValue
    )
    var body = result.answer
    body["fetched"] = result.fetchedAgeGates != nil
    if let gates = result.fetchedAgeGates {
      body["fetchedAgeGates"] = gates
    }
    return dictionary(body)
  }

  private static var last: NSDictionary?

  /// The hosted test's entry: `request`, then `lastAnswer` once it settles.
  @objc public static func requestForTest() {
    last = nil
    request { body in
      last = body
    }
  }

  @objc public static func lastAnswer() -> NSDictionary? {
    last
  }

  @objc public static func request(_ resolve: @escaping (NSDictionary) -> Void) {
    let environment = ProcessInfo.processInfo.environment
    if let answer = standIn(
      environment["TS_DECLARED_AGE_LOWER"] ?? "",
      environment["TS_DECLARED_AGE_UPPER"] ?? ""
    ) {
      resolve(dictionary(answer))
      return
    }
    if #available(iOS 26, *) {
      Task { @MainActor in
        guard let controller = presenter() else {
          resolve(dictionary(["status": "unready"]))
          return
        }
        let answer = await AppleDeclaredAge.fetch(in: controller)
        resolve(dictionary(answer))
      }
    } else {
      resolve(dictionary(["status": "unsupported"]))
    }
  }
}
