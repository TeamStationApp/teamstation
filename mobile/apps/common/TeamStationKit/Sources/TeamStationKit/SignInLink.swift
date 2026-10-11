import Foundation

/// What a link handed to the app means for signing in.
///
/// The server mails a sign-in asked for in an app to the app's own link host:
/// `<appOrigin>/signin/<token>?server=<the server that issued it>`. The
/// operating system hands that address to the app because the host is the
/// app's, verified. The app spends the token only against the server that
/// issued it, so a link from another server is never sent anywhere.
public enum SignInLink: Equatable, Sendable {
  /// The app's own server issued it: spend the token.
  case spend(token: String)
  /// Another name issued it. It is the app's own server only if the server's
  /// OpenID issuer is `<server>/oauth`, which the caller asks before spending.
  case confirm(token: String, server: String)
  /// Not a sign-in link of this app's.
  case notSignIn

  /// Reads `url` for an app whose link host is `appOrigin`, signing in to the
  /// server at `serverOrigin` (`https://host`, as `TeamStationAccountScope`
  /// writes it).
  public static func read(_ url: URL, appOrigin: URL?, serverOrigin: String) -> SignInLink {
    guard
      let appOrigin,
      let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme?.lowercased() == "https",
      let host = parts.host?.lowercased(),
      host == appOrigin.host()?.lowercased(),
      parts.port == appOrigin.port
    else { return .notSignIn }
    let segments = parts.path.split(separator: "/", omittingEmptySubsequences: true)
    guard
      segments.count == 2,
      segments[0] == "signin",
      segments[1].range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil
    else { return .notSignIn }
    let token = String(segments[1])
    let server = parts.queryItems?.first(where: { $0.name == "server" })?.value
    guard let server, !server.isEmpty, server.lowercased() != serverOrigin.lowercased() else {
      return .spend(token: token)
    }
    return .confirm(token: token, server: server)
  }
}

/// How a sign-in link the app was handed ended.
public enum SignInLinkOutcome: Equatable, Sendable {
  /// Signed in as this person.
  case signedIn(displayName: String)
  /// Issued by another server than the one this app signs in to; nothing was sent.
  case wrongServer(server: String, own: String)
  /// The link names another name for the server, and the server could not be asked whether it
  /// is its own. Nothing was sent; opening the link again asks again.
  case unreachable(own: String)
  /// Not a sign-in link; the app does with it whatever it did before.
  case notSignIn
  /// The server refused or could not be reached, in its own words.
  case failed(String)

  /// What the app shows for it, or nil for a link that was not a sign-in.
  public var message: String? {
    switch self {
    case let .signedIn(name): "Signed in to TeamStation as \(name)"
    case let .wrongServer(server, own): "This link is for \(server). This app signs in to \(own)."
    case let .unreachable(own): "Couldn’t reach \(own) to check this link. Try again."
    case .notSignIn: nil
    case let .failed(why): why
    }
  }
}
