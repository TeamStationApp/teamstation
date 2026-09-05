import CoreGraphics
import Foundation
import DirectorSources

/// Which RTSP path to pull from each kind of camera.
///
/// NearStream has a low-res `/live/substream2` that can PLAY beside Director's `/live/mainstream`
/// (`/live/substream` 404s). GS Cameraman has one stream and serves any number of clients from one
/// encode, so Preview pulls its advertised path — mainstream — at the cost of the phone's upload
/// bandwidth and nothing else.
public enum PreviewStream: Sendable {
  public static let nearStreamPath = "/live/substream2"
  public static let userAgent = "GS Preview/1.0"

  public static func endpoint(host: String, port: Int = 554) -> CameraEndpoint {
    CameraEndpoint(host: host, port: port, path: nearStreamPath)
  }

  /// NearStream: `substream2`, whatever TXT `path` says. Cameraman: the path it advertised.
  public static func endpoint(from advertisement: CameraAdvertisement) -> CameraEndpoint {
    if PreviewCameraRules.isCameraman(advertisement) {
      return advertisement.endpoint
    }
    return CameraEndpoint(host: advertisement.host, port: advertisement.port, path: nearStreamPath)
  }
}

public enum PreviewCameraRules: Sendable {
  /// VM33 `modelname` (e.g. `VM33_00001`).
  public static func isNearStream(_ advertisement: CameraAdvertisement) -> Bool {
    advertisement.modelName?.hasPrefix("VM33") == true
  }

  /// GS Cameraman puts its UUID in TXT `uuid`.
  public static func isCameraman(_ advertisement: CameraAdvertisement) -> Bool {
    advertisement.uuid != nil
  }

  /// Everything Preview lists.
  public static func isShown(_ advertisement: CameraAdvertisement) -> Bool {
    isNearStream(advertisement) || isCameraman(advertisement)
  }

  /// Same identity Director uses: sticker serial (`modelname`), else the media host.
  /// Advertised names can flap with Bonjour; unique id does not.
  public static func tileID(for advertisement: CameraAdvertisement) -> String? {
    guard advertisement.hasUsableMediaHost else { return nil }
    return advertisement.uniqueID ?? advertisement.host
  }

  /// Director's `CameraRegistry.remembered`: merge this browse into the last snapshot
  /// instead of replacing it, so a Bonjour glitch that omits one instance does not
  /// forget a camera the session already saw.
  public static func remembering(
    previous: [CameraAdvertisement],
    incoming: [CameraAdvertisement]
  ) -> [CameraAdvertisement] {
    var byUniqueID: [String: CameraAdvertisement] = [:]
    var byHost: [String: CameraAdvertisement] = [:]

    func store(_ advertisement: CameraAdvertisement) {
      if let uniqueID = advertisement.uniqueID {
        byUniqueID[uniqueID] = advertisement
      } else {
        byHost[advertisement.host] = advertisement
      }
    }

    previous.forEach(store)
    for advertisement in incoming {
      if advertisement.uniqueID != nil {
        store(advertisement)
      } else if byHost[advertisement.host] == nil,
                byUniqueID.values.allSatisfy({ $0.host != advertisement.host }) {
        store(advertisement)
      }
    }

    let claimedHosts = Set(byUniqueID.values.map(\.host))
    return Array(byUniqueID.values) + byHost.values.filter { !claimedHosts.contains($0.host) }
  }

  /// First sight of each id, in advertisement order.
  public static func arrivingIDs(_ advertisements: [CameraAdvertisement]) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    for advertisement in advertisements {
      guard let id = tileID(for: advertisement), seen.insert(id).inserted else { continue }
      result.append(id)
    }
    return result
  }

  /// Keep already-visible cameras in place; append new ids; drop only ids that
  /// are neither in this browse nor still retained (streaming).
  public static func merging(
    existing: [String],
    arriving: [String],
    retaining: Set<String> = []
  ) -> [String] {
    var seen = Set<String>()
    var result: [String] = []
    let keep = Set(arriving).union(retaining)
    for id in existing where keep.contains(id) && seen.insert(id).inserted {
      result.append(id)
    }
    for id in arriving where seen.insert(id).inserted {
      result.append(id)
    }
    return result
  }

  /// Keep already-visible cameras in place; append new ids; drop ids that have left.
  public static func appending(existing: [String], arriving: [String]) -> [String] {
    merging(existing: existing, arriving: arriving)
  }

  /// Landscape snap: the tile occupying the most vertical height.
  public static func snapIndex(visibleHeights: [CGFloat]) -> Int {
    guard !visibleHeights.isEmpty else { return 0 }
    var best = 0
    var bestHeight = visibleHeights[0]
    for index in visibleHeights.indices.dropFirst() where visibleHeights[index] > bestHeight {
      best = index
      bestHeight = visibleHeights[index]
    }
    return best
  }

  /// Fractional camera index from a vertical scroll offset. 0 is the first
  /// camera fully in view; 0.3 means ~70% of that camera and ~30% of the next.
  public static func focusProgress(offset: CGFloat, pageStride: CGFloat, count: Int) -> CGFloat {
    guard pageStride > 0, count > 0 else { return 0 }
    let maxProgress = CGFloat(max(count - 1, 0))
    return min(max(offset / pageStride, 0), maxProgress)
  }

  public static func nearestIndex(progress: CGFloat, count: Int) -> Int {
    guard count > 0 else { return 0 }
    return min(max(Int(progress.rounded()), 0), count - 1)
  }

  public static func overlayOffset(progress: CGFloat, thumbStride: CGFloat) -> CGFloat {
    progress * thumbStride
  }

  /// Landscape reports 0 top safe area because the notch sits on a short
  /// edge, but Notification / Control Center still own the top of the
  /// display. Rest the first thumbnail below the larger of the real top
  /// inset and the notch-side inset (the same size portrait uses).
  public static func landscapeThumbTopInset(
    top: CGFloat,
    leading: CGFloat,
    trailing: CGFloat
  ) -> CGFloat {
    max(max(top, leading), max(trailing, 24))
  }
}
