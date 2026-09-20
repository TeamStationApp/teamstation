import Foundation

/// Where the app server is.
///
/// One address, in the repository's `config.json`, read by everything that
/// needs it — the apps, the tools, and the server itself, which uses it to
/// know its own name. The app carries that same file in its bundle.
///
/// It is deliberately **not** a setting and is never written to disk. It used
/// to be a field on the saved `AppConfig`, so every install kept its own copy;
/// when the site moved, a Director went on asking the old address for ever,
/// got PeerTube's empty 400 back, and could not sign in. Reading it from the
/// build means there is one copy, and moving the site is one line and a
/// release.
public enum AppServer {
  /// The address, as `config.json` gives it.
  public static let url: URL = {
    guard let url = url(in: .main) else {
      // The file is committed and the build copies it in, so its absence is a
      // broken build rather than a state to carry on in. Failing here names
      // the cause; carrying on would surface later as every request to the
      // server going nowhere, which is a much longer walk back.
      fatalError("config.json is missing from the bundle, or has no usable \(key)")
    }
    return url
  }()

  static let key = "appServerUrl"

  /// The address in a particular bundle, or nil if it is not there. Separate
  /// from `url` so a test can ask without ending the process.
  static func url(in bundle: Bundle) -> URL? {
    guard
      let path = bundle.url(forResource: "config", withExtension: "json"),
      let data = try? Data(contentsOf: path)
    else { return nil }
    return url(fromConfig: data)
  }

  /// The address in the bytes of a `config.json`.
  static func url(fromConfig data: Data) -> URL? {
    guard
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let text = object[key] as? String,
      let url = URL(string: text),
      url.scheme != nil,
      url.host() != nil
    else { return nil }
    return url
  }
}
