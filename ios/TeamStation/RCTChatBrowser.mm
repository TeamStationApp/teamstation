#import <React/RCTUtils.h>
#import <SafariServices/SafariServices.h>
#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

@interface RCTChatBrowser : NativeChatBrowserSpecBase <NativeChatBrowserSpec>
@end

@implementation RCTChatBrowser
RCT_EXPORT_MODULE(TSChatBrowser)

RCT_EXPORT_METHOD(open:(NSString *)address
                  resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSURLComponents *parts = [NSURLComponents componentsWithString:address];
  NSString *scheme = parts.scheme.lowercaseString;
  NSURL *url = parts.URL;
  if (url == nil || parts.host.length == 0 || parts.user != nil || parts.password != nil ||
      (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"])) {
    reject(@"invalid_url", @"Expected a web address", nil);
    return;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = RCTPresentedViewController();
    if (presenter.viewIfLoaded.window.windowScene.activationState != UISceneActivationStateForegroundActive ||
        presenter.viewIfLoaded.window == nil || presenter.isBeingDismissed || presenter.isBeingPresented ||
        presenter.presentedViewController != nil || [presenter isKindOfClass:[SFSafariViewController class]]) {
      reject(@"browser_unavailable", @"A browser cannot be presented now", nil);
      return;
    }
    SFSafariViewController *browser = [[SFSafariViewController alloc] initWithURL:url];
    [presenter presentViewController:browser animated:YES completion:nil];
    if (presenter.presentedViewController == browser) {
      resolve(nil);
    } else {
      reject(@"browser_unavailable", @"The browser could not be opened", nil);
    }
  });
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeChatBrowserSpecJSI>(params);
}
@end
