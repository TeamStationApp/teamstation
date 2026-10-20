import Foundation
import Testing
@testable import EventControl

@Suite("Canonical user identities")
struct TeamStationUserIDTests {
  @Test func sharedValidationVectors() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { root.deleteLastPathComponent() }
    let data = try Data(contentsOf: root.appending(path: "src/common/userId.vectors.json"))
    let corpus = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    for row in corpus["accepted"] as! [[String: String]] {
      let id = row["userId"]!
      #expect(TeamStationUserID.canonical(id) == id)
      #expect(TeamStationUserID.canonical(row["value"]!) == nil)
    }
    for bad in corpus["rejected"] as! [String] {
      #expect(TeamStationUserID.canonical(bad) == nil, "\(bad)")
    }
    for bad in ["", "0", "01", "-1", "1.0", " 1", "1\n", "9007199254740992", "18446744073709551616"] {
      #expect(TeamStationUserID.canonical(bad) == nil)
    }
  }

  @Test func grantRejectsNumbersAndMissingVersion() throws {
    let encoded = try JSONEncoder().encode(Fixtures.one)
    let original = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    for bad in [1001, "1001", "usr_1111111111111111111111"] as [Any] {
      var reply = original
      reply["userId"] = bad
      let data = try JSONSerialization.data(withJSONObject: reply)
      #expect(throws: (any Error).self) { try EventControlCredentials.decode(serverReply: data) }
    }
    var reply = original
    reply.removeValue(forKey: "version")
    let data = try JSONSerialization.data(withJSONObject: reply)
    #expect(throws: (any Error).self) { try EventControlCredentials.decode(serverReply: data) }
  }
}
