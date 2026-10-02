import DistributorAPI
import Foundation
import LoopbackHTTP

/// TS Distributor's REST API, on 127.0.0.1 only, from launch until quit. `-apiPort <n>` moves it,
/// for tests; `GET /api/v1` lists the routes.
@MainActor
final class APIServer {
  let adapter: APIAdapter
  private let model: DistributorModel
  private var server: LinkServer?
  private var publishing: Task<Void, Never>?

  init(model: DistributorModel) {
    self.model = model
    self.adapter = APIAdapter(model: model)
  }

  static var port: UInt16 {
    let arguments = ProcessInfo.processInfo.arguments
    guard let flag = arguments.firstIndex(of: "-apiPort"), arguments.indices.contains(flag + 1),
          let port = UInt16(arguments[flag + 1])
    else { return DistributorAPI.port }
    return port
  }

  func start() async {
    guard server == nil else { return }
    let router = DistributorAPI.router(actions: adapter, events: adapter.events)
    let server = LinkServer(port: Self.port) { await router.handle($0) }
    do {
      let port = try await server.start()
      self.server = server
      NSLog("TS Distributor API on http://127.0.0.1:%d/api/v1", Int(port))
      let adapter = self.adapter
      publishing = Task { await adapter.publishChanges() }
    } catch {
      model.problem = "The API could not listen on 127.0.0.1:\(Self.port): \(error)"
    }
  }
}
