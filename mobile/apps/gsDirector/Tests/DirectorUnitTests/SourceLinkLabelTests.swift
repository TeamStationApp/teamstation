import Foundation
import DirectorUI
import Testing

@Suite("Source link label")
struct SourceLinkLabelTests {
  @Test("A candidate shows its address when it has one")
  func candidateLabel() {
    #expect(SourceLinkLabel.candidate(name: "Phone", host: "192.168.7.4") == "Phone · 192.168.7.4")
    #expect(SourceLinkLabel.candidate(name: "Phone", host: nil) == "Phone")
    #expect(SourceLinkLabel.candidate(name: "Phone", host: "") == "Phone")
  }

  @Test("The link field names the partner's display row from either side, and is empty otherwise")
  func accessibilityLink() {
    #expect(SourceLinkLabel.accessibilityLink(video: 3) == "video:3")
    #expect(SourceLinkLabel.accessibilityLink(control: 1) == "control:1")
    #expect(SourceLinkLabel.accessibilityLink() == "")
  }
}
