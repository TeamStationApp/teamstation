#!/usr/bin/env swift
// Package the shared TeamStation logo as tvOS layered icons and top-shelf artwork.
// Run from the repository root: swift appletv/scripts/make-icons.swift
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("ios/TeamStation/Images.xcassets/AppIcon.appiconset/AppIcon.png")
let logo = NSImage(contentsOf: source)!
let pixels = NSBitmapImageRep(data: try Data(contentsOf: source))!
let background = pixels.colorAt(x: 0, y: 0)!
let catalog = root.appendingPathComponent("appletv/ios/TeamStationTV/Images.xcassets/AppIcon.brandassets")
let info: [String: Any] = ["author": "xcode", "version": 1]
func json(_ directory: URL, _ fields: [String: Any]) throws {
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  var data = fields
  data["info"] = info
  try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("Contents.json"))
}
func png(_ url: URL, _ width: Int, _ height: Int, _ drawLogo: Bool, _ opaque: Bool) throws {
  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSColor.clear.setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()
  if opaque {
    background.setFill()
    NSRect(x: 0, y: 0, width: width, height: height).fill()
  }
  if drawLogo {
    let size = Double(height) * 0.9
    logo.draw(in: NSRect(x: (Double(width)-size)/2, y: (Double(height)-size)/2, width: size, height: size), from: .zero, operation: .sourceOver, fraction: 1)
  }
  NSGraphicsContext.restoreGraphicsState()
  try bitmap.representation(using: .png, properties: [:])!.write(to: url)
}
var assets: [[String: Any]] = []
for (name, width, height, scales) in [("Icon",400,240,[1,2]), ("StoreIcon",1280,768,[1])] {
  let stack = catalog.appendingPathComponent("\(name).imagestack")
  try json(stack, ["layers": [["filename": "Foreground.imagestacklayer"], ["filename": "Background.imagestacklayer"]]])
  for layer in ["Foreground", "Background"] {
    let folder = stack.appendingPathComponent("\(layer).imagestacklayer")
    try json(folder, [:])
    let images = folder.appendingPathComponent("Content.imageset")
    try json(images, ["images": scales.map { ["filename": "image@\($0)x.png", "idiom": "tv", "scale": "\($0)x"] }])
    for scale in scales {
      try png(images.appendingPathComponent("image@\(scale)x.png"), width*scale, height*scale, layer == "Foreground", layer == "Background")
    }
  }
  assets.append(["filename": "\(name).imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "\(width)x\(height)"])
}
for (name,width,role) in [("TopShelf",1920,"top-shelf-image"),("TopShelfWide",2320,"top-shelf-image-wide")] {
  let folder = catalog.appendingPathComponent("\(name).imageset")
  try json(folder, ["images": [1,2].map { ["filename": "image@\($0)x.png", "idiom": "tv", "scale": "\($0)x"] }])
  for scale in [1,2] { try png(folder.appendingPathComponent("image@\(scale)x.png"), width*scale, 720*scale, true, true) }
  assets.append(["filename": "\(name).imageset", "idiom": "tv", "role": role, "size": "\(width)x720"])
}
try json(catalog, ["assets": assets])
