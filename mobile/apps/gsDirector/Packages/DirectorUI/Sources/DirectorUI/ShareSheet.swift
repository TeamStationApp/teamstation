import SwiftUI
import UIKit

/// System share sheet so assembled recordings can go out over AirDrop.
struct ShareSheet: UIViewControllerRepresentable {
  let urls: [URL]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: urls, applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
