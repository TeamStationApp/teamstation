import Foundation
import DirectorCore

/// An NDI source's name, split the way the SDK documents it: `MACHINE_NAME (STREAM_NAME)`.
///
/// Both halves matter and they matter differently. The stream name is what an operator recognises
/// and is what goes on the tile; the machine name distinguishes two cameras that both call
/// themselves "Camera 1", which is the normal state of a rack of identical units.
public struct NDISourceName: Hashable, Sendable {
  /// The full string exactly as the SDK returned it. This is the only form
  /// `NDIlib_recv_connect` accepts, so it is kept verbatim rather than reassembled.
  public let full: String
  public let machine: String
  public let stream: String

  public init(full: String) {
    self.full = full

    // Split on the *last* opening parenthesis: a stream may legitimately contain them
    // ("Cam 1 (wide)") while the machine name is whatever precedes the final group.
    guard
      full.hasSuffix(")"),
      let open = full.lastIndex(of: "(")
    else {
      machine = ""
      stream = full
      return
    }
    let inner = full[full.index(after: open) ..< full.index(before: full.endIndex)]
    machine = String(full[full.startIndex ..< open]).trimmingCharacters(in: .whitespaces)
    stream = String(inner)
  }

  /// What the operator sees before they rename anything.
  ///
  /// The stream name alone, unless it is empty or the machine name is the only distinguishing
  /// part — two units both streaming "Camera 1" have to be told apart in the source list, and the
  /// operator cannot rename a row they cannot identify.
  public var displayName: String {
    if stream.isEmpty { return machine.isEmpty ? full : machine }
    return stream
  }

  /// A stable identity for this source across sightings.
  ///
  /// Derived from the full name rather than the URL, because the URL is documented as "not meant
  /// to be application readable and might well change". A rename therefore produces a new identity,
  /// which is correct: `CameraIdentity` already knows how to offer the operator a rebind, and the
  /// alternative — treating a renamed source as the same camera — would silently attach one
  /// camera's history to another.
  public var sourceID: SourceID {
    var slug = full.uppercased().map { character -> Character in
      character.isLetter || character.isNumber ? character : "-"
    }
    while let last = slug.last, last == "-" { slug.removeLast() }
    let trimmed = String(slug.prefix(48))
    return SourceID("NDI-\(trimmed.isEmpty ? "UNNAMED" : trimmed)")
  }
}
