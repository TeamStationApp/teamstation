import AppKit

/// AppKit keeps a few things of its own under the app's name: the window's frame and where the
/// open panel last looked in its defaults, and URLSession its caches. GS Distributor keeps nothing
/// on the Mac, so they are cleared at launch, whatever an earlier run left, and again at quit.
final class Forgetting: NSObject, NSApplicationDelegate {
  func applicationWillFinishLaunching(_ notification: Notification) {
    Self.forget()
  }

  func applicationWillTerminate(_ notification: Notification) {
    Self.forget()
  }

  static func forget() {
    guard let bundleID = Bundle.main.bundleIdentifier else { return }
    UserDefaults.standard.removePersistentDomain(forName: bundleID)
    // Removing the domain leaves an empty file behind once it is written out; remove that too.
    CFPreferencesAppSynchronize(bundleID as CFString)
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    try? FileManager.default.removeItem(at: library.appendingPathComponent("Preferences/\(bundleID).plist"))
    for folder in [ "Caches", "HTTPStorages" ] {
      try? FileManager.default.removeItem(at: library.appendingPathComponent(folder).appendingPathComponent(bundleID))
    }
  }
}
