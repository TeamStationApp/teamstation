import CameramanCore
import Foundation

/// Director's sign-in modal uses Cameraman's flow, so the two apps cannot
/// disagree about when a code submits or a slide signs out.
public enum DirectorLogin {
  public static func fresh() -> LoginFlow { LoginFlow() }
}
