import CoreVideo
import DirectorPipeline
import DirectorSources
import DirectorUI
import Foundation
import Testing

/// Director's own zoom: the crop, and the per-camera value it is driven from.
@Suite("Digital zoom")
struct DigitalZoomTests {
  /// A 4:2:0 picture whose left half is black and right half white, so a centre crop is visible
  /// as a change in where the edge sits.
  private func halves(width: Int = 640, height: Int = 360) throws -> CVPixelBuffer {
    var created: CVPixelBuffer?
    let attributes = [ kCVPixelBufferIOSurfacePropertiesKey: [:] ] as CFDictionary
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes, &created)
    let buffer = try #require(created)
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    let lumaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0)
    for row in 0 ..< height {
      for column in 0 ..< width { luma[row * lumaStride + column] = column < width / 2 ? 16 : 235 }
    }
    let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1)!.assumingMemoryBound(to: UInt8.self)
    let chromaStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1)
    for row in 0 ..< height / 2 {
      for column in 0 ..< width { chroma[row * chromaStride + column] = 128 }
    }
    return buffer
  }

  private func luma(_ buffer: CVPixelBuffer, x: Int, y: Int) -> UInt8 {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = CVPixelBufferGetBaseAddressOfPlane(buffer, 0)!.assumingMemoryBound(to: UInt8.self)
    return base[y * CVPixelBufferGetBytesPerRowOfPlane(buffer, 0) + x]
  }

  @Test("A 2x zoom keeps the size and doubles what is in the middle")
  func zoomCropsTheCentre() throws {
    let source = try halves()
    let zoomed = try #require(PixelConverter().zoom(source, by: 2))
    #expect(CVPixelBufferGetWidth(zoomed) == 640)
    #expect(CVPixelBufferGetHeight(zoomed) == 360)
    // x = 200 is black in the source (left of 320); after a centre 2x crop it maps to source
    // x = 160 + 200 / 2 = 260, still black. x = 440 maps to 380, white. The quarter points of the
    // source, 160 and 480, have moved out of frame, so the edges are both halves at their widest.
    #expect(luma(zoomed, x: 4, y: 180) < 60)
    #expect(luma(zoomed, x: 635, y: 180) > 200)
    #expect(luma(zoomed, x: 200, y: 180) < 60)
    #expect(luma(zoomed, x: 440, y: 180) > 200)
    // The source is left as it was: no clean aperture stays on it.
    #expect(CVBufferCopyAttachment(source, kCVImageBufferCleanApertureKey, nil) == nil)
  }

  @Test("1x is no crop at all")
  func noZoomIsNoWork() throws {
    #expect(PixelConverter().zoom(try halves(), by: 1) == nil)
  }

  @Test("A saved row from before the zoom existed decodes at 1x, and the zoom is clamped")
  func selectionZoom() throws {
    let old = #"[{"id":{"rawValue":"CAM1"},"kind":"synthetic","advertisedName":"CAM1","isEnabled":true}]"#
    let rows = try JSONDecoder().decode([SourceSelection].self, from: Data(old.utf8))
    #expect(rows[0].digitalZoom == 1)

    var selections = rows
    SourceSelectionRules.setDigitalZoom(1.5, for: rows[0].id, in: &selections)
    #expect(selections[0].digitalZoom == 1.5)
    SourceSelectionRules.setDigitalZoom(9, for: rows[0].id, in: &selections)
    #expect(selections[0].digitalZoom == 2)
    SourceSelectionRules.setDigitalZoom(0.5, for: rows[0].id, in: &selections)
    #expect(selections[0].digitalZoom == 1)

    SourceSelectionRules.setDigitalZoom(1.5, for: rows[0].id, in: &selections)
    let saved = try JSONEncoder().encode(selections)
    #expect(try JSONDecoder().decode([SourceSelection].self, from: saved)[0].digitalZoom == 1.5)
  }
}
