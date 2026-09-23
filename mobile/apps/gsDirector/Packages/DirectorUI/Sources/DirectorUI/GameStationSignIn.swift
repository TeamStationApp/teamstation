import CameramanCore
import GameStationKit
import SwiftUI

/// The centered sign-in modal. One field and one pill: the address, then the code.
struct GameStationSignIn: View {
  @Environment(AppEnvironment.self) private var environment
  let onClose: () -> Void
  @State private var login = LoginFlow()
  @State private var busy = false
  @FocusState private var focused: Bool

  private let poll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()
  private let pill = Color(red: 0.50, green: 0.85, blue: 0.61)
  private let ink = Color(red: 0.07, green: 0.14, blue: 0.09)

  var body: some View {
    GeometryReader { geo in
      ZStack {
        Color.black.opacity(0.92).ignoresSafeArea()
        VStack(spacing: 20) {
          Text("GameStation")
            .font(.largeTitle.weight(.bold))
            .foregroundStyle(pill)
            .accessibilityIdentifier("gamestation-logo")
          if LoginFlow.showsDevelopmentHost(AppServer.url.absoluteString) {
            Text(AppServer.url.absoluteString)
              .font(.footnote)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("gamestation-account-host")
          }
          if let notice = login.notice {
            Text(notice)
              .font(.subheadline)
              .foregroundStyle(.secondary)
              .accessibilityIdentifier("gamestation-notice")
          }
          field
            .frame(width: geo.size.width / 2)
          Button(login.buttonLabel) {
            if login.fieldIsCode {
              submit()
            } else {
              start()
            }
          }
          .buttonStyle(.plain)
          .font(.body.weight(.semibold))
          .foregroundStyle(ink)
          .padding(.horizontal, 18)
          .padding(.vertical, 10)
          .background(pill, in: Capsule())
          .disabled(busy || (login.fieldIsCode ? login.code.count < 6 : !login.email.contains("@")))
          .accessibilityIdentifier(login.fieldIsCode ? "gamestation-submit-code" : "gamestation-send-code")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .overlay(alignment: .topTrailing) {
        Button("Cancel") {
          login.cancel()
          onClose()
        }
        .font(.body.weight(.semibold))
        .foregroundStyle(.red)
        .padding()
        .accessibilityIdentifier("gamestation-sign-in-done")
      }
    }
    .onAppear { focused = true }
    .onChange(of: login.step) { _, _ in focused = true }
    .onChange(of: environment.gameStation.isSignedIn) { _, signedIn in
      if signedIn { onClose() }
    }
    .onReceive(poll) { _ in
      guard environment.gameStation.user == nil, environment.gameStation.waiting != nil else { return }
      Task { await environment.gameStation.pollSignIn() }
    }
  }

  private var field: some View {
    Group {
      if login.fieldIsCode {
        TextField(
          "123456",
          text: Binding(
            get: { login.code },
            set: { raw in
              // The binding's set runs before `code` changes. `onChange`
              // would see the digits already stored and never submit.
              if login.replaceCode(raw) { submit() }
            }
          )
        )
        .keyboardType(.numberPad)
        .accessibilityIdentifier("gamestation-code")
      } else {
        TextField("email", text: $login.email)
          .keyboardType(.emailAddress)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .accessibilityIdentifier("gamestation-email")
      }
    }
    .multilineTextAlignment(.center)
    .focused($focused)
    .padding(.vertical, 12)
    .padding(.horizontal, 8)
    .background(Color.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
  }

  private func start() {
    busy = true
    let address = login.email.trimmingCharacters(in: .whitespaces).lowercased()
    login.email = address
    Task {
      do {
        try await environment.gameStation.startSignIn(email: address)
        login.codeSent()
      } catch {
        login.notice = error.localizedDescription
      }
      busy = false
    }
  }

  private func submit() {
    guard !busy else { return }
    busy = true
    let address = login.email
    let code = login.code
    Task {
      do {
        try await environment.gameStation.completeSignIn(email: address, code: code)
      } catch {
        login.codeRejected()
        login.notice = LoginFlow.badCode
      }
      busy = false
    }
  }
}
