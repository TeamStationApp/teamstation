import CoreGraphics
import Foundation
import DistributorWire
import Testing

@Suite("Combined video layout")
struct CombinedLayoutTests {
  @Test("Remembered quadrants come back; the most recent claim to a quadrant wins")
  func rememberedPlacement() {
    let saved = CombinedLayoutSettings(placements: [
      QuadrantPlacement(camera: "Home", quadrant: .bottomTrailing),
      QuadrantPlacement(camera: "Away", quadrant: .bottomTrailing),
      QuadrantPlacement(camera: "Away", quadrant: .topLeading)
    ])
    let assignment = CombinedLayoutRules.assign([ "Away", "Home", "Wide" ], saved: saved)
    #expect(assignment["Home"] == .bottomTrailing)
    // Away's newer claim lost to Home's; its older one still stands.
    #expect(assignment["Away"] == .topLeading)
    // Wide was never placed, so it takes the first free quadrant.
    #expect(assignment["Wide"] == .topTrailing)
  }

  @Test("processVid's familiar names land where it put them the first time")
  func familiarNames() {
    let assignment = CombinedLayoutRules.assign([ "center", "mound", "3rd", "1st" ], saved: CombinedLayoutSettings())
    #expect(assignment == [ "center": .topLeading, "mound": .topTrailing, "3rd": .bottomLeading, "1st": .bottomTrailing ])
  }

  @Test("Only four cameras are placed")
  func fourAtMost() {
    let assignment = CombinedLayoutRules.assign([ "a", "b", "c", "d", "e" ], saved: CombinedLayoutSettings())
    #expect(assignment.count == 4)
    #expect(assignment["e"] == nil)
    #expect(CombinedLayoutRules.initialInclusion(exported: [ "a", "b", "c", "d", "e" ], saved: CombinedLayoutSettings()) == [ "a", "b", "c", "d" ])
  }

  @Test("Remembering puts this export first and keeps cameras it did not have")
  func rememberKeepsOthers() {
    let before = CombinedLayoutSettings(
      included: [ "Home", "Old" ],
      placements: [ QuadrantPlacement(camera: "Old", quadrant: .topLeading) ],
      audioCamera: "Old"
    )
    let after = CombinedLayoutRules.remember(
      [ "Home": .topLeading, "Away": .topTrailing ],
      included: [ "Home", "Away" ],
      solo: nil,
      audioCamera: "Home",
      in: before
    )
    #expect(after.placements == [
      QuadrantPlacement(camera: "Home", quadrant: .topLeading),
      QuadrantPlacement(camera: "Away", quadrant: .topTrailing),
      QuadrantPlacement(camera: "Old", quadrant: .topLeading)
    ])
    #expect(after.included == [ "Home", "Away" ])
    #expect(after.audioCamera == "Home")
    // Next time with Old and Home, Home keeps top left and Old moves to the first free quadrant.
    #expect(CombinedLayoutRules.assign([ "Old", "Home" ], saved: after) == [ "Home": .topLeading, "Old": .topTrailing ])
  }

  @Test("The remembered sound camera is kept if it is in and has sound, else the first that does")
  func audioChoice() {
    #expect(CombinedLayoutRules.audioCamera(included: [ "A", "B" ], withAudio: [ "A", "B" ], saved: "B") == "B")
    #expect(CombinedLayoutRules.audioCamera(included: [ "A", "B" ], withAudio: [ "A" ], saved: "B") == "A")
    #expect(CombinedLayoutRules.audioCamera(included: [ "A", "C" ], withAudio: [ "C" ], saved: "B") == "C")
    #expect(CombinedLayoutRules.audioCamera(included: [ "A" ], withAudio: [], saved: nil) == nil)
  }

  @Test("Four megabits a second per camera")
  func bitrate() {
    #expect(CombinedLayoutRules.bitsPerSecond(cameraCount: 4) == 16_000_000)
    #expect(CombinedLayoutRules.bitsPerSecond(cameraCount: 3) == 12_000_000)
    #expect(CombinedLayoutRules.bitsPerSecond(cameraCount: 2) == 8_000_000)
  }

  @Test("Four cameras fill 1080p quadrants of a 4K canvas")
  func fourCameraFrames() {
    let frames = CombinedGeometry.frames(
      assignment: [ "a": .topLeading, "b": .topTrailing, "c": .bottomLeading, "d": .bottomTrailing ],
      solo: nil
    )
    #expect(frames["a"] == CGRect(x: 0, y: 0, width: 1920, height: 1080))
    #expect(frames["d"] == CGRect(x: 1920, y: 1080, width: 1920, height: 1080))
  }

  @Test("With three cameras the one beside the empty quadrant slides along its free axis")
  func soloSlides() {
    // Two on the left, one top right: the right-hand video slides up and down.
    let leftPair: [String: Quadrant] = [ "a": .topLeading, "b": .bottomLeading, "c": .topTrailing ]
    let candidates = CombinedGeometry.soloCandidates(assignment: leftPair)
    #expect(candidates.map(\.camera) == [ "c", "b" ])
    #expect(candidates.map(\.axis) == [ .vertical, .horizontal ])

    let centred = CombinedGeometry.frames(assignment: leftPair, solo: SoloPlacement(camera: "c", axis: .vertical, position: 0.5))
    #expect(centred["c"] == CGRect(x: 1920, y: 540, width: 1920, height: 1080))
    let slidDown = CombinedGeometry.frames(assignment: leftPair, solo: SoloPlacement(camera: "c", axis: .vertical, position: 1))
    #expect(slidDown["c"] == CGRect(x: 1920, y: 1080, width: 1920, height: 1080))

    // Two on the bottom, one top left: the top video slides left and right.
    let bottomPair: [String: Quadrant] = [ "a": .topLeading, "b": .bottomLeading, "c": .bottomTrailing ]
    let across = CombinedGeometry.frames(assignment: bottomPair, solo: SoloPlacement(camera: "a", axis: .horizontal, position: 0.5))
    #expect(across["a"] == CGRect(x: 960, y: 0, width: 1920, height: 1080))
    #expect(across["b"] == CGRect(x: 0, y: 1080, width: 1920, height: 1080))
  }

  @Test("A solo that no longer fits the arrangement starts over, centred")
  func staleSoloIsReplaced() {
    let assignment: [String: Quadrant] = [ "a": .topLeading, "b": .bottomLeading, "c": .topTrailing ]
    let stale = SoloPlacement(camera: "a", axis: .vertical, position: 0.2)
    #expect(CombinedGeometry.effectiveSolo(assignment: assignment, saved: stale) == SoloPlacement(camera: "c", axis: .vertical, position: 0.5))
  }

  @Test("Two cameras sit side by side, centred vertically")
  func twoCameraFrames() {
    let frames = CombinedGeometry.frames(assignment: [ "x": .bottomTrailing, "y": .topLeading ], solo: nil)
    #expect(frames["y"] == CGRect(x: 0, y: 540, width: 1920, height: 1080))
    #expect(frames["x"] == CGRect(x: 1920, y: 540, width: 1920, height: 1080))
    #expect(CombinedGeometry.frames(assignment: [ "only": .topLeading ], solo: nil).isEmpty)
  }

  @Test("The solo snaps to centre within two points of it, and not beyond")
  func snap() {
    // A 400-point slide: 2 points is 0.005 of it.
    #expect(CombinedGeometry.snapped(0.505, travel: 400) == 0.5)
    #expect(CombinedGeometry.snapped(0.495, travel: 400) == 0.5)
    #expect(CombinedGeometry.snapped(0.5075, travel: 400) == 0.5075)
    #expect(CombinedGeometry.snapped(1.4, travel: 400) == 1)
  }
}
