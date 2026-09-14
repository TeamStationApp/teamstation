import DirectorExport
import DistributorWire
import Foundation

/// The three folders the Mac may read from, and the rule that keeps it inside them.
public struct FileRoots: Sendable {
  public var archives: URL
  public var program: URL
  public var prepared: URL

  public init(archives: URL, program: URL, prepared: URL) {
    self.archives = archives
    self.program = program
    self.prepared = prepared
  }

  public init(_ roots: RecordingFileRoots) {
    self.init(archives: roots.archives, program: roots.program, prepared: roots.prepared)
  }

  public func base(_ root: FileRoot) -> URL {
    switch root {
    case .archives: archives
    case .program: program
    case .prepared: prepared
    }
  }

  /// The file `relativePath` names inside `root`, or nil when there is no such file or the path
  /// would lead anywhere else: `..`, an absolute path, or a symlink pointing out of the root.
  public func url(root: FileRoot, relativePath: String) -> URL? {
    guard !relativePath.isEmpty, !relativePath.hasPrefix("/") else { return nil }
    let parts = relativePath.split(separator: "/", omittingEmptySubsequences: false)
    guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    let base = base(root).standardizedFileURL.resolvingSymlinksInPath()
    let candidate = base.appendingPathComponent(relativePath).standardizedFileURL.resolvingSymlinksInPath()
    guard candidate.path.hasPrefix(base.path + "/") else { return nil }
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory),
          !isDirectory.boolValue
    else { return nil }
    return candidate
  }

  /// Where `url`, which must lie inside `root`, sits relative to it, as the Mac asks for it.
  public func relativePath(of url: URL, in root: FileRoot) -> String? {
    let base = base(root).standardizedFileURL.resolvingSymlinksInPath().path + "/"
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    guard path.hasPrefix(base) else { return nil }
    return String(path.dropFirst(base.count))
  }
}
