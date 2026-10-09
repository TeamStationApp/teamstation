import Foundation
import Sentry
import TeamStationSentryRules

/// Starts crash reporting for a TeamStation app, from the DSN and server host its build was
/// made with (`TSSentryDsn` and `TSPrimaryHost` in Info.plist). A build without a DSN reports
/// nothing. Every event names the release and environment and goes through `SentryRules`.
public enum SentrySetup {
  public static func start(appId: String, bundle: Bundle = .main, arguments: [String] = ProcessInfo.processInfo.arguments) {
    let dsn = (bundle.object(forInfoDictionaryKey: "TSSentryDsn") as? String) ?? ""
    guard !dsn.isEmpty, !dsn.hasPrefix("$(") else { return }
    let host = bundle.object(forInfoDictionaryKey: "TSPrimaryHost") as? String
    let version = (bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0"
    let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    let release = SentryRules.release(appId: appId, version: version, build: build)
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = release.release
      options.dist = release.dist
      options.environment = SentryRules.environment(host: host.flatMap { $0.hasPrefix("$(") ? nil : $0 })
      options.sendDefaultPii = false
      options.beforeSend = { event in scrub(event) }
      options.beforeBreadcrumb = { crumb in
        if crumb.category == "console" { return nil }
        if let message = crumb.message { crumb.message = SentryRules.scrubText(message) }
        if let data = crumb.data { crumb.data = SentryRules.scrubDictionary(data) }
        return crumb
      }
    }
    switch SentryRules.test(arguments: arguments) {
    case .error:
      SentrySDK.capture(exception: NSException(
        name: NSExceptionName("SentryTestError"), reason: "Sentry test error"
      ))
    case .crash:
      SentrySDK.crash()
    case nil:
      break
    }
  }

  static func scrub(_ event: Event) -> Event {
    if let message = event.message?.formatted {
      event.message = SentryMessage(formatted: SentryRules.scrubText(message))
    }
    if let transaction = event.transaction { event.transaction = SentryRules.scrubText(transaction) }
    for exception in event.exceptions ?? [] {
      if let value = exception.value { exception.value = SentryRules.scrubText(value) }
    }
    if let request = event.request {
      request.cookies = nil
      request.queryString = nil
      if let url = request.url { request.url = SentryRules.scrubText(url) }
      if let headers = request.headers { request.headers = SentryRules.scrubHeaders(headers) }
    }
    event.serverName = nil
    if let user = event.user {
      let kept = User()
      kept.userId = user.userId
      event.user = user.userId == nil ? nil : kept
    }
    if let extra = event.extra { event.extra = SentryRules.scrubDictionary(extra) }
    if let context = event.context {
      event.context = SentryRules.scrubContexts(context)
    }
    event.breadcrumbs = event.breadcrumbs?.compactMap { crumb in
      if crumb.category == "console" { return nil }
      if let message = crumb.message { crumb.message = SentryRules.scrubText(message) }
      if let data = crumb.data { crumb.data = SentryRules.scrubDictionary(data) }
      return crumb
    }
    return event
  }
}
