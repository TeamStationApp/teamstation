#import <objc/runtime.h>
#import <React/RCTUtils.h>
#import <SafariServices/SafariServices.h>
#import <TeamStationWalkUpMusicSpec/TeamStationWalkUpMusicSpec.h>

// UIKit owns the Safari controller. Its associated delegate keeps the promise
// alive until dismissal, including when a parent dismisses the sheet in code.
@interface ChatBrowserSession : NSObject <SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate>
@property (nonatomic, copy) RCTPromiseResolveBlock onDismiss;
@end

@implementation ChatBrowserSession
- (void)finish
{
  if (_onDismiss == nil) return;
  _onDismiss(nil);
  _onDismiss = nil;
}
- (void)safariViewControllerDidFinish:(SFSafariViewController *)controller
{
  [controller dismissViewControllerAnimated:YES completion:^{ [self finish]; }];
}
- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController
{
  [self finish];
}
- (void)dealloc
{
  if (_onDismiss != nil) _onDismiss(nil);
}
@end

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
    [self presentURL:url from:RCTPresentedViewController() resolve:resolve reject:reject];
  });
}

- (void)presentURL:(NSURL *)url from:(UIViewController *)presenter
           resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  UIWindow *window = presenter.viewIfLoaded.window;
  if (window.windowScene == nil || window.windowScene.activationState != UISceneActivationStateForegroundActive ||
      presenter.isBeingDismissed || presenter.isBeingPresented || presenter.transitionCoordinator != nil ||
      presenter.presentedViewController != nil || [presenter isKindOfClass:[SFSafariViewController class]]) {
    reject(@"browser_unavailable", @"A browser cannot be presented now", nil);
    return;
  }
  SFSafariViewController *browser = [[SFSafariViewController alloc] initWithURL:url];
  ChatBrowserSession *session = [ChatBrowserSession new];
  browser.delegate = session;
  [presenter presentViewController:browser animated:YES completion:nil];
  if (presenter.presentedViewController != browser) {
    reject(@"browser_unavailable", @"The browser could not be opened", nil);
    return;
  }
  session.onDismiss = resolve;
  browser.presentationController.delegate = session;
  objc_setAssociatedObject(browser, @selector(presentURL:from:resolve:reject:), session, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeChatBrowserSpecJSI>(params);
}
@end
