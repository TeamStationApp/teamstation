import Foundation

/// The words on a linked row and in the link picker, kept out of the view so they can be tested
/// and so a flow's assertions and the screen cannot drift apart.
public enum SourceLinkLabel {
  public static let linkedForControl = "Linked for remote control"
  public static let pickerTitle = "Link a camera for remote control"
  public static let noCandidates = "No controllable cameras found"

  /// A picker entry: the phone's name, and its address when it has one, because two phones with the
  /// same default name are told apart by the sticker on the tripod.
  public static func candidate(name: String, host: String?) -> String {
    guard let host, !host.isEmpty else { return name }
    return "\(name) · \(host)"
  }

  /// The `link=` field of a row's accessibility value. `video:N` on the row with the picture (N
  /// is the display row of its phone), `control:N` on the phone (N is the row it controls), empty
  /// for a row in no link.
  public static func accessibilityLink(video controlRow: Int? = nil, control videoRow: Int? = nil) -> String {
    if let controlRow { return "video:\(controlRow)" }
    if let videoRow { return "control:\(videoRow)" }
    return ""
  }
}
