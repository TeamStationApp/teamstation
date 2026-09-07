import XCTest
@testable import DirectorNDI

/// How an NDI source's name becomes an identity.
///
/// The stakes are in `sourceID`: it is what the archive, the timeline and the operator's own name
/// for a camera all hang off. Two cameras collapsing to one identity attaches one camera's history
/// to another; one camera producing two identities loses its history at the worst possible moment.
final class NDISourceNameTests: XCTestCase {
  func testSplitsMachineAndStream() {
    let name = NDISourceName(full: "BERN (GS NDI 1)")
    XCTAssertEqual(name.machine, "BERN")
    XCTAssertEqual(name.stream, "GS NDI 1")
    XCTAssertEqual(name.displayName, "GS NDI 1")
    XCTAssertEqual(name.full, "BERN (GS NDI 1)")
  }

  /// A stream name may contain parentheses of its own — "Cam 1 (wide)" is an ordinary thing to
  /// call a camera — so the split has to be on the last group, not the first.
  func testStreamNameMayContainParentheses() {
    let name = NDISourceName(full: "RACK-2 (Cam 1 (wide))")
    XCTAssertEqual(name.machine, "RACK-2")
    XCTAssertEqual(name.stream, "Cam 1 (wide)")
  }

  /// Some senders publish a bare name. It has to survive rather than parse to nothing.
  func testNameWithoutMachine() {
    let name = NDISourceName(full: "Studio Monitor")
    XCTAssertEqual(name.machine, "")
    XCTAssertEqual(name.stream, "Studio Monitor")
    XCTAssertEqual(name.displayName, "Studio Monitor")
  }

  func testUnicodeAndPunctuationSurvive() {
    let name = NDISourceName(full: "STUDIO-Á (Caméra Une)")
    XCTAssertEqual(name.machine, "STUDIO-Á")
    XCTAssertEqual(name.stream, "Caméra Une")
    XCTAssertFalse(name.sourceID.rawValue.isEmpty)
    XCTAssertTrue(name.sourceID.rawValue.hasPrefix("NDI-"))
  }

  /// The same camera seen twice must be the same identity, or its archive restarts every time
  /// discovery sweeps.
  func testIdentityIsStableAcrossSightings() {
    XCTAssertEqual(
      NDISourceName(full: "BERN (GS NDI 1)").sourceID,
      NDISourceName(full: "BERN (GS NDI 1)").sourceID
    )
  }

  /// Two identical stream names on different machines are the normal state of a rack of identical
  /// units, and they must not collapse into one row.
  func testSameStreamOnDifferentMachinesAreDifferentCameras() {
    XCTAssertNotEqual(
      NDISourceName(full: "RACK-1 (Camera 1)").sourceID,
      NDISourceName(full: "RACK-2 (Camera 1)").sourceID
    )
  }

  /// A rename is a new identity on purpose. `CameraIdentity` already knows how to offer the
  /// operator a rebind; silently treating a renamed source as the same camera would attach one
  /// camera's recording to another.
  func testRenameProducesANewIdentity() {
    XCTAssertNotEqual(
      NDISourceName(full: "BERN (GS NDI 1)").sourceID,
      NDISourceName(full: "BERN (First Base)").sourceID
    )
  }

  /// The id ends up in file paths and SQLite keys, so it may not carry separators or run away in
  /// length.
  func testIdentityIsSafeToUseAsAKey() {
    let id = NDISourceName(full: "BERN (Cam/1: \"wide\" — 2026)").sourceID.rawValue
    XCTAssertTrue(id.hasPrefix("NDI-"))
    XCTAssertFalse(id.contains("/"))
    XCTAssertFalse(id.contains(" "))
    XCTAssertFalse(id.hasSuffix("-"))
    XCTAssertLessThanOrEqual(id.count, 52)
  }

  func testEmptyNameStillProducesAnIdentity() {
    XCTAssertEqual(NDISourceName(full: "").sourceID.rawValue, "NDI-UNNAMED")
  }
}
