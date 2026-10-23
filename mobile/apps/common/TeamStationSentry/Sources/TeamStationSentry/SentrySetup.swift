import Foundation
import Sentry
import TeamStationSentryRules
import TeamStationObservability

/// Starts crash reporting for a TeamStation app, from the DSN and server host its build was
/// made with (`TSSentryDsn` and `TSPrimaryHost` in Info.plist). A build without a DSN reports
/// nothing. Every event names the release and environment and goes through `SentryRules`.
public enum SentrySetup {
  public static func start(appId: String, bundle: Bundle = .main, arguments: [String] = ProcessInfo.processInfo.arguments,
                           configure: @escaping (Options) -> Void = { _ in }, crash: () -> Void = { SentrySDK.crash() }) {
    let dsn = (bundle.object(forInfoDictionaryKey: "TSSentryDsn") as? String) ?? ""
    guard LogEndpoint.from(dsn: dsn) != nil else { return }
    let host = bundle.object(forInfoDictionaryKey: "TSPrimaryHost") as? String
    let version = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    let release = SentryRules.release(appId: appId, version: version, build: build)
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = release.release
      options.dist = release.dist
      options.environment = SentryRules.environment(host: host.flatMap { $0.hasPrefix("$(") ? nil : $0 })
      NativeSentryPrivacy.configure(options)
      configure(options)
    }
    switch SentryRules.test(arguments: arguments) {
    case .error:
      SentrySDK.capture(exception: NSException(
        name: NSExceptionName("SentryTestError"), reason: "Sentry test error"
      ))
    case .crash:
      crash()
    case nil:
      break
    }
  }

  static func scrub(_ event: Event) -> Event { NativeSentryPrivacy.scrub(event) }
}
