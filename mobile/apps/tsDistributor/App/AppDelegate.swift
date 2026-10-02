import AppKit

/// Starts what runs whether or not a window is open: the REST API, the debug harness and the watch
/// on the cable. The API has to answer with every window closed, so macOS is told not to quit the
/// app for having none, and closing the last window leaves it running.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  /// What to start once launching has finished; `DistributorApp` sets it before then.
  static var onLaunch: (@MainActor () -> Void)?

  func applicationDidFinishLaunching(_ notification: Notification) {
    ProcessInfo.processInfo.disableAutomaticTermination("TS Distributor answers its API")
    Self.onLaunch?()
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }
}
