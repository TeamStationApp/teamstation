import DirectorLink
import Foundation
import Testing

@Suite("Export lease")
struct ExportLeaseTests {
  @Test("A lease renewed in time is kept; one left unrenewed past the timeout is dropped")
  func expiry() {
    let start = Date(timeIntervalSince1970: 1_000)
    var lease = ExportLease()
    let id = lease.grant(now: start)
    #expect(lease.isHeld)

    let expiredEarly = lease.expire(now: start.addingTimeInterval(ExportLease.timeout - 1))
    #expect(!expiredEarly)
    let renewed = lease.renew(id, now: start.addingTimeInterval(20))
    #expect(renewed)
    let expiredAfterRenewal = lease.expire(now: start.addingTimeInterval(45))
    #expect(!expiredAfterRenewal)
    let expiredLate = lease.expire(now: start.addingTimeInterval(20 + ExportLease.timeout + 1))
    #expect(expiredLate)
    #expect(!lease.isHeld)
    let renewedAfterExpiry = lease.renew(id, now: start.addingTimeInterval(60))
    #expect(!renewedAfterExpiry)
  }

  @Test("Only the lease held can be renewed or handed back, and a new grant replaces the old")
  func identity() {
    var lease = ExportLease()
    let first = lease.grant()
    let second = lease.grant()
    let renewedFirst = lease.renew(first)
    #expect(!renewedFirst)
    lease.release(first)
    #expect(lease.id == second)
    lease.release(second)
    #expect(!lease.isHeld)
  }
}
