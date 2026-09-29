#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string.h>

// Stable Node-API only: no V8, Electron-private headers or background AppKit use.
static napi_value MainDisplayId(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  if (argc != 0) {
    napi_throw_type_error(env, "INVALID_ARGUMENTS", "mainDisplayId takes no arguments");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, "MAIN_THREAD_REQUIRED", "NSScreen must be read on the application main thread");
    return nullptr;
  }
  @autoreleasepool {
    NSScreen *screen = [NSScreen mainScreen];
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    napi_value result;
    if (number == nil) {
      if (napi_get_null(env, &result) != napi_ok) return nullptr;
    } else if (napi_create_uint32(env, number.unsignedIntValue, &result) != napi_ok) {
      return nullptr;
    }
    return result;
  }
}

static napi_value HideMainWindowZoomButton(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  bool isBuffer = false;
  if (argc != 1 || napi_is_buffer(env, argv[0], &isBuffer) != napi_ok || !isBuffer) {
    napi_throw_type_error(env, "INVALID_ARGUMENTS", "A native NSView handle is required");
    return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, "MAIN_THREAD_REQUIRED", "Window controls must be changed on the application main thread");
    return nullptr;
  }
  void *bytes = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok || length != sizeof(NSView *)) {
    napi_throw_type_error(env, "INVALID_ARGUMENTS", "Invalid native NSView handle size");
    return nullptr;
  }
  void *rawView = nullptr;
  memcpy(&rawView, bytes, sizeof(rawView));
  NSView *view = (__bridge NSView *)rawView;
  @autoreleasepool {
    NSWindow *window = view.window;
    NSButton *zoom = [window standardWindowButton:NSWindowZoomButton];
    if (window == nil || zoom == nil) {
      napi_throw_error(env, "WINDOW_NOT_READY", "The main window zoom button is unavailable");
      return nullptr;
    }
    zoom.enabled = NO;
    zoom.hidden = YES;
  }
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return nullptr;
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    { "mainDisplayId", nullptr, MainDisplayId, nullptr, nullptr, nullptr, napi_default, nullptr },
    { "hideMainWindowZoomButton", nullptr, HideMainWindowZoomButton, nullptr, nullptr, nullptr, napi_default, nullptr }
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(txchat_platform, Init)
