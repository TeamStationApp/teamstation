import Foundation

#if TS_PUSH_COVERAGE
@_silgen_name("__llvm_profile_set_filename")
private func llvmProfileSetFilename(_ name: UnsafePointer<CChar>)

@_silgen_name("__llvm_profile_write_file")
private func llvmProfileWriteFile() -> Int32
#endif

/**
 * The push code's coverage counters, in a build made for measuring them
 * (`TS_PUSH_COVERAGE`, `scripts/push-coverage.mjs`); nothing in any other.
 *
 * The app and its notification extension are separate processes, and iOS
 * ends either without running its exit hooks, so each names its own file in
 * its own temporary directory and writes its counters whenever it has
 * handled something, rather than relying on `LLVM_PROFILE_FILE` reaching the
 * extension or on a clean exit.
 */
enum PushCoverage {
  private static let named: Void = {
    #if TS_PUSH_COVERAGE
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("push-%p.profraw")
    // The runtime keeps the pointer, so the copy is never freed.
    llvmProfileSetFilename(strdup(path)!)
    #endif
  }()

  /// Names this process's file; once is enough.
  static func start() {
    _ = named
  }

  #if TS_PUSH_COVERAGE
  /// Two writes at once leave a file `llvm-profdata` cannot read.
  private static let writing = NSLock()
  #endif

  /// Writes the counters so far.
  static func flush() {
    start()
    #if TS_PUSH_COVERAGE
    writing.withLock { _ = llvmProfileWriteFile() }
    #endif
  }
}
