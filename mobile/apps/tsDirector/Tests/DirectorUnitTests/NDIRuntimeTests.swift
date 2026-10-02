import CNDI
import XCTest
@testable import DirectorNDI

/// The gate on the vendored library itself.
///
/// This is not a formality. `libndi_ios.a` ships no arm64 simulator slice, and the one this app
/// links is produced by retargeting the device slice in `bootstrapNdi.sh`. If that retargeting
/// stops working — a new SDK build, a different load-command layout — the failure is a library
/// that links and then does nothing, which downstream looks exactly like a network with no cameras
/// on it. Running this on the simulator *and* the device is what tells the two apart.
final class NDIRuntimeTests: XCTestCase {
  func testLibraryReportsAVersion() {
    XCTAssertTrue(NDIRuntime.shared.acquire(), "NDIlib_initialize failed")
    defer { NDIRuntime.shared.release() }

    let version = NDIRuntime.shared.version
    XCTAssertFalse(version.isEmpty, "the NDI library did not report a version")
    XCTAssertTrue(version.contains("NDI"), "unexpected version string: \(version)")
    XCTAssertTrue(NDIRuntime.shared.isRunning)
  }

  func testSupportedCPU() {
    XCTAssertTrue(
      NDIRuntime.shared.isSupportedCPU,
      "the NDI SDK does not support this CPU, which would make every camera silently absent"
    )
  }

  /// The library is a process-wide singleton whose teardown stops discovery for everyone, so the
  /// count has to survive nested users. A source stopping must not take the finder down with it.
  func testNestedAcquireKeepsTheLibraryRunning() {
    XCTAssertTrue(NDIRuntime.shared.acquire())
    XCTAssertTrue(NDIRuntime.shared.acquire())
    NDIRuntime.shared.release()
    XCTAssertTrue(NDIRuntime.shared.isRunning, "the library stopped while a user still held it")
    NDIRuntime.shared.release()
  }

  /// A release with no matching acquire is ignored rather than driving the count negative, which
  /// would let the next release tear the library down under a live camera.
  func testUnbalancedReleaseIsIgnored() {
    NDIRuntime.shared.release()
    NDIRuntime.shared.release()
    XCTAssertTrue(NDIRuntime.shared.acquire())
    XCTAssertTrue(NDIRuntime.shared.isRunning)
    NDIRuntime.shared.release()
  }
}
