import Foundation

/// What a crash report from a TeamStation app may carry: the same rules the TeamStation app and
/// server follow (`src/common/sentry` in the TeamStation repository).
///
/// Nothing that signs a person in leaves the device: no session token, password hash, sign-in code
/// or link, invite code, stream key, media signature, CSRF token or cookie, and no email address.
/// These rules are the only scrub; the Sentry server's own is off.
public enum SentryRules {
  public static let filtered = "[Filtered]"

  /// The product's own host, which a build with no `TS_PRIMARY_HOST` talks to.
  public static let productHost = "app.teamstation.app"

  /// Names that may hold a secret. A bare `code` and anything `session` stay in, though they also
  /// name harmless things, because the sign-in code and the session token travel under them.
  private static let secretKey = try! NSRegularExpression(
    pattern: "token|secret|passw|clienthash|code|cookie|authorization|bearer|session|credential|csrf|api[-_]?key|private[-_]?key|stream[-_]?key|dsn|email",
    options: [ .caseInsensitive ]
  )
  /// Names that contain a secret's word but hold none: status and error codes.
  private static let safeKey = try! NSRegularExpression(
    pattern: "^(http\\.(response\\.)?)?status_?code$|^(error|exit)_?code$",
    options: [ .caseInsensitive ]
  )

  private static let textRules: [(NSRegularExpression, String)] = [
    (try! NSRegularExpression(pattern: "(rtmps?://[^\\s/]+(?:/[^\\s/]+)*)/[^\\s/]+"), "$1/[Filtered]"),
    // A query follows a URL or path character and starts with a word character, so `a?.b()` and
    // `'?'` in an error message are left alone.
    (try! NSRegularExpression(pattern: "([\\w/.%-])\\?[\\w%-][^\\s#'\"()]*"), "$1"),
    (try! NSRegularExpression(pattern: "/signin/[^\\s/?#]+"), "/signin/[Filtered]"),
    (try! NSRegularExpression(pattern: "/(i|join|invite|approvals|native-approval)/[^\\s/?#]+"), "/$1/[Filtered]"),
    (try! NSRegularExpression(pattern: "/media/[^\\s/?#]+/[^\\s/?#]+/"), "/media/[Filtered]/"),
    (try! NSRegularExpression(pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), "[email]")
  ]

  /// Text — a URL, a message, an exception's value — with the secrets in it filtered.
  public static func scrubText(_ text: String) -> String {
    var out = text
    for (rule, template) in textRules {
      out = rule.stringByReplacingMatches(
        in: out, range: NSRange(out.startIndex..., in: out), withTemplate: template
      )
    }
    return out
  }

  /// Whether a field of this name may hold a secret.
  public static func isSecret(key: String) -> Bool {
    let range = NSRange(key.startIndex..., in: key)
    return secretKey.firstMatch(in: key, range: range) != nil
      && safeKey.firstMatch(in: key, range: range) == nil
  }

  /// A copy of any JSON-like value with secret-named fields and URLs filtered.
  public static func scrubValue(_ value: Any, depth: Int = 0) -> Any {
    if let text = value as? String { return scrubText(text) }
    if depth > 8 { return filtered }
    if let list = value as? [Any] { return list.map { scrubValue($0, depth: depth + 1) } }
    if let map = value as? [String: Any] {
      return scrubDictionary(map, depth: depth)
    }
    return value
  }

  public static func scrubDictionary(_ map: [String: Any], depth: Int = 0) -> [String: Any] {
    var out: [String: Any] = [:]
    for (key, item) in map {
      out[key] = isSecret(key: key) ? filtered : scrubValue(item, depth: depth + 1)
    }
    return out
  }

  /// An event's contexts: one whose name may hold a secret is dropped whole, and the rest are
  /// scrubbed field by field.
  public static func scrubContexts(_ contexts: [String: [String: Any]]) -> [String: [String: Any]] {
    var out: [String: [String: Any]] = [:]
    for (name, context) in contexts where !isSecret(key: name) {
      out[name] = scrubDictionary(context)
    }
    return out
  }

  /// Headers with every secret-named one removed.
  public static func scrubHeaders(_ headers: [String: String]) -> [String: String] {
    var out: [String: String] = [:]
    for (name, value) in headers where !isSecret(key: name) {
      out[name] = scrubText(value)
    }
    return out
  }

  /// `<appId>@<version>+<build>`, with the build as dist, as the TeamStation app names itself.
  public static func release(appId: String, version: String, build: String?) -> (release: String, dist: String?) {
    guard let build, !build.isEmpty else { return ("\(appId)@\(version)", nil) }
    return ("\(appId)@\(version)+\(build)", build)
  }

  /// `production` for the product host, a development seat's own name for its host, and
  /// `development` for anything local. An empty host is the product host, as it is for
  /// `AppServer.host(in:)`, because that is what such a build talks to.
  public static func environment(host: String?) -> String {
    var name = (host ?? "").trimmingCharacters(in: .whitespaces).lowercased()
    if name.isEmpty { name = productHost }
    if let colon = name.lastIndex(of: ":"), !name.hasPrefix("[") { name = String(name[..<colon]) }
    if name == "localhost" || name.hasSuffix(".local") || name.hasPrefix("[") { return "development" }
    if name.allSatisfy({ $0.isNumber || $0 == "." }) { return "development" }
    if name == productHost { return "production" }
    return String(name.split(separator: ".").first ?? Substring(name))
  }

  /// What `-sentryTest error|crash` on the launch arguments asks for.
  public enum Test: String, Sendable { case error, crash }

  public static func test(arguments: [String]) -> Test? {
    guard let flag = arguments.firstIndex(of: "-sentryTest"), flag + 1 < arguments.count else {
      return nil
    }
    return Test(rawValue: arguments[flag + 1])
  }
}
