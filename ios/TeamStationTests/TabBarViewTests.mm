#import <React/RCTViewComponentView.h>
#import <React/RCTConversions.h>
#import <UIKit/UIKit.h>
#import <XCTest/XCTest.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/EventEmitters.h>
#import <react/renderer/components/TeamStationWalkUpMusicSpec/Props.h>

#include <hermes/hermes.h>
#include <react/renderer/core/EventDispatcher.h>
#include <react/renderer/runtimescheduler/RuntimeScheduler.h>

using namespace facebook::react;

static NSArray<UIView *> *ControlsNamed(UIView *root, NSString *label)
{
  NSMutableArray *matches = [NSMutableArray array];
  for (UIView *view in root.subviews) {
    if ([view isKindOfClass:UIControl.class] && [view.accessibilityLabel isEqualToString:label])
      [matches addObject:view];
    [matches addObjectsFromArray:ControlsNamed(view, label)];
  }
  return matches;
}

// Find the platter by its content, without depending on a private UIKit class.
static NSUInteger ControlCount(UIView *view)
{
  NSUInteger count = [view isKindOfClass:UIControl.class] ? 1 : 0;
  for (UIView *child in view.subviews) count += ControlCount(child);
  return count;
}

// UIKit draws each item's button and, behind the selected one, its
// highlight: a view that is not a control and contains none.
static NSArray<UIView *> *Decorations(UIView *view)
{
  NSMutableArray *found = [NSMutableArray array];
  for (UIView *child in view.subviews) {
    if (ControlCount(child) > 0) {
      if (![child isKindOfClass:UIControl.class]) [found addObjectsFromArray:Decorations(child)];
    } else {
      [found addObject:child];
      [found addObjectsFromArray:Decorations(child)];
    }
  }
  return found;
}

@interface TabBarViewTests : XCTestCase
@end

@implementation TabBarViewTests

- (void)testThemeAndSelectionAreControlledByReact
{
  RCTViewComponentView *host = [[NSClassFromString(@"TSTabBarComponentView") alloc]
      initWithFrame:CGRectMake(0, 0, 393, 83)];
  XCTAssertNotNil(host);
  (void)[NSClassFromString(@"TSTabBarComponentView") componentDescriptorProvider];
  UITabBar *bar = (UITabBar *)host.subviews.firstObject;
  XCTAssertTrue([bar isKindOfClass:UITabBar.class]);

  auto props = std::make_shared<TSTabBarProps>();
  props->items = {
      {.id = "home", .title = "Home", .symbol = "house", .selectedSymbol = "house.fill", .testID = "tab-home"},
      {.id = "chat", .title = "Chat", .symbol = "bubble.left", .selectedSymbol = "bubble.left.fill",
       .badge = true, .testID = "tab-chat"}};
  props->selectedId = "home";
  auto runtime = facebook::hermes::makeHermesRuntime();
  RuntimeScheduler scheduler([&](auto &&callback) { callback(*runtime); });
  auto dispatcher = std::make_shared<EventDispatcher>(
      EventQueueProcessor(nullptr, nullptr, nullptr, {}),
      std::make_unique<EventBeat>(std::make_shared<EventBeat::OwnerBox>(), scheduler), nullptr,
      std::weak_ptr<EventLogger>{});
  NSMutableArray<NSString *> *requested = [NSMutableArray array];
  dispatcher->addListener(std::make_shared<const EventListener>([&](const RawEvent &event) {
    if (event.type == "topSelectTab") {
      auto payload = event.eventPayload->asJSIValue(*runtime).asObject(*runtime);
      auto id = payload.getProperty(*runtime, "id").asString(*runtime).utf8(*runtime);
      [requested addObject:@(id.c_str())];
    }
    return true;
  }));
  [host updateEventEmitter:std::make_shared<TSTabBarEventEmitter>(nullptr, dispatcher)];
  UIView *darkParent = [UIView new];
  darkParent.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
  [darkParent addSubview:host];
  [host updateProps:props oldProps:nullptr];
  [host layoutIfNeeded];

  XCTAssertEqual(host.overrideUserInterfaceStyle, UIUserInterfaceStyleLight);
  XCTAssertEqual(bar.traitCollection.userInterfaceStyle, UIUserInterfaceStyleLight);
  XCTAssertEqualObjects(bar.selectedItem.accessibilityIdentifier, @"tab-home");
  UITabBarItem *chat = bar.items[1];
  XCTAssertEqualObjects(chat.title, @"Chat");
  XCTAssertEqualObjects(chat.accessibilityLabel, @"Chat");
  XCTAssertEqualObjects(chat.badgeValue, @"");
  XCTAssertNotNil(chat.image);
  XCTAssertNotNil(chat.selectedImage);
  UIImageRenderingMode glassMode = chat.image.renderingMode;
  UIImageRenderingMode selectedGlassMode = chat.selectedImage.renderingMode;
  XCTAssertNotEqual(glassMode, UIImageRenderingModeAlwaysOriginal);
  XCTAssertEqualWithAccuracy(CGRectGetMaxY(bar.frame), CGRectGetHeight(host.bounds), 0.5);

  XCTAssertEqual(requested.count, 0U);
  // UIKit moves before calling its delegate. React can refuse the request
  // without sending any props, or confirm a later request asynchronously.
  bar.selectedItem = chat;
  [bar.delegate tabBar:bar didSelectItem:chat];
  XCTAssertEqualObjects(requested, (@[@"chat"]));
  XCTAssertEqualObjects(bar.selectedItem.accessibilityIdentifier, @"tab-home");
  [host layoutIfNeeded];
  bar.selectedItem = chat;
  [bar.delegate tabBar:bar didSelectItem:chat];
  XCTAssertEqualObjects(requested, (@[@"chat", @"chat"]));
  XCTAssertEqualObjects(bar.selectedItem.accessibilityIdentifier, @"tab-home");

  auto committed = std::make_shared<TSTabBarProps>();
  committed->items = props->items;
  committed->selectedId = "chat";
  committed->dark = true;
  committed->compact = true;
  committed->items[1].badge = false;
  committed->opaqueBackgroundColor = colorFromComponents({1, 1, 1, 1});
  [host updateProps:committed oldProps:props];
  XCTAssertTrue(CGColorEqualToColor(bar.standardAppearance.backgroundColor.CGColor, RCTUIColorFromSharedColor(committed->opaqueBackgroundColor).CGColor));
  XCTAssertEqual(chat.image.renderingMode, UIImageRenderingModeAlwaysOriginal);
  XCTAssertEqual(chat.selectedImage.renderingMode, UIImageRenderingModeAlwaysOriginal);
  XCTAssertEqual(bar.items[1], chat);
  XCTAssertEqual(bar.selectedItem, chat);
  XCTAssertEqualObjects(requested, (@[@"chat", @"chat"])); // Prop confirmation is silent.
  [bar.delegate tabBar:bar didSelectItem:chat];
  XCTAssertEqualObjects(requested, (@[@"chat", @"chat", @"chat"]));
  [bar.delegate tabBar:bar didSelectItem:bar.items.firstObject];
  XCTAssertEqualObjects(requested, (@[@"chat", @"chat", @"chat", @"home"]));
  XCTAssertEqual(bar.selectedItem, chat);
  XCTAssertEqual(host.overrideUserInterfaceStyle, UIUserInterfaceStyleDark);
  XCTAssertNil(chat.title);
  XCTAssertEqualObjects(chat.accessibilityLabel, @"Chat");
  XCTAssertNil(chat.badgeValue);
  [host updateProps:props oldProps:committed];
  XCTAssertEqual(bar.items[1], chat);
  XCTAssertEqual(chat.image.renderingMode, glassMode);
  XCTAssertEqual(chat.selectedImage.renderingMode, selectedGlassMode);
  XCTAssertEqualObjects(requested, (@[@"chat", @"chat", @"chat", @"home"]));
  [host prepareForRecycle];
  XCTAssertEqual(bar.items.count, 0U);
}
- (void)testSelectedHighlightMatchesCapsuleGeometry
{
  NSOperatingSystemVersion firstGlassRuntime = {26, 0, 0};
  XCTSkipUnless([NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:firstGlassRuntime],
                @"Liquid Glass tab bar geometry requires iOS 26 or later");
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) window = ((UIWindowScene *)scene).keyWindow;
    if (window) break;
  }
  XCTAssertNotNil(window);
  NSURL *url = [[NSBundle bundleForClass:self.class] URLForResource:@"tabBarDimensions" withExtension:@"json"];
  NSDictionary<NSString *, NSNumber *> *geometry = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:url] options:0 error:nil];
  CGFloat pad = geometry[@"NAV_PILL_PAD"].doubleValue;
  // tabBarModel.ts's highlightWidth, from the same constants.
  auto highlightWidth = [&](CGFloat platter) {
    CGFloat inner = platter - 2 * pad;
    CGFloat minimum = geometry[@"NAV_HIGHLIGHT_MIN_WIDTH"].doubleValue;
    BOOL roomy = (inner - minimum) / 4 >= geometry[@"NAV_HIGHLIGHT_ROOMY_STEP"].doubleValue;
    CGFloat overlap = geometry[roomy ? @"NAV_HIGHLIGHT_ROOMY_OVERLAP" : @"NAV_HIGHLIGHT_OVERLAP"].doubleValue;
    CGFloat width = (inner + 4 * overlap) / 5;
    return roomy ? MAX(minimum, width) : width;
  };
  for (NSNumber *screen in @[@360, @390, @393, @412, @430]) {
    for (NSNumber *compact in @[@NO, @YES]) {
      CGFloat width = screen.doubleValue;
      CGFloat height = geometry[@"NAV_NATIVE_HEIGHT_ABOVE_INSET"].doubleValue + window.safeAreaInsets.bottom;
      RCTViewComponentView *host = [[NSClassFromString(@"TSTabBarComponentView") alloc]
          initWithFrame:CGRectMake(0, CGRectGetHeight(window.bounds) - height, width, height)];
      [window addSubview:host];
      auto props = std::make_shared<TSTabBarProps>();
      props->selectedId = "schedule";
      props->compact = compact.boolValue;
      props->items = {
        {.id = "home", .title = "Home", .symbol = "house", .selectedSymbol = "house.fill", .testID = "tab-home"},
        {.id = "videos", .title = "Videos", .symbol = "play", .selectedSymbol = "play.fill", .testID = "tab-videos"},
        {.id = "schedule", .title = "Schedule", .symbol = "calendar", .selectedSymbol = "calendar", .testID = "tab-schedule"},
        {.id = "search", .title = "Search", .symbol = "magnifyingglass", .selectedSymbol = "magnifyingglass", .testID = "tab-search"},
        {.id = "chat", .title = "Chat", .symbol = "bubble.left", .selectedSymbol = "bubble.left.fill", .testID = "tab-chat"}
      };
      [host updateProps:props oldProps:nullptr];
      UITabBar *bar = (UITabBar *)host.subviews.firstObject;
      [host layoutIfNeeded];
      [bar layoutIfNeeded];
      UIView *platter = nil;
      for (UIView *child in bar.subviews)
        if (ControlCount(child) >= bar.items.count) platter = child;
      XCTAssertNotNil(platter);
      NSArray<UIView *> *buttons = nil;
      for (UIView *layer in platter.subviews) {
        NSMutableArray<UIView *> *row = [NSMutableArray array];
        for (UIView *child in layer.subviews)
          if ([child isKindOfClass:UIControl.class]) [row addObject:child];
        if (row.count == bar.items.count) buttons = row;
      }
      XCTAssertEqual(buttons.count, 5U);
      CGFloat sum = 0;
      for (UIView *button in buttons) sum += CGRectGetWidth(button.frame);
      NSString *where = [NSString stringWithFormat:@"%@ points%@", screen, compact.boolValue ? @" compact" : @""];
      CGFloat expected = highlightWidth(CGRectGetWidth(platter.bounds));
      XCTAssertEqualWithAccuracy(sum / 5, expected, 0.05, @"%@", where);
      XCTAssertEqualWithAccuracy(CGRectGetMinX(buttons.firstObject.frame), pad, 0.05, @"%@", where);
      XCTAssertEqualWithAccuracy(CGRectGetMaxX(buttons.lastObject.frame), CGRectGetWidth(platter.bounds) - pad, 0.05,
                                 @"%@", where);
      // Neighbours overlap: each reaches past the halfway point between tabs.
      XCTAssertGreaterThan(CGRectGetMaxX(buttons[0].frame), CGRectGetMinX(buttons[1].frame), @"%@", where);
      UIView *selected = buttons[2];
      CGRect selectedFrame = [selected convertRect:selected.bounds toView:platter];
      XCTAssertEqualWithAccuracy(CGRectGetHeight(selectedFrame), CGRectGetHeight(platter.bounds) - 2 * pad, 0.05,
                                 @"%@", where);
      BOOL highlighted = NO;
      for (UIView *decoration in Decorations(platter)) {
        CGRect frame = [decoration convertRect:decoration.bounds toView:platter];
        if (fabs(CGRectGetMinX(frame) - CGRectGetMinX(selectedFrame)) <= 0.5 &&
            fabs(CGRectGetWidth(frame) - CGRectGetWidth(selectedFrame)) <= 0.5 &&
            fabs(CGRectGetHeight(frame) - CGRectGetHeight(selectedFrame)) <= 0.5)
          highlighted = YES;
      }
      XCTAssertTrue(highlighted, @"No highlight under the selected button at %@", where);
      [host removeFromSuperview];
    }
  }
}
- (void)testRenderedExpandedAndCompactPlattersMatchCapsuleGeometry
{
  NSOperatingSystemVersion firstGlassRuntime = {26, 0, 0};
  XCTSkipUnless([NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:firstGlassRuntime],
                @"Liquid Glass tab bar geometry requires iOS 26 or later");
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if ([scene isKindOfClass:UIWindowScene.class]) window = ((UIWindowScene *)scene).keyWindow;
    if (window) break;
  }
  XCTAssertNotNil(window);
  NSURL *url = [[NSBundle bundleForClass:self.class] URLForResource:@"tabBarDimensions" withExtension:@"json"];
  XCTAssertNotNil(url);
  NSDictionary<NSString *, NSNumber *> *geometry = [NSJSONSerialization
      JSONObjectWithData:[NSData dataWithContentsOfURL:url] options:0 error:nil];
  CGFloat width = 393;
  CGFloat height = geometry[@"NAV_NATIVE_HEIGHT_ABOVE_INSET"].doubleValue + window.safeAreaInsets.bottom;
  RCTViewComponentView *host = [[NSClassFromString(@"TSTabBarComponentView") alloc]
      initWithFrame:CGRectMake((CGRectGetWidth(window.bounds) - width) / 2,
                               CGRectGetHeight(window.bounds) - height, width, height)];
  [window addSubview:host];
  auto props = std::make_shared<TSTabBarProps>();
  props->selectedId = "home";
  props->items = {
    {.id = "home", .title = "Home", .symbol = "house", .selectedSymbol = "house.fill", .testID = "tab-home"},
    {.id = "videos", .title = "Videos", .symbol = "play", .selectedSymbol = "play.fill", .testID = "tab-videos"},
    {.id = "schedule", .title = "Schedule", .symbol = "calendar", .selectedSymbol = "calendar", .testID = "tab-schedule"},
    {.id = "chat", .title = "Chat", .symbol = "bubble.left", .selectedSymbol = "bubble.left.fill", .testID = "tab-chat"},
    {.id = "search", .title = "Search", .symbol = "magnifyingglass", .selectedSymbol = "magnifyingglass", .testID = "tab-search"}
  };
  UITabBar *bar = (UITabBar *)host.subviews.firstObject;
  auto verifyPlatter = [&](BOOL compact) {
    [host layoutIfNeeded];
    [bar layoutIfNeeded];
    NSMutableArray<UIView *> *candidates = [NSMutableArray array];
    for (UIView *child in bar.subviews) {
      if (ControlCount(child) >= bar.items.count) [candidates addObject:child];
    }
    XCTAssertEqual(candidates.count, 1U);
    UIView *platter = candidates.firstObject;
    CGRect frame = [platter convertRect:platter.bounds toView:host];
    CGFloat expectedWidth = compact ? geometry[@"NAV_COMPACT_WIDTH"].doubleValue
                                    : width - 2 * geometry[@"NAV_SIDE_INSET"].doubleValue;
    CGFloat expectedHeight = geometry[compact ? @"NAV_COMPACT_HEIGHT" : @"NAV_HEIGHT"].doubleValue;
    XCTAssertEqualWithAccuracy(CGRectGetWidth(frame), expectedWidth, 0.5);
    XCTAssertEqualWithAccuracy(CGRectGetHeight(frame), expectedHeight, 0.5);
    XCTAssertEqualWithAccuracy(CGRectGetMinX(frame), (width - expectedWidth) / 2, 0.5);
    XCTAssertEqualWithAccuracy(height - CGRectGetMaxY(frame), geometry[@"NAV_BOTTOM_GAP"].doubleValue, 0.5);
  };
  [host updateProps:props oldProps:nullptr];
  verifyPlatter(NO);
  auto minimized = std::make_shared<TSTabBarProps>(*props);
  minimized->compact = true;
  [host updateProps:minimized oldProps:props];
  verifyPlatter(YES);
  CGPoint margin = CGPointMake(1, CGRectGetMidY(bar.frame));
  XCTAssertTrue(CGRectContainsPoint(host.bounds, margin));
  XCTAssertFalse(CGRectContainsPoint(bar.frame, margin));
  XCTAssertNil([host hitTest:margin withEvent:nil]);
  // The hosted runner can omit accessibility mirrors. Use the centre of the
  // first visible slot in the compact platter measured above.
  CGFloat compactWidth = geometry[@"NAV_COMPACT_WIDTH"].doubleValue;
  CGFloat compactHeight = geometry[@"NAV_COMPACT_HEIGHT"].doubleValue;
  CGPoint centre = CGPointMake((width - compactWidth) / 2 + compactWidth / (2 * bar.items.count),
                               height - geometry[@"NAV_BOTTOM_GAP"].doubleValue - compactHeight / 2);
  UIView *target = [host hitTest:centre withEvent:nil];
  XCTAssertNotNil(target);
  XCTAssertTrue([target isDescendantOfView:bar] && target != bar);
  [host updateProps:props oldProps:minimized];
  verifyPlatter(NO);
  // UIKit decides which mirrored controls it exposes when an accessibility
  // client connects. Exercise the same public label/identifier contract on
  // a normal and a magnified control even in a headless hosted unit test.
  UIView *mirrors = [UIView new];
  for (NSUInteger index = 0; index < 2; index++) {
    UIControl *control = [UIControl new];
    control.accessibilityLabel = @"Home";
    control.accessibilityIdentifier = index == 0 ? @"tab-home" : nil;
    [mirrors addSubview:control];
  }
  [bar addSubview:mirrors];
  [bar setNeedsLayout];
  [bar layoutIfNeeded];
  NSArray<UIView *> *controls = ControlsNamed(bar, @"Home");
  XCTAssertGreaterThanOrEqual(controls.count, 2U);
  for (UIView *control in controls) {
    XCTAssertEqualObjects(control.accessibilityIdentifier, @"tab-home");
  }
  [host removeFromSuperview];
}
@end
