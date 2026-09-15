import Foundation
import LoopbackHTTP
import Testing

@Suite("Router")
struct RouterTests {
  struct Echo: Codable, Equatable {
    var id: String
    var method: String
  }

  static func router() -> Router {
    var router = Router()
    router.add("GET", "/api/v1/recordings/{id}", summary: "one recording") { request, parameters in
      .apiJSON(Echo(id: "\(try parameters.int64("id"))", method: request.method))
    }
    router.add("DELETE", "/api/v1/recordings/{id}") { request, parameters in
      .apiJSON(Echo(id: parameters["id"] ?? "", method: request.method))
    }
    router.add("POST", "/api/v1/echo") { request, _ in
      .apiJSON(try request.decode(Echo.self))
    }
    router.add("GET", "/api/v1/fails") { _, _ in
      throw HTTPError(412, "iPadNotAttached", "connect the iPad")
    }
    return router
  }

  static func body(_ response: HTTPResponse) throws -> (status: Int, json: [String: String]) {
    guard case let .data(status, _, body) = response else { throw HTTPError(0, "", "not data") }
    return (status, try JSONDecoder().decode([String: String].self, from: body))
  }

  @Test("A pattern's {name} segments reach the handler, and the method picks the route")
  func matches() async throws {
    let router = Self.router()
    let get = try Self.body(await router.handle(HTTPRequest(method: "GET", path: "/api/v1/recordings/42")))
    #expect(get.status == 200)
    #expect(get.json == [ "id": "42", "method": "GET" ])
    let delete = try Self.body(await router.handle(HTTPRequest(method: "DELETE", path: "/api/v1/recordings/7/")))
    #expect(delete.json == [ "id": "7", "method": "DELETE" ])
  }

  @Test("An unknown path is 404, a known path with the wrong method 405, a bad number 400")
  func failures() async throws {
    let router = Self.router()
    let missing = try Self.body(await router.handle(HTTPRequest(method: "GET", path: "/api/v1/nothing")))
    #expect(missing.status == 404)
    #expect(missing.json["error"] == "notFound")
    let wrongMethod = try Self.body(await router.handle(HTTPRequest(method: "PUT", path: "/api/v1/recordings/1")))
    #expect(wrongMethod.status == 405)
    let notNumber = try Self.body(await router.handle(HTTPRequest(method: "GET", path: "/api/v1/recordings/abc")))
    #expect(notNumber.status == 400)
    #expect(notNumber.json["message"] == "id must be a whole number")
  }

  @Test("A thrown HTTPError keeps its status and code")
  func thrownError() async throws {
    let answer = try Self.body(await Self.router().handle(HTTPRequest(method: "GET", path: "/api/v1/fails")))
    #expect(answer.status == 412)
    #expect(answer.json == [ "error": "iPadNotAttached", "message": "connect the iPad" ])
  }

  @Test("A JSON body decodes, and one that does not names what is missing")
  func bodies() async throws {
    let router = Self.router()
    let good = try Self.body(await router.handle(HTTPRequest(
      method: "POST",
      path: "/api/v1/echo",
      body: Data(#"{"id":"x","method":"m"}"#.utf8)
    )))
    #expect(good.json == [ "id": "x", "method": "m" ])
    let bad = try Self.body(await router.handle(HTTPRequest(
      method: "POST",
      path: "/api/v1/echo",
      body: Data(#"{"id":"x"}"#.utf8)
    )))
    #expect(bad.status == 400)
    #expect(bad.json["message"]?.contains("method is missing") == true)
  }

  @Test("The routes are listed in the order they were added, with their summaries")
  func listing() {
    let routes = Self.router().routes
    #expect(routes.map(\.pattern).first == "/api/v1/recordings/{id}")
    #expect(routes.first?.summary == "one recording")
    #expect(routes.count == 4)
  }
}
