import { BrowserWindow, screen } from 'electron';
import type { AppSnapshot } from '../shared/contracts';
import { HUDLifetime } from '../domain/hud';
import { HUDPlacement } from '../domain/hud-placement';
import { createHUDDisplayResolver, hudPlacementKey, loadMacPlatform, type HUDPlatformOptions } from './hud-placement';

const hudLifetimes = new WeakMap<BrowserWindow, HUDLifetime>();
const hudPlacements = new WeakMap<BrowserWindow, HUDPlacement>();

const preferences = (preload: string) => ({ preload, sandbox: true, contextIsolation: true,
  nodeIntegration: false, webSecurity: true, spellcheck: false });
export function createMainWindow(preload: string) {
  const win = new BrowserWindow({ width: 720, height: 560, useContentSize: true,
    resizable: false, maximizable: false, fullscreenable: false, show: false,
    autoHideMenuBar: process.platform === 'win32',
    frame: true,
    transparent: false,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 14, y: 11 },
    title: 'TxChat', backgroundColor: '#FBFAF8', webPreferences: preferences(preload) });
  if (process.platform === 'darwin') {
    win.on('show', () => { try { loadMacPlatform().hideMainWindowZoomButton(win.getNativeWindowHandle()); } catch { /* Optional native module may not be built. */ } });
  }
  return win;
}
export function createHUD(preload: string, platformOptions: HUDPlatformOptions = {}) {
  const resolveDisplay = createHUDDisplayResolver(platformOptions);
  const hud = new BrowserWindow({ width: 360, height: 80, frame: false, show: false,
    transparent: true, resizable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true,
    title: 'TxChat', webPreferences: preferences(preload) });
  hud.on('page-title-updated', (event) => event.preventDefault());
  hud.setIgnoreMouseEvents(false);
  if (process.platform === 'darwin') hud.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const placement = new HUDPlacement(resolveDisplay, ({ x, y }) => {
    if (!hud.isDestroyed()) hud.setPosition(x, y, false);
  });
  const lifetime = new HUDLifetime((visible) => {
    if (hud.isDestroyed()) return;
    placement.setVisible(visible);
    if (!visible) { hud.hide(); return; }
    hud.showInactive();
  });
  hudLifetimes.set(hud, lifetime);
  hudPlacements.set(hud, placement);
  const refreshPlacement = () => placement.refresh(true);
  screen.on('display-added', refreshPlacement);
  screen.on('display-removed', refreshPlacement);
  screen.on('display-metrics-changed', refreshPlacement);
  hud.on('hide', () => placement.setVisible(false));
  hud.on('closed', () => {
    placement.dispose(); lifetime.dispose(); hudLifetimes.delete(hud); hudPlacements.delete(hud);
    screen.removeListener('display-added', refreshPlacement);
    screen.removeListener('display-removed', refreshPlacement);
    screen.removeListener('display-metrics-changed', refreshPlacement);
  });
  return hud;
}
export function createMenuPanel(preload: string) {
  return new BrowserWindow({ width: 360, height: 220, useContentSize: true, frame: false,
    type: process.platform === 'darwin' ? 'panel' : undefined, transparent: true, show: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'TxChat', webPreferences: preferences(preload) });
}
export function createUpdateWindow(preload: string) {
  const win = new BrowserWindow({ width: 560, height: 360, useContentSize: true, frame: false, transparent: true, show: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'TxChat', webPreferences: preferences(preload) });
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}
export function updateHUD(hud: BrowserWindow, snapshot: AppSnapshot) {
  hudPlacements.get(hud)?.observe(snapshot.dictation.generation, hudPlacementKey(snapshot));
  hudLifetimes.get(hud)?.update(snapshot.dictation);
}

export function createDiagnosticWindow(preload: string) {
  const win = new BrowserWindow({ width: 480, height: 280, useContentSize: true, frame: false, transparent: true, show: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'TxChat', webPreferences: preferences(preload) });
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}

export function createResultWindow(preload: string) {
  const win = new BrowserWindow({ width: 480, height: 300, useContentSize: true, frame: false, transparent: true, show: false,
    resizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'TxChat', webPreferences: preferences(preload) });
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return win;
}
