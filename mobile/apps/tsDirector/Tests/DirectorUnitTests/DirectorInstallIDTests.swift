import Foundation
import Testing

@testable import DirectorUI

@Suite("Director's install id")
struct DirectorInstallIDTests {
  @Test("Made once, then the same id every time")
  func keptInPreferences() throws {
    let name = "install-id-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    let first = DirectorInstallID.persisted(in: defaults)
    #expect(UUID(uuidString: first) != nil)
    #expect(DirectorInstallID.persisted(in: defaults) == first)
    // Something that is not a UUID is replaced.
    defaults.set("not an id", forKey: DirectorInstallID.key)
    let replaced = DirectorInstallID.persisted(in: defaults)
    #expect(replaced != "not an id")
    #expect(UUID(uuidString: replaced) != nil)
  }
}
