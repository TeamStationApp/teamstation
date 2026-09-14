import DistributorWire
import Foundation
import PeerTubeKit

/// Hands an upload its PeerTube access token: the one it already holds while that has five
/// minutes left, else a fresh one from GS Director. A token PeerTube still honours is kept when GS
/// Director goes away, so an upload does not stop because the iPad locked or GS Director went to
/// the background. GS Director can hand over a fresh one only while it is connected; while it is
/// away, one is waited for, up to `patience`, rather than failing an upload with hours to go.
public actor UploadTokenSource {
  public struct DirectorAway: Error, CustomStringConvertible {
    public var description: String {
      "GS Director was away too long to hand over a fresh PeerTube token; open GS Director on the iPad and upload again"
    }
  }

  private var held: PeerTubeToken?
  private let patience: Duration
  private let poll: Duration
  private let isConnected: @Sendable () async -> Bool
  private let fetch: @Sendable () async throws -> PeerTubeToken

  public init(
    held: PeerTubeToken?,
    patience: Duration = .seconds(600),
    poll: Duration = .seconds(2),
    isConnected: @escaping @Sendable () async -> Bool,
    fetch: @escaping @Sendable () async throws -> PeerTubeToken
  ) {
    self.held = held
    self.patience = patience
    self.poll = poll
    self.isConnected = isConnected
    self.fetch = fetch
  }

  public func accessToken() async throws -> String {
    if let held, held.expiresAt.timeIntervalSinceNow > 300 { return held.accessToken }
    let clock = ContinuousClock()
    let deadline = clock.now + patience
    while true {
      if await isConnected() {
        do {
          let token = try await fetch()
          held = token
          return token.accessToken
        } catch PeerTubeError.signInAgain {
          // GS Director says the account is gone: waiting will not bring it back.
          throw PeerTubeError.signInAgain
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          // A request that failed on the way is tried again while patience lasts.
          guard clock.now < deadline else { throw error }
        }
      } else {
        guard clock.now < deadline else { throw DirectorAway() }
      }
      try await Task.sleep(for: poll)
    }
  }
}
