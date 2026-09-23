import Foundation

/// The sign-in modal and the logout row, shared by Cameraman.
///
/// The modal has one field and one pill. They start as the address and
/// "Email sign-in code", and become the code and "Sign in" after the server
/// accepts the address. Cancel returns to the address step. The sixth digit
/// submits. Logout on the settings row arms a slide; only the slide signs out.
public struct LoginFlow: Equatable, Sendable {
  public enum Step: String, Equatable, Sendable {
    case email
    case code
  }

  public static let checkEmail = "Check your email"
  public static let badCode = "That code is wrong or has expired"
  public static let sendLabel = "Email sign-in code"
  public static let signInLabel = "Sign in"
  public static let codeLength = 6

  public var step: Step = .email
  public var email: String = ""
  public var code: String = ""
  public var notice: String?
  public var logoutArmed = false
  /// The tap that arms logout also lands on the screen behind the button.
  public var swallowNextDisarm = false

  public init() {}

  public var buttonLabel: String {
    step == .email ? Self.sendLabel : Self.signInLabel
  }

  public var fieldIsCode: Bool { step == .code }

  public mutating func cancel() {
    step = .email
    code = ""
    notice = nil
  }

  public mutating func codeSent() {
    step = .code
    code = ""
    notice = Self.checkEmail
  }

  public mutating func codeRejected() {
    step = .code
    code = ""
    notice = Self.badCode
  }

  /// Keeps at most six digits. True when this change is the one that reaches six.
  @discardableResult
  public mutating func replaceCode(_ raw: String) -> Bool {
    let digits = String(raw.filter(\.isNumber).prefix(Self.codeLength))
    let submit = digits.count == Self.codeLength && digits != code
    code = digits
    return submit
  }

  public mutating func armLogout() {
    logoutArmed = true
    swallowNextDisarm = true
  }

  public mutating func tapElsewhere() {
    if swallowNextDisarm {
      swallowNextDisarm = false
      return
    }
    logoutArmed = false
  }

  /// True when an armed slide has crossed the same fraction as slide to stop.
  @discardableResult
  public mutating func slide(progress: Double) -> Bool {
    guard logoutArmed, BroadcastPolicy.slideCommits(progress: progress) else { return false }
    logoutArmed = false
    swallowNextDisarm = false
    return true
  }

  public static func showsDevelopmentHost(_ host: String) -> Bool {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    return !trimmed.isEmpty && trimmed != "gamestation.co" && trimmed != "https://gamestation.co"
  }

  public static func loggedInLine(_ email: String) -> String {
    "\(email) currently logged in"
  }
}
