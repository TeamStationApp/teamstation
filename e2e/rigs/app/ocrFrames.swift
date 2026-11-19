// Reads the text in each image named on the command line with macOS Vision,
// and prints one JSON line per image: {"file": …, "lines": [ … ]}, the
// recognised lines top to bottom. For e2e evidence read from a phone's
// screen recording (e2e/rigs/app/screenRecording.ts).
//
//   swift e2e/rigs/app/ocrFrames.swift frame1.png frame2.png …
import Foundation
import Vision

for path in CommandLine.arguments.dropFirst() {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  let handler = VNImageRequestHandler(url: URL(fileURLWithPath: path), options: [:])
  var lines: [String] = []
  do {
    try handler.perform([request])
    let observations = (request.results ?? []).sorted {
      $0.boundingBox.midY > $1.boundingBox.midY
    }
    lines = observations.compactMap { $0.topCandidates(1).first?.string }
  } catch {
    FileHandle.standardError.write("\(path): \(error)\n".data(using: .utf8)!)
  }
  let record: [String: Any] = ["file": path, "lines": lines]
  let data = try JSONSerialization.data(withJSONObject: record)
  print(String(data: data, encoding: .utf8)!)
}
