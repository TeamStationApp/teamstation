import Foundation
import ProducerCore

/// Builds the discovery implementation for a profile.
public enum SourceProfileFactory {
  public static func syntheticName(_ index: Int) -> String { "CAM\(index + 1)" }

  public static func syntheticDiscovery(
    count: Int = 4,
    frameRate: Double = 30,
    width: Int = 1920,
    height: Int = 1080,
    entropy: SyntheticEntropy = .high,
    wireCodec: CompressedFrame.Codec = .h264,
    clock: ProducerClock
  ) -> SourceDiscovery {
    let sources = (0 ..< count).map { index in
      DiscoveredSource(
        id: SourceID("SYNTH-\(index + 1)"),
        kind: .synthetic,
        advertisedName: syntheticName(index)
      )
    }
    return FakeDiscovery(kind: .synthetic, sources: sources) { discovered in
      let index = sources.firstIndex(where: { $0.id == discovered.id }) ?? 0
      return SyntheticFrameSource(
        sourceID: discovered.id,
        displayName: discovered.advertisedName,
        width: width,
        height: height,
        frameRate: frameRate,
        paletteIndex: index,
        entropy: entropy,
        wireCodec: wireCodec,
        clock: clock
      )
    }
  }

  public static func fileDiscovery(
    fixtures: [URL],
    clock: ProducerClock
  ) -> SourceDiscovery {
    let sources = fixtures.enumerated().map { index, url in
      DiscoveredSource(
        id: SourceID("FILE-\(index + 1)"),
        kind: .file,
        advertisedName: url.deletingPathExtension().lastPathComponent,
        address: url.path
      )
    }
    return FakeDiscovery(kind: .file, sources: sources) { discovered in
      guard let path = discovered.address else {
        throw FrameSourceError.unavailable("file source without a path")
      }
      return FileFrameSource(
        sourceID: discovered.id,
        displayName: discovered.advertisedName,
        url: URL(fileURLWithPath: path),
        clock: clock
      )
    }
  }
}
