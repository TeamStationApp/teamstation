import Foundation

/// Where the app server is.
///
/// One name, written down once — in `src/common/primaryUrl.ts` for everything
/// on the TypeScript side, and here for the apps — and read by everything that
/// needs it. `AppServerTests` checks the two copies say the same thing, so
/// they cannot quietly drift apart.
///
/// It is deliberately **not** a setting and is never written to disk. It used
/// to be a field on the saved `AppConfig`, so every install kept its own copy;
/// when the site moved, a Director went on asking the old address for ever,
/// got PeerTube's empty 400 back, and could not sign in. Reading it from the
/// build means there is one copy, and moving the site is one line and a
/// release.
///
/// **A host, with no scheme.** `https` is implied, except for an IP address or
/// `localhost` — the two things nobody holds a certificate for, and the two
/// things a server somebody is running themselves is reached by — which imply
/// `http`. The same rule the server applies to its own links.
public enum AppServer {
  /// The name in the source: where a release build talks to.
  public static let defaultHost = "gamestation.co"

  /// `GSPrimaryHost` in the bundle, for a build pointed somewhere else.
  ///
  /// Set from the environment at build time — `GS_PRIMARY_HOST=devhost2.examplegs.test`
  /// — rather than by editing a tracked file, so a development build is not
  /// one stray commit away from shipping its own address to everybody.
  static let key = "GSPrimaryHost"

  /// The host this build talks to.
  public static var host: String { host(in: .main) }

  /// The address, scheme and all.
  public static let url: URL = {
    guard let url = url(forHost: host) else {
      // `defaultHost` is a literal and the override is checked below, so
      // there is no way here that is not a broken build. Failing names the
      // cause; carrying on would surface later as every request going
      // nowhere, which is a much longer walk back.
      fatalError("\(key) is not a usable host")
    }
    return url
  }()

  /// The host a particular bundle names, or the one in the source. Separate
  /// from `host` so a test can ask about a bundle that is not the app's.
  static func host(in bundle: Bundle) -> String {
    let written = bundle.object(forInfoDictionaryKey: key) as? String ?? ""
    let host = asHost(written)
    return host.isEmpty ? defaultHost : host
  }

  /// The bare host in whatever somebody wrote: a scheme, a path and a
  /// trailing slash are dropped rather than refused, because this is typed by
  /// hand and `https://devhost2.examplegs.test/` is what a person pastes.
  ///
  /// The twin of `asAuthority` in `src/common/primaryUrl.ts`.
  static func asHost(_ written: String) -> String {
    var text = written.trimmingCharacters(in: .whitespacesAndNewlines)
    if let range = text.range(of: "^[a-z][a-z0-9+.-]*://", options: [.regularExpression, .caseInsensitive]) {
      text.removeSubrange(range)
    }
    if let cut = text.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) {
      text = String(text[..<cut])
    }
    return text
  }

  /// Whether a host implies `http` rather than `https`: an IP address or
  /// `localhost`, which is what a server somebody is running themselves is
  /// reached by. The twin of `isPlainHttp` in `primaryUrl.ts`.
  static func isPlainHttp(_ authority: String) -> Bool {
    let host = authority.hasPrefix("[")
      ? String(authority[...(authority.firstIndex(of: "]") ?? authority.index(before: authority.endIndex))])
      : String(authority.split(separator: ":").first ?? "")
    if host.hasPrefix("[") { return true }  // a literal IPv6 address
    if host == "localhost" { return true }
    return host.range(of: #"^\d{1,3}(\.\d{1,3}){3}$"#, options: .regularExpression) != nil
  }

  /// `https://host[:port]`, or `http://` for an IP address or `localhost`.
  static func url(forHost authority: String) -> URL? {
    if authority.isEmpty { return nil }
    let scheme = isPlainHttp(authority) ? "http" : "https"
    guard let url = URL(string: "\(scheme)://\(authority)"), url.host() != nil
    else { return nil }
    return url
  }
}
