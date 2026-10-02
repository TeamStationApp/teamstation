import CameramanCore
import Testing

@Suite("Login modal")
struct LoginFlowTests {
  @Test
  func theFieldStartsAsTheAddressAndBecomesTheCode() {
    var flow = LoginFlow()
    #expect(flow.step == .email)
    #expect(flow.buttonLabel == "Email sign-in code")
    #expect(flow.fieldIsCode == false)
    flow.codeSent()
    #expect(flow.step == .code)
    #expect(flow.notice == "Check your email")
    #expect(flow.buttonLabel == "Sign in")
    #expect(flow.fieldIsCode)
    #expect(flow.code == "")
  }

  @Test
  func theSixthDigitSubmitsAndFiveDoNot() {
    var flow = LoginFlow()
    flow.codeSent()
    let five = flow.replaceCode("12345")
    #expect(five == false)
    #expect(flow.code == "12345")
    let six = flow.replaceCode("123456")
    #expect(six == true)
    #expect(flow.code == "123456")
    let again = flow.replaceCode("123456")
    #expect(again == false)
    let trimmed = flow.replaceCode("12a34b56c789")
    #expect(trimmed == false)
    #expect(flow.code == "123456")
  }

  @Test
  func aRejectedCodeStaysOnTheCodeStep() {
    var flow = LoginFlow()
    flow.codeSent()
    _ = flow.replaceCode("000000")
    flow.codeRejected()
    #expect(flow.step == .code)
    #expect(flow.notice == "That code is wrong or has expired")
    #expect(flow.code == "")
    #expect(flow.buttonLabel == "Sign in")
  }

  @Test
  func cancelReturnsToTheAddress() {
    var flow = LoginFlow()
    flow.email = "paul@vtex.net"
    flow.codeSent()
    flow.cancel()
    #expect(flow.step == .email)
    #expect(flow.code == "")
    #expect(flow.notice == nil)
    #expect(flow.email == "paul@vtex.net")
    #expect(flow.buttonLabel == "Email sign-in code")
  }

  @Test
  func logoutArmsFromTheRightSideAndOnlyASlideConfirms() {
    var flow = LoginFlow()
    flow.armLogout()
    #expect(flow.logoutArmed)
    flow.tapElsewhere()
    #expect(flow.logoutArmed)
    flow.tapElsewhere()
    #expect(flow.logoutArmed == false)
    flow.armLogout()
    _ = flow.tapElsewhere()
    let short = flow.slide(progress: 0.79)
    #expect(short == false)
    #expect(flow.logoutArmed)
    let done = flow.slide(progress: 0.8)
    #expect(done == true)
    #expect(flow.logoutArmed == false)
    var idle = LoginFlow()
    let ignored = idle.slide(progress: 1)
    #expect(ignored == false)
  }

  @Test
  func aDevelopmentHostIsTextAndProductionIsNot() {
    #expect(LoginFlow.showsDevelopmentHost("") == false)
    #expect(LoginFlow.showsDevelopmentHost("app.teamstation.app") == false)
    #expect(LoginFlow.showsDevelopmentHost("https://app.teamstation.app") == false)
    #expect(LoginFlow.showsDevelopmentHost("devhost3.example-ts.test"))
    #expect(LoginFlow.loggedInLine("paul@vtex.net") == "paul@vtex.net currently logged in")
  }
}
