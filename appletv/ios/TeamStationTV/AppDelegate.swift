import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication,
                   configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "TeamStation TV", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

/// A develop build's own choice of server, kept for its next fresh launch by
/// a `teamstationtv-develop://server?origin=https://<host>` link (or
/// `?clear=1`), so one build can be pointed at any end-to-end stack. A stable
/// build neither reads nor keeps one. Nothing switches the running app over:
/// the launch a test exercises is the ordinary one.
enum ServerOverride {
  static let developOrigin = "https://develop.teamstation.app"
  static let scheme = "teamstationtv-develop"
  static let key = "serverOrigin"

  static func isDevelopBuild() -> Bool {
    (Bundle.main.object(forInfoDictionaryKey: "TVAppOrigin") as? String) == developOrigin
  }

  /// `https://<host>` for a host name alone: no path, no port, no other scheme.
  static func origin(of text: String) -> String? {
    var host = text.trimmingCharacters(in: .whitespaces).lowercased()
    if host.hasPrefix("https://") { host = String(host.dropFirst("https://".count)) }
    let pattern = "^[a-z0-9-]+(\\.[a-z0-9-]+)+$"
    guard host.range(of: pattern, options: .regularExpression) != nil else { return nil }
    return "https://\(host)"
  }

  /// The kept server's API, or nil for none or a stable build.
  static func apiBaseUrl() -> String? {
    guard isDevelopBuild(), let kept = UserDefaults.standard.string(forKey: key),
          let origin = origin(of: kept) else { return nil }
    return "\(origin)/api/v1"
  }

  /// Keeps what a server link asks for, and answers what to say; nil when
  /// the URL is no server link.
  static func keep(_ url: URL) -> String? {
    guard url.scheme == scheme, url.host == "server" else { return nil }
    guard isDevelopBuild() else { return "Only a develop build can be pointed at another server." }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    if items.contains(where: { $0.name == "clear" && $0.value == "1" }) {
      UserDefaults.standard.removeObject(forKey: key)
      return "Server reset to this build's own. Restart TeamStation to use it."
    }
    guard let text = items.first(where: { $0.name == "origin" })?.value,
          let origin = origin(of: text) else {
      return "That is not a server's host name."
    }
    UserDefaults.standard.set(origin, forKey: key)
    return "Server set to \(URL(string: origin)?.host ?? origin). Restart TeamStation to use it."
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
             options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let delegate = ReactNativeDelegate()
    delegate.dependencyProvider = RCTAppDependencyProvider()
    let factory = RCTReactNativeFactory(delegate: delegate)
    reactNativeDelegate = delegate
    reactNativeFactory = factory
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    var properties: [String: Any] = [
      "appOrigin": Bundle.main.object(forInfoDictionaryKey: "TVAppOrigin") as! String,
      "apiBaseUrl": ServerOverride.apiBaseUrl()
        ?? Bundle.main.object(forInfoDictionaryKey: "TVApiBaseUrl") as! String
    ]
#if DEBUG
    properties["apiBaseUrl"] = ProcessInfo.processInfo.environment["TV_API_BASE_URL"] ?? properties["apiBaseUrl"]
    properties["appOrigin"] = ProcessInfo.processInfo.environment["TV_APP_ORIGIN"] ?? properties["appOrigin"]
    properties["probeUrls"] = ProcessInfo.processInfo.environment["TV_PROBE_URLS"] ?? ""
#endif
    factory.startReactNative(withModuleName: "TeamStationTV", in: window,
                             initialProperties: properties, launchOptions: nil)
    keepServerLinks(connectionOptions.urlContexts)
  }

  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    keepServerLinks(contexts)
  }

  /// Keeps a server link's choice for the next launch, and says so on screen.
  private func keepServerLinks(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      guard let said = ServerOverride.keep(context.url) else { continue }
      // Once the window has a controller to show it over.
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
        let alert = UIAlertController(title: nil, message: said, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        self?.window?.rootViewController?.present(alert, animated: true)
      }
    }
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    if let address = ProcessInfo.processInfo.environment["TV_METRO_URL"],
       let url = URL(string: address), url.host != nil,
       url.scheme == "http" || url.scheme == "https" {
      return url
    }
    // React Native generates ip.txt from the build machine for physical Debug builds.
    // Pair it with this build's Metro port when launched directly from the TV home screen.
    if let file = Bundle.main.url(forResource: "ip", withExtension: "txt"),
       let contents = try? String(contentsOf: file, encoding: .utf8),
       let configuredPort = Bundle.main.object(forInfoDictionaryKey: "TVMetroPort") as? String,
       let port = Int(configuredPort), (1...65535).contains(port) {
      let host = contents.trimmingCharacters(in: .whitespacesAndNewlines)
      if !host.isEmpty {
        return RCTBundleURLProvider.jsBundleURL(forBundleRoot: "index",
          packagerHost: "\(host):\(port)", enableDev: true,
          enableMinification: false, inlineSourceMap: false)
      }
    }
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
