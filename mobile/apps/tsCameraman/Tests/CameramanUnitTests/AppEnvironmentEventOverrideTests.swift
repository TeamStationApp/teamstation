import CameramanCore
@testable import CameramanUI
@testable import EventControl
import Foundation
import Testing

private typealias F = EventOverrideFixture

@Suite("Director override in the app", .serialized)
@MainActor
struct AppEnvironmentEventOverrideTests {
  @Test
  func theForegroundBindsTheListenerAgainAndTheRadarIsLeftAlone() async {
    let radarKey = "app.teamstation.cameraman.radar.enabled"
    let radarBefore = UserDefaults.standard.object(forKey: radarKey)
    defer { UserDefaults.standard.set(radarBefore, forKey: radarKey) }
    let port = F.port()
    let sockets = FakeScoreboardSockets()
    let environment = AppEnvironment(
      broadcastStore: F.store(gameId: F.gameA),
      eventControlKeys: .inMemory(),
      eventControlPorts: [ port ],
      eventControlRebindDelay: 60,
      scoreboardHTTP: AccountServerStub.signedIn().http,
      scoreboardSockets: sockets.opener
    )
    defer { environment.eventOverride.listener.stop() }
    // Radar sending off before the assignment, and it stays off.
    environment.radarFleet.setEnabled(false)
    environment.eventOverride.start()
    environment.setAllowDirectorOverride(true)
    await environment.eventOverride.settle()
    #expect(environment.scoreboard.allowDirectorOverride)
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })

    // iOS takes the listener away in the background; the foreground puts it back on the same port.
    environment.eventOverride.listener.cancelAsTheSystemWould()
    #expect(await eventually { environment.eventOverride.listenerState == .binding })
    environment.handleForeground()
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })

    // A Director's event over real TCP, as the sweep would reach it.
    let director = EventControlDirectorLink(
      endpoint: EventControlEndpoint(host: "127.0.0.1", port: port),
      instanceId: EventControlInstanceID(hex: "000000000000000000000000000000d1")!,
      credentials: EventKeys.credentials(EventKeys.one),
      desired: EventControlDesired(revision: 100, assignment: F.assignmentB),
      connector: EventControlNWConnector(),
      timing: F.fast,
      onUpdate: { _ in }
    )
    await director.start()
    #expect(await eventually { environment.scoreboard.eventLocked })
    #expect(environment.scoreboard.overrideLine == "Override from Director 127.0.0.1")
    #expect(UserDefaults.standard.object(forKey: radarKey) as? Bool == false)
    #expect(sockets.opened.isEmpty, "an assignment alone publishes nothing")

    // A reading handed in as the radar would, stamped as it arrives, goes to B.
    environment.radarFleet.onSpeeds?("ADFA0000001", 83, 0)
    #expect(await eventually { sockets.sent(to: F.urlB) == [ "{\"pitchSpeed\":83}" ] })
    await director.stop()
    #expect(await eventually { !environment.scoreboard.eventLocked })
  }

  @Test
  func lockingAndUnlockingRebindsTheListenerLikeBackgroundingAndTheDirectorReassigns() async {
    let port = F.port()
    let sockets = FakeScoreboardSockets()
    let environment = AppEnvironment(
      broadcastStore: F.store(gameId: F.gameA),
      eventControlKeys: .inMemory(),
      eventControlPorts: [ port ],
      eventControlRebindDelay: 60,
      scoreboardHTTP: AccountServerStub.signedIn().http,
      scoreboardSockets: sockets.opener
    )
    defer { environment.eventOverride.listener.stop() }
    environment.eventOverride.start()
    environment.setAllowDirectorOverride(true)
    await environment.eventOverride.settle()
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })

    func director() -> EventControlDirectorLink {
      EventControlDirectorLink(
        endpoint: EventControlEndpoint(host: "127.0.0.1", port: port),
        instanceId: EventControlInstanceID(hex: "000000000000000000000000000000d1")!,
        credentials: EventKeys.credentials(EventKeys.one),
        desired: EventControlDesired(revision: 100, assignment: F.assignmentB),
        connector: EventControlNWConnector(),
        timing: F.fast,
        onUpdate: { _ in }
      )
    }
    let before = director()
    await before.start()
    #expect(await eventually { environment.scoreboard.eventLocked })

    // The side button: the scene goes inactive, then to the background, and while the phone is
    // locked iOS cancels the listener. The lease goes with it, as after a restart.
    environment.handleScenePhase(.inactive)
    environment.handleScenePhase(.background)
    environment.eventOverride.listener.cancelAsTheSystemWould()
    #expect(await eventually { environment.eventOverride.listenerState == .binding })
    #expect(await eventually { !environment.scoreboard.eventLocked })
    await before.stop(release: false)

    // Unlocked: inactive first, which changes nothing, then active, which binds again at once
    // on the same port (the automatic rebind is a minute away here).
    environment.handleScenePhase(.inactive)
    #expect(environment.eventOverride.listenerState == .binding)
    environment.handleScenePhase(.active)
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })

    // Director's next contact at the remembered address assigns it again.
    let after = director()
    await after.start()
    #expect(await eventually { environment.scoreboard.eventLocked })
    #expect(environment.scoreboard.overrideLine == "Override from Director 127.0.0.1")
    await after.stop()
  }

  @Test
  func aListenerCancelledWhileLockedRebindsByItselfWithoutTheForeground() async {
    let port = F.port()
    let environment = AppEnvironment(
      broadcastStore: F.store(gameId: F.gameA),
      eventControlKeys: .inMemory(),
      eventControlPorts: [ port ],
      eventControlRebindDelay: 0.05,
      scoreboardHTTP: AccountServerStub.signedIn().http,
      scoreboardSockets: FakeScoreboardSockets().opener
    )
    defer { environment.eventOverride.listener.stop() }
    environment.eventOverride.start()
    environment.setAllowDirectorOverride(true)
    await environment.eventOverride.settle()
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })
    func director() -> EventControlDirectorLink {
      EventControlDirectorLink(
        endpoint: EventControlEndpoint(host: "127.0.0.1", port: port),
        instanceId: EventControlInstanceID(hex: "000000000000000000000000000000d1")!,
        credentials: EventKeys.credentials(EventKeys.one),
        desired: EventControlDesired(revision: 100, assignment: F.assignmentB),
        connector: EventControlNWConnector(),
        timing: F.fast,
        onUpdate: { _ in }
      )
    }
    let before = director()
    await before.start()
    #expect(await eventually { environment.scoreboard.eventLocked })
    environment.handleScenePhase(.background)
    environment.eventOverride.listener.cancelAsTheSystemWould()
    // The cancel took the lease with it ...
    #expect(await eventually { !environment.scoreboard.eventLocked })
    await before.stop(release: false)
    // ... and the `.cancelled`-while-current rebind puts the listener back on the same port with no
    // foreground at all, where the next contact assigns again.
    #expect(await eventually { environment.eventOverride.listenerState == .listening(port: port) })
    let after = director()
    await after.start()
    #expect(await eventually { environment.scoreboard.eventLocked })
    await after.stop()
  }
}
