import Testing
@testable import CameramanCore

@Suite("Saved sign-in recovery presentation")
struct LoginRecoveryTests {
  @Test func storageFailureReturnsToTheAddressAndKeepsItsExplanation() {
    var flow = LoginFlow()
    flow.email = "one@example.test"
    flow.codeSent()
    flow.replaceCode("123456")
    let message = "Could not save your sign-in on this device. Please sign in again."
    flow.restartSignIn(after: message)
    #expect(flow.step == .email)
    #expect(flow.email == "one@example.test")
    #expect(flow.code.isEmpty)
    #expect(flow.notice == message)
    #expect(flow.buttonLabel == LoginFlow.sendLabel)
    #expect(!flow.fieldIsCode)
    flow.codeSent()
    #expect(flow.fieldIsCode)
    #expect(flow.notice == LoginFlow.checkEmail)
  }
}
