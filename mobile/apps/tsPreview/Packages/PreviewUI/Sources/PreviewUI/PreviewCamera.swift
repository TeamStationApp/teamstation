import Foundation
import DirectorSources
import PreviewCore

@MainActor
public final class PreviewCamera: Identifiable {
  public let id: String
  public var advertisedName: String
  public var endpoint: CameraEndpoint
  /// A TS Cameraman advertising `control=params/1`: the tile gets the three-dot button.
  public var hasCameraControl = false
  public let renderer = PreviewRenderer()

  var source: (any FrameSource)?
  var lastSeen = Date()

  public init(id: String, advertisedName: String, endpoint: CameraEndpoint) {
    self.id = id
    self.advertisedName = advertisedName
    self.endpoint = endpoint
  }
}
