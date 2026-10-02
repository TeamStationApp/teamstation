import XCTest
@testable import DirectorNDI

/// The rules that decide how much encoding an NDI fleet is allowed to attempt.
///
/// Both mechanisms exist to protect the same thing: the live picture. An RTSP camera's archive is
/// free, so this has no equivalent on that path — which is exactly why it is easy to get wrong and
/// worth pinning down here rather than on a bench.
final class NDIArchiveBudgetTests: XCTestCase {
  private func makeBudget(capacity: Int) -> NDIArchiveBudget {
    let budget = NDIArchiveBudget.shared
    budget.setCapacity(capacity)
    for index in 0 ..< 16 { budget.release("test-\(index)") }
    return budget
  }

  override func tearDown() {
    let budget = NDIArchiveBudget.shared
    for index in 0 ..< 16 { budget.release("test-\(index)") }
    budget.setCapacity(NDIArchiveBudget.defaultCapacity)
    super.tearDown()
  }

  func testGrantsUpToCapacityThenRefuses() {
    let budget = makeBudget(capacity: 2)
    XCTAssertTrue(budget.acquire("test-0"))
    XCTAssertTrue(budget.acquire("test-1"))
    XCTAssertFalse(budget.acquire("test-2"), "granted more archives than the device can encode")
    XCTAssertEqual(budget.inUse, 2)
  }

  /// A camera that stops recording gives its session back, or the next take has fewer archives
  /// than the last for no reason.
  func testReleasingMakesRoom() {
    let budget = makeBudget(capacity: 1)
    XCTAssertTrue(budget.acquire("test-0"))
    XCTAssertFalse(budget.acquire("test-1"))
    budget.release("test-0")
    XCTAssertTrue(budget.acquire("test-1"))
  }

  /// `setArchiving(true)` can arrive more than once for the same camera — a format change reopens
  /// the writer — and must not consume a second slot.
  func testAcquiringTwiceTakesOneSlot() {
    let budget = makeBudget(capacity: 2)
    XCTAssertTrue(budget.acquire("test-0"))
    XCTAssertTrue(budget.acquire("test-0"))
    XCTAssertEqual(budget.inUse, 1)
    XCTAssertTrue(budget.acquire("test-1"))
    XCTAssertFalse(budget.acquire("test-2"))
  }

  func testCapacityIsAtLeastOne() {
    let budget = makeBudget(capacity: 0)
    XCTAssertEqual(budget.currentCapacity, 1)
    XCTAssertTrue(budget.acquire("test-0"))
  }
}

/// Decimation: how a camera whose encoder cannot keep up records at half rate instead of at full
/// rate with holes in it.
final class ArchiveDecimatorTests: XCTestCase {
  func testEncodesEveryFrameWhileTheEncoderKeepsUp() {
    var decimator = ArchiveDecimator()
    var encoded = 0
    for _ in 0 ..< 300 where decimator.shouldEncode(backlogFull: false) { encoded += 1 }
    XCTAssertEqual(encoded, 300)
    XCTAssertEqual(decimator.stride, 1)
  }

  /// The failure this replaced: pressure that reset on every frame that happened to fit meant a
  /// camera archiving one frame in four never decimated at all. Three saturated frames in four is
  /// the shape actually measured on a simulator.
  func testDecimatesUnderSustainedButIntermittentPressure() {
    var decimator = ArchiveDecimator()
    for index in 0 ..< 400 {
      _ = decimator.shouldEncode(backlogFull: index % 4 != 0)
    }
    XCTAssertGreaterThan(decimator.stride, 1, "the archive never thinned under sustained pressure")
  }

  func testHalvesThenHalvesAgainUnderRelentlessPressure() {
    var decimator = ArchiveDecimator()
    for _ in 0 ..< 40 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertEqual(decimator.stride, 2)
    for _ in 0 ..< 40 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertEqual(decimator.stride, 4)
  }

  /// It must not thin forever: below a quarter rate the recording is not worth calling an archive,
  /// and the tile saying so is more use than a slideshow.
  func testStopsThinningAtTheFloor() {
    var decimator = ArchiveDecimator()
    for _ in 0 ..< 1_000 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertEqual(decimator.stride, ArchiveDecimator.maximumStride)
  }

  /// And it must come back, because the pressure is usually another camera starting or stopping.
  func testClimbsBackWhenThePressureGoes() {
    var decimator = ArchiveDecimator()
    for _ in 0 ..< 40 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertEqual(decimator.stride, 2)
    for _ in 0 ..< 200 { _ = decimator.shouldEncode(backlogFull: false) }
    XCTAssertEqual(decimator.stride, 1)
  }

  /// At stride 2 the encoder should see about half the frames — a continuous half-rate recording
  /// rather than an unpredictable one.
  func testStrideThinsEvenly() {
    var decimator = ArchiveDecimator()
    for _ in 0 ..< 40 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertEqual(decimator.stride, 2)

    var encoded = 0
    for _ in 0 ..< 100 where decimator.shouldEncode(backlogFull: false) { encoded += 1 }
    XCTAssertEqual(encoded, 50, accuracy: 2)
  }

  func testResetRestoresFullRate() {
    var decimator = ArchiveDecimator()
    for _ in 0 ..< 200 { _ = decimator.shouldEncode(backlogFull: true) }
    XCTAssertGreaterThan(decimator.stride, 1)
    decimator.reset()
    XCTAssertEqual(decimator.stride, 1)
  }
}
