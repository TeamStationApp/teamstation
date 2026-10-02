import CameramanCore
import Testing

@testable import DirectorUI

@Suite("Director login modal")
struct DirectorLoginFlowTests {
  @Test
  func directorStartsFromTheSharedFlow() {
    var flow = DirectorLogin.fresh()
    #expect(flow.buttonLabel == LoginFlow.sendLabel)
    let five = flow.replaceCode("12345")
    #expect(five == false)
    flow.codeSent()
    let six = flow.replaceCode("123456")
    #expect(six)
    #expect(flow.notice == LoginFlow.checkEmail)
    flow.codeRejected()
    #expect(flow.notice == LoginFlow.badCode)
    flow.armLogout()
    flow.tapElsewhere()
    let slid = flow.slide(progress: 0.8)
    #expect(slid)
  }
}
