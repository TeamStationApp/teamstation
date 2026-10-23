import Foundation
import Sentry

/// Shared by the Swift apps and the React Native host using its existing Sentry framework.
public enum NativeSentryPrivacy {
  public static func configure(_ options: Options) {
    options.sendDefaultPii = false
    options.enableAutoSessionTracking = false
    options.sendClientReports = false
    options.enableNetworkBreadcrumbs = false
    options.enableCaptureFailedRequests = false
    #if canImport(UIKit)
    options.attachScreenshot = false
    options.attachViewHierarchy = false
    #endif
    options.maxBreadcrumbs = 0
    options.beforeSend = { scrub($0) }
    options.beforeBreadcrumb = { _ in nil }
  }

  /// Initialize before React Native, whose JS beforeSend cannot filter native crashes.
  public static func start(bundle: Bundle = .main) {
    let dsn = bundle.object(forInfoDictionaryKey: "TSSentryDsn") as? String ?? ""
    guard let parts = URLComponents(string: dsn), parts.scheme == "https",
          parts.password == nil, parts.query == nil, parts.fragment == nil,
          let host = parts.host, !host.isEmpty,
          let user = parts.user, user.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil,
          parts.path.range(of: "^/[0-9]{1,20}$", options: .regularExpression) != nil else { return }
    let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    SentrySDK.start { options in
      options.dsn = dsn
      options.releaseName = "app.teamstation.app@" + version + "+" + build
      configure(options)
    }
  }

  public static func scrub(_ event: Event) -> Event {
    let safe = Event(level: event.level == .fatal ? .fatal : .error)
    safe.eventId = event.eventId
    safe.timestamp = event.timestamp
    if let release = event.releaseName,
       release.range(of: "^app\\.teamstation\\.(app|director|cameraman|distributor)@[0-9][0-9A-Za-z.+_-]{0,63}$", options: .regularExpression) != nil {
      safe.releaseName = release
    }
    let source = event.exceptions?.last
    let allowed = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "NSException", "NSInvalidArgumentException", "SIGABRT", "SIGSEGV", "EXC_BAD_ACCESS"]
    let kind = source?.type ?? "Error"
    let exception = Exception(value: "internal", type: allowed.contains(kind) ? kind : "Error")
    let files = ["App.tsx", "api.ts", "sentry.ts", "index.ts", "VideoView.tsx", "VideoView.native.tsx", "MultiCamView.tsx", "StreamingScreen.native.tsx", "SentrySetup.swift", "RecordingEngine.swift", "DistributorModel.swift", "index.android.bundle", "main.jsbundle"]
    let frames = (source?.stacktrace?.frames ?? []).suffix(32).compactMap { frame -> Frame? in
      guard let name = frame.fileName?.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init),
            files.contains(name) || name.range(of: "^app-[A-Z0-9]{8}\\.js$", options: .regularExpression) != nil,
            let line = frame.lineNumber, line.intValue > 0, line.intValue <= 1_000_000 else { return nil }
      let safe = Frame(); safe.fileName = name; safe.lineNumber = line
      if let column = frame.columnNumber, column.doubleValue.rounded() == column.doubleValue,
         column.intValue >= 0, column.intValue <= 100_000_000 { safe.columnNumber = column }
      return safe
    }
    exception.stacktrace = SentryStacktrace(frames: Array(frames.suffix(3)), registers: [:])
    safe.exceptions = [exception]
    return safe
  }
}
