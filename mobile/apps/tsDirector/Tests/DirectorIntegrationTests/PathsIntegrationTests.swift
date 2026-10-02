import Foundation
import DirectorCore
import Testing

@Suite("Paths")
struct PathsIntegrationTests {
  @Test("Director directories can be created in the app container")
  func createsDirectories() throws {
    try DirectorPaths.createAll()
    #expect(FileManager.default.fileExists(atPath: DirectorPaths.archives.path))
    #expect(FileManager.default.fileExists(atPath: DirectorPaths.proxies.path))
  }
}
