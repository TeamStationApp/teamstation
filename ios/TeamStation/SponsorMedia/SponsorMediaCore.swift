import CoreGraphics
import Foundation

/**
 * The sizes, crops and frame pacing behind `SponsorMedia`, kept free of
 * UIKit and AVFoundation so the tests can check them directly. Every size is
 * in pixels.
 */
enum SponsorMediaCore {
  /** The sentence the screen shows for a picture that cannot be used. */
  static let pictureProblem = "This picture could not be read. Try another file."
  /** The sentence the screen shows for a video that cannot be shrunk. */
  static let videoProblem = "This video could not be shrunk. Try another file."

  struct Problem: Error {
    let sentence: String
  }

  /** The image formats an upload may be written as. */
  enum Format: String {
    case png
    case jpeg

    var fileExtension: String { self == .png ? "png" : "jpg" }
  }

  static func format(_ name: String) throws -> Format {
    guard let format = Format(rawValue: name) else {
      throw Problem(sentence: pictureProblem)
    }
    return format
  }

  /**
   * `width` × `height` shrunk to fit within `maxWidth` × `maxHeight`, its
   * proportions kept and never enlarged. `even` rounds each side down to an
   * even number, as the video encoder needs; otherwise each side is rounded,
   * and no side is ever under one pixel (two when even).
   */
  static func fit(
    width: Double, height: Double, maxWidth: Double, maxHeight: Double, even: Bool
  ) -> (width: Int, height: Int) {
    let scale = min(1, maxWidth / width, maxHeight / height)
    let w = width * scale
    let h = height * scale
    if even {
      return (max(2, Int(w / 2) * 2), max(2, Int(h / 2) * 2))
    }
    return (max(1, Int(w.rounded())), max(1, Int(h.rounded())))
  }

  /** The largest centred square of a `width` × `height` picture. */
  static func squareCrop(width: Double, height: Double) -> CGRect {
    let side = min(width, height)
    return CGRect(x: (width - side) / 2, y: (height - side) / 2, width: side, height: side)
  }

  /**
   * The largest part of a `width` × `height` picture in the `boxWidth` :
   * `boxHeight` proportion, anchored to its upper-right corner, and the size
   * it is drawn at: at most `boxWidth` wide, never enlarged.
   */
  static func coverCrop(
    width: Double, height: Double, boxWidth: Double, boxHeight: Double
  ) -> (crop: CGRect, width: Int, height: Int) {
    let aspect = boxWidth / boxHeight
    let crop =
      width / height > aspect
      ? CGRect(x: width - height * aspect, y: 0, width: height * aspect, height: height)
      : CGRect(x: 0, y: 0, width: width, height: width / aspect)
    let outWidth = min(crop.width, boxWidth)
    return (crop, max(1, Int(outWidth.rounded())), max(1, Int((outWidth / aspect).rounded())))
  }

  /**
   * Keeps a frame only when it is at least `1 / fps` after the last one
   * kept, so the output never runs faster than `fps`.
   */
  struct FramePacer {
    let interval: Double
    private var last: Double?

    init(fps: Double) {
      interval = 1 / fps
    }

    mutating func keep(_ seconds: Double) -> Bool {
      if let last, seconds - last < interval - 1e-6 {
        return false
      }
      last = seconds
      return true
    }
  }

  /** A `file://` URI, or a plain path, as a file URL. */
  static func fileURL(_ uri: String, problem: String) throws -> URL {
    if let url = URL(string: uri), url.isFileURL {
      return url
    }
    guard uri.hasPrefix("/") else {
      throw Problem(sentence: problem)
    }
    return URL(fileURLWithPath: uri)
  }

  /** A new file for an output, in the app's temporary directory. */
  static func outputURL(_ fileExtension: String) -> URL {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("sponsor-\(UUID().uuidString).\(fileExtension)")
  }
}
