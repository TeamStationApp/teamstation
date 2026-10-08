#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>
#import <UIKit/UIKit.h>

@interface RCTHaptics : NativeHapticsSpecBase <NativeHapticsSpec>
@end

@implementation RCTHaptics
RCT_EXPORT_MODULE(TSHaptics)

RCT_EXPORT_METHOD(light:(double)viewTag)
{
  (void)viewTag;
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *controller = nil;
    id<UIApplicationDelegate> delegate = UIApplication.sharedApplication.delegate;
    if ([delegate respondsToSelector:@selector(window)]) {
      controller = delegate.window.rootViewController;
    }
    while (controller.presentedViewController != nil) {
      controller = controller.presentedViewController;
    }
    UIView *view = controller.view;
    UIImpactFeedbackGenerator *generator = nil;
    if (@available(iOS 17.5, *)) {
      if (view != nil) {
        generator = [UIImpactFeedbackGenerator feedbackGeneratorWithStyle:UIImpactFeedbackStyleLight forView:view];
      }
    }
    if (generator == nil) {
      generator = [[UIImpactFeedbackGenerator alloc] initWithStyle:UIImpactFeedbackStyleLight];
    }
    [generator prepare];
    [generator impactOccurred];
#if DEBUG
    NSLog(@"TSHaptics light request");
#endif
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeHapticsSpecJSI>(params);
}
@end
