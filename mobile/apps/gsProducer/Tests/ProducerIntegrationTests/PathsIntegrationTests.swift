import Foundation
import ProducerCore
import Testing

@Suite("Paths")
struct PathsIntegrationTests {
  @Test("Producer directories can be created in the app container")
  func createsDirectories() throws {
    try ProducerPaths.createAll()
    #expect(FileManager.default.fileExists(atPath: ProducerPaths.archives.path))
    #expect(FileManager.default.fileExists(atPath: ProducerPaths.proxies.path))
  }
}
