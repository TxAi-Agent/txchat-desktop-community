import { app, screen } from 'electron';
import NodeModule from 'node:module';
import path from 'node:path';
import type { HUDRectangle } from '../domain/hud-placement';
export type { HUDRectangle } from '../domain/hud-placement';

export interface HUDPlatformOptions { readWindowsDisplay?: () => Promise<HUDRectangle | null> }
interface MacPlatform { mainDisplayId(): number | null; hideMainWindowZoomButton(handle: Buffer): void }

/** This library executes inside Electron's main process, so NSScreen.main has
 * the desktop application's screen ownership. A helper's NSScreen.main is different. */
export function loadMacPlatform(): MacPlatform {
  const modulePath = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'Frameworks', 'txchat-platform.node')
    : path.join(app.getAppPath(), '.build', 'native', 'darwin-arm64', 'txchat-platform.node');
  // An absolute, application-owned path and Node's runtime require avoid webpack
  // asset collection. No renderer argument or environment override selects code.
  // Access via the default Node module object: webpack rewrites a named
  // createRequire import, which would turn this into a bundled context require.
  const requireNative = NodeModule.createRequire(path.join(app.getAppPath(), 'package.json'));
  const platform: unknown = requireNative(modulePath);
  if (!platform || typeof platform !== 'object' || !('mainDisplayId' in platform) || typeof platform.mainDisplayId !== 'function' ||
      !('hideMainWindowZoomButton' in platform) || typeof platform.hideMainWindowZoomButton !== 'function')
    throw new Error('INVALID_MAC_PLATFORM_MODULE');
  return platform as MacPlatform;
}

export function createHUDDisplayResolver(options: HUDPlatformOptions): () => HUDRectangle | null | Promise<HUDRectangle | null> {
  if (process.platform === 'darwin') {
    // A missing/broken module is a packaging error, not permission to substitute
    // pointer location, another process's screen, or the primary display.
    let platform: MacPlatform;
    try { platform = loadMacPlatform(); } catch { return () => null; }
    return () => {
      const id = platform.mainDisplayId();
      if (id === null || !Number.isSafeInteger(id)) return null;
      return screen.getAllDisplays().find((display) => display.id === id)?.workArea ?? null;
    };
  }
  if (process.platform === 'win32') return async () => {
    const physical = await options.readWindowsDisplay?.();
    if (!physical) return null;
    if (![physical.x, physical.y, physical.width, physical.height].every(Number.isFinite) || physical.width <= 0 || physical.height <= 0) return null;
    // Electron performs the per-monitor transform, including virtual desktop
    // origins; dividing every coordinate by one scale factor is incorrect.
    const dip = screen.screenToDipRect(null, physical);
    const display = screen.getDisplayMatching(dip);
    // Reject a monitor removed while the helper reply was in flight.
    const bounds = display.bounds;
    if (Math.min(bounds.x + bounds.width, dip.x + dip.width) <= Math.max(bounds.x, dip.x) ||
      Math.min(bounds.y + bounds.height, dip.y + dip.height) <= Math.max(bounds.y, dip.y)) return null;
    return display.workArea;
  };
  return () => null;
}

export { hudPlacementKey } from '../domain/hud-placement';
