import Foundation
import DirectorRTSP
import Testing

@Suite("RTSP authentication")
struct RTSPDigestAuthTests {
  @Test("A digest challenge is taken apart into its parameters")
  func digestChallengeParses() throws {
    let challenge = try #require(RTSPAuthChallenge.parse(
      #"Digest realm="Hamedal", nonce="1a2b3c", opaque="xyz", algorithm=MD5"#
    ))

    #expect(challenge.scheme == .digest)
    #expect(challenge.realm == "Hamedal")
    #expect(challenge.nonce == "1a2b3c")
    #expect(challenge.opaque == "xyz")
    #expect(challenge.algorithm == "MD5")
  }

  @Test("A comma inside a quoted realm is not a parameter separator")
  func quotedCommaIsNotASeparator() throws {
    let challenge = try #require(RTSPAuthChallenge.parse(#"Digest realm="Camera, Front", nonce="n1""#))

    #expect(challenge.realm == "Camera, Front")
    #expect(challenge.nonce == "n1")
  }

  @Test("Basic is recognised as well, since a camera may offer only that")
  func basicChallengeParses() throws {
    let challenge = try #require(RTSPAuthChallenge.parse(#"Basic realm="Hamedal""#))

    #expect(challenge.scheme == .basic)
    #expect(challenge.realm == "Hamedal")
  }

  @Test("An unknown scheme is refused rather than attempted")
  func unknownSchemeIsRejected() {
    #expect(RTSPAuthChallenge.parse(#"Bearer realm="x""#) == nil)
  }

  /// The RFC 2617 §3.5 worked example, so the arithmetic is checked against the specification
  /// rather than against this implementation's own output.
  @Test("The digest response matches the RFC 2617 vector")
  func rfc2617Vector() {
    let challenge = RTSPAuthChallenge(
      scheme: .digest,
      realm: "testrealm@host.com",
      nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093"
    )

    let header = RTSPAuthorization.header(
      for: challenge,
      method: .options,
      uri: "/dir/index.html",
      username: "Mufasa",
      password: "Circle Of Life"
    )

    // Computed outside this code base from the RFC's credentials, whose HA1 the RFC publishes as
    // 939e7578ed9e3c518a452acee763bce9, with HA2 taken over OPTIONS rather than the RFC's GET.
    #expect(header.contains("response=\"218416e71227d5f8e51c429c248b7d62\""))
    #expect(header.hasPrefix("Digest "))
    #expect(header.contains("username=\"Mufasa\""))
    #expect(header.contains("uri=\"/dir/index.html\""))
  }

  @Test("A qop challenge gets the counter and client nonce it requires")
  func qopAuthIncludesCounterAndClientNonce() {
    let challenge = RTSPAuthChallenge(
      scheme: .digest,
      realm: "r",
      nonce: "n",
      qop: "auth"
    )

    let header = RTSPAuthorization.header(
      for: challenge,
      method: .describe,
      uri: "rtsp://host/live",
      username: "admin",
      password: "secret",
      clientNonce: "cnonce1",
      nonceCount: 1
    )

    #expect(header.contains("qop=auth"))
    #expect(header.contains("nc=00000001"))
    #expect(header.contains("cnonce=\"cnonce1\""))

    #expect(header.contains("response=\"1eb347245d5c52812075c06cd4e7d961\""))
  }

  @Test("Basic sends the credentials the way the scheme defines")
  func basicHeaderIsBase64() {
    let header = RTSPAuthorization.header(
      for: RTSPAuthChallenge(scheme: .basic, realm: "r"),
      method: .options,
      uri: "rtsp://host",
      username: "admin",
      password: "secret"
    )

    #expect(header == "Basic " + Data("admin:secret".utf8).base64EncodedString())
  }
}
