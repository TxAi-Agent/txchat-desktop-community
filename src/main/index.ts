import { app, BrowserWindow, ipcMain, Menu, session, safeStorage, Tray, nativeImage, powerMonitor, screen } from 'electron';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DictationController } from '../domain/dictation';
import { NativeHost } from './native-host';
import { NativeInputCoordinator } from './native-input';
import { AudioInputCoordinator } from './audio-input';
import { ProductStore } from './product-store';
import { ProductCoordinator } from './product-coordinator';
import { CloudClient } from '../adapters/cloud/client';
import { createServiceAdapter } from '../adapters/services/integration';
import { createRecognitionProvider } from '../adapters/recognition-provider';
import { createHTTPTransport } from '../adapters/network';
import { CustomAIError, type ProviderTransport } from '../adapters/custom-ai';
import { createMainWindow, createHUD, createMenuPanel, createUpdateWindow, createDiagnosticWindow, createResultWindow, updateHUD } from './windows';
import { menuPosition, menuPresentation } from '../domain/menu-panel';
import { authorizeSender, parseCommand, type TrustedWindow } from './command-policy';
import { CHANNELS, type AppSnapshot } from '../shared/contracts';
import { DiskDiagnosticStore } from './diagnostic-store';
import { DiagnosticRuntime } from './diagnostic-runtime';
import { SoftwareUpdateCoordinator } from './software-update-coordinator';
import { createUpdateBackend } from './update-integration';
import { loadDocument } from './documents';
import { WindowVisibilityMonitor } from './window-visibility-monitor';

app.setName('TxChat Community');
app.setAppUserModelId('org.txchat.community');
const profile = process.env.TXCHAT_COMMUNITY_PROFILE;
if (profile && !path.isAbsolute(profile)) throw Error('PROFILE_PATH_INVALID');
const dataPath = profile || path.join(app.getPath('appData'), 'TxChat-Community');
app.setPath('userData', dataPath);
let main: BrowserWindow;
let hud: BrowserWindow;
let menu: BrowserWindow;
let update: BrowserWindow;
let diagnostic: BrowserWindow;
let result: BrowserWindow;
let native: NativeHost;
let controller: DictationController;
let input: NativeInputCoordinator;
let audio: AudioInputCoordinator;
let product: ProductCoordinator;
let store: ProductStore;
let diagnostics: DiagnosticRuntime;
let updates: SoftwareUpdateCoordinator;
let tray: Tray;
let quitting = false;
let installing = false;
let recovering = false;
let restoreHelperAfterUpdate = false;
let preparation: Promise<void> | null = null;
let sequence = 0;
let visibilityTimer: ReturnType<typeof setInterval> | undefined;
const trusted = new Map<number, TrustedWindow>();
const windows = () => [main, hud, menu, update, diagnostic, result].filter(Boolean);
const snapshot = (): AppSnapshot => ({ sequence: ++sequence, platform: process.platform === 'darwin' ? 'darwin' : 'win32', dictation: controller.snapshot,
  helper: native.snapshot, mode: input.mode, input: input.snapshot, audio: audio.snapshot, product: product.snapshot });
function publish() {
  if (!product || !main || quitting) return;
  product.observeAudioStatus();
  const state = snapshot();
  if (installing && state.product.update.phase !== 'installing' && !recovering) {
    recovering = true;
    void (preparation ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (quitting) return;
      await diagnostics.resume();
      if (!quitting && restoreHelperAfterUpdate) await native.start().catch(() => undefined);
    }).finally(() => {
      installing = false; recovering = false; preparation = null;
      if (!quitting) product.recoverFromUpdate();
    });
  }
  for (const window of windows()) if (!window.isDestroyed() && !window.webContents.isLoadingMainFrame()) window.webContents.send(CHANNELS.snapshot, state);
  if (!hud.isDestroyed()) updateHUD(hud, state);
  const idle = ['idle', 'unavailable', 'completed', 'failed', 'resultFallback'].includes(state.dictation.phase);
  for (const [window, visible] of [[update, !!state.product.update.visible],
    [diagnostic, state.product.diagnostics.phase !== 'idle'], [result, state.dictation.phase === 'resultFallback']] as const) {
    if (window.isDestroyed()) continue;
    if (visible && idle && !window.isVisible()) { window.center(); window.show(); }
    else if (!visible) window.hide();
  }
  if (tray && !tray.isDestroyed()) tray.setToolTip(`TxChat — ${menuPresentation(state).title}`);
  product.synchronizeReadiness();
}
function openMain() { if (menu && !menu.isDestroyed()) menu.hide(); if (main && !main.isDestroyed()) { main.show(); main.focus(); } }
const mayRestartHelper = () => !quitting && !installing && updates.snapshot.phase !== 'installing';
function allow(event: Electron.IpcMainInvokeEvent, action: string) {
  if (!authorizeSender({ id: event.sender.id, url: event.senderFrame?.url || '', mainFrame: event.senderFrame === event.sender.mainFrame }, trusted.get(event.sender.id), action)) throw Error('IPC_DENIED');
}
function register(window: BrowserWindow, url: string, role: TrustedWindow['role']) {
  trusted.set(window.webContents.id, { id: window.webContents.id, url, role });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('closed', () => { for (const [id, item] of trusted) if (item.role === role) trusted.delete(id); });
  if (process.platform === 'win32') window.on('session-end', () => void diagnostics?.terminateForWindowsSession());
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openMain);
  void app.whenReady().then(async () => {
    const root = app.getAppPath();
    const preload = path.join(__dirname, 'preload.cjs');
    const base = pathToFileURL(path.join(__dirname, 'renderer/index.html')).href;
    main = createMainWindow(preload);
    hud = createHUD(preload, { readWindowsDisplay: async () => native?.snapshot.status === 'ready' ? native.hudDisplay() : null });
    menu = createMenuPanel(preload); update = createUpdateWindow(preload); diagnostic = createDiagnosticWindow(preload); result = createResultWindow(preload);
    for (const [window, hash, role] of [[main, '', 'main'], [hud, '#hud', 'hud'], [menu, '#menu', 'menu'], [update, '#update', 'update'], [diagnostic, '#diagnostics', 'diagnostics'], [result, '#result', 'result']] as const) register(window, base + hash, role);
    const renderer = session.defaultSession;
    renderer.setPermissionRequestHandler((_web, _permission, done) => done(false));
    renderer.setPermissionCheckHandler(() => false);
    renderer.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, done) => done({ cancel: true }));
    const helper = path.join(root, '.build/native', process.platform === 'darwin' ? 'darwin-arm64' : 'win-x64', process.platform === 'darwin' ? 'txchat-native-host' : 'TxChat.NativeHost.exe');
    native = new NativeHost({ executable: helper, platform: process.platform, arch: process.arch });
    controller = new DictationController(scenario => product.voiceTestActive ? product.createVoiceSession() : input.createSession(scenario),
      (stage, error) => product?.recordDiagnosticFailure(stage === 'event_delivery' ? 'insertion' : 'dictation', stage, error instanceof Error ? error.message : null));
    controller.setAvailable(false);
    input = new NativeInputCoordinator(native, controller, () => [process.pid, ...app.getAppMetrics().map(item => item.pid)], publish,
      () => product.createRecognition(), () => product.hotkey());
    audio = new AudioInputCoordinator(native, controller, () => input.mode === 'native' && !input.snapshot.busy, publish);
    const cipher = { available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (text: string) => safeStorage.encryptString(text), decrypt: (bytes: Buffer) => safeStorage.decryptString(bytes) };
    store = new ProductStore(dataPath, cipher);
    const storageErrors = await store.load();
    const cloud = new CloudClient(createServiceAdapter());
    const network = session.fromPartition('community-services', { cache: false });
    // Requests originate only from validated provider selections, including explicit unsaved test drafts.
    // The transport independently enforces HTTPS, no credentials in URLs, no redirects and bounded responses.
    const transport = createHTTPTransport(network, () => true);
    const providerTransport: ProviderTransport = async (request, signal) => {
      try { return await transport(request, signal); }
      catch (error) { throw new CustomAIError(signal.aborted ? 'CANCELLED' : (error as Error).message === 'REQUEST_TIMEOUT' ? 'CUSTOM_AI_TIMEOUT' : (error as Error).message === 'RESPONSE_TOO_LARGE' ? 'CUSTOM_AI_RESPONSE_TOO_LARGE' : 'CUSTOM_AI_NETWORK'); }
    };
    diagnostics = new DiagnosticRuntime({ store: new DiskDiagnosticStore(dataPath), service: { submit: (envelope, signal) => cloud.diagnostic(envelope, signal) }, snapshot: () => {
      const mic = audio.snapshot.status?.permission, access = input.snapshot.status?.accessibility;
      return { installationId: store.installationId, app: { version: app.getVersion(), build: '1', locale: store.preferences.language === 'zh' ? 'zh-Hans' : 'en', architecture: process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : 'unknown' },
        system: { platform: process.platform === 'darwin' ? 'macos' : 'windows', osVersion: process.getSystemVersion(), microphone: mic === 'granted' || mic === 'systemManaged' ? 'authorized' : mic === 'denied' ? 'denied' : 'unknown', accessibility: access === 'granted' || access === 'notRequired' ? 'authorized' : access === 'denied' ? 'denied' : 'unknown' },
        service: { mode: store.preferences.service === 'custom' ? 'custom' : 'txchat_cloud' } };
    } });
    updates = new SoftwareUpdateCoordinator({ currentVersion: app.getVersion(), backend: createUpdateBackend(), publish, dictationPhase: () => controller.snapshot.phase,
      loadSkippedVersion: () => store.skippedUpdateVersion, saveSkippedVersion: value => store.saveSkippedUpdateVersion(value),
      prepareForInstall: () => {
        if (preparation) return preparation;
        installing = true; restoreHelperAfterUpdate = native.snapshot.status === 'ready';
        preparation = Promise.resolve().then(async () => {
          await product.prepareForUpdate();
          if (quitting || updates.snapshot.phase !== 'installing') throw Error('UPDATE_INSTALL_ABORTED');
          await native.stop(); await store.flush(); await diagnostics.terminate();
          if (quitting || updates.snapshot.phase !== 'installing') throw Error('UPDATE_INSTALL_ABORTED');
        });
        return preparation;
      }, quit: async () => { app.quit(); } });
    product = new ProductCoordinator(store, cloud, network, providerTransport, native, controller, input, audio, app.getVersion(), publish, loadDocument, updates, diagnostics, undefined, createRecognitionProvider());
    native.subscribe(state => { controller.setAvailable(state.status === 'ready'); product.helperChanged(state.status === 'ready'); input.helperChanged(state.status === 'ready'); audio.helperChanged(state.status === 'ready'); publish(); });
    controller.subscribe(state => { product.observeDictation(state); publish(); });
    ipcMain.handle(CHANNELS.read, (event, ...args) => { allow(event, 'read'); if (args.length) throw Error('INVALID_ARGUMENTS'); return snapshot(); });
    ipcMain.handle(CHANNELS.readCustomDraft, (event, request, ...args) => {
      allow(event, 'custom-draft-read');
      if (args.length || quitting || installing || updates.snapshot.phase === 'installing' || !main.isVisible() || main.isMinimized()) throw Error('CUSTOM_AI_DRAFT_READ_DENIED');
      return product.readCustomDraft(request);
    });
    ipcMain.handle(CHANNELS.command, async (event, value, ...args) => {
      const command = parseCommand(value); allow(event, command.type);
      if (args.length || quitting || installing || updates.snapshot.phase === 'installing') throw Error('COMMAND_DENIED');
      try {
        switch (command.type) {
          case 'app-open': openMain(); break;
          case 'app-quit': app.quit(); break;
          case 'menu-close': menu.hide(); break;
          case 'start': if (product.canStart()) await controller.start(); break;
          case 'stop': await controller.stop(); break;
          case 'cancel': controller.cancel(); break;
          case 'dismiss': controller.dismiss(); break;
          case 'restart-helper': if (!existsSync(helper)) { product.helperBuildMissing(); break; } if (existsSync(helper) && ['idle', 'unavailable', 'completed', 'failed'].includes(controller.snapshot.phase)) { await native.stop(); if (mayRestartHelper()) await native.start(); } break;
          case 'native-enable': if (product.canStart()) await product.enableShortcut(command.binding); break;
          case 'native-disable': product.shortcutDisabled(); input.disable(); controller.cancel(); audio.select('synthetic'); break;
          case 'native-status': await input.refresh(); break;
          case 'native-permissions': case 'native-accessibility-permission': await input.permissions(); break;
          case 'audio-status': await audio.refresh(false); break;
          case 'audio-permission': await audio.refresh(true); break;
          case 'scenario': controller.selectScenario(command.value); break;
          case 'audio-source': audio.select(command.value); break;
          case 'fixture-scenario': audio.scenario(command.value); break;
          default: await product.command(command);
        }
      } catch { throw Error('COMMAND_FAILED'); }
      publish();
    });
    const image = nativeImage.createFromPath(path.join(root, 'resources/trayTemplate.png'));
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image); tray.setToolTip('TxChat Community');
    tray.on('click', () => { if (menu.isVisible()) { menu.hide(); return; } const bounds = tray.getBounds(); const position = menuPosition(bounds, screen.getDisplayMatching(bounds).workArea); menu.setPosition(position.x, position.y); publish(); menu.show(); menu.focus(); });
    tray.on('right-click', () => { const view = menuPresentation(snapshot()); tray.popUpContextMenu(Menu.buildFromTemplate([{ label: view.open, click: openMain }, { label: view.quit, click: () => app.quit() }])); });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'TxChat', submenu: [{ label: 'Open / 打开', click: openMain }, { label: 'Quit / 退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] }, { role: 'editMenu' }]));
    main.on('close', event => { if (!quitting) { event.preventDefault(); main.hide(); } });
    menu.on('blur', () => menu.hide());
    for (const window of [hud, menu, update, diagnostic, result]) window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    update.on('close', () => updates.close());
    diagnostic.on('close', () => { if (!quitting) void product.command({ type: 'diagnostics-discard' }); });
    result.on('close', () => controller.dismiss());
    const visibility = new WindowVisibilityMonitor(() => !main.isDestroyed() && main.isVisible() && !main.isMinimized(), () => { main.webContents.send(CHANNELS.customDraftInvalidated); void product.shortcutEditor.close(); });
    visibilityTimer = setInterval(() => visibility.poll(), 100); visibilityTimer.unref();
    main.on('show', () => visibility.markActive()); main.on('minimize', () => visibility.markInactive()); main.on('blur', () => { void product.shortcutEditor.close(); });
    main.webContents.on('before-input-event', (event, key) => { if (main.isFocused() && product.shortcutEditor.key(key)) event.preventDefault(); });
    main.on('focus', () => { void input.refresh(); void audio.refresh(false); });
    app.on('activate', openMain);
    powerMonitor.on('suspend', () => product.suspend()); powerMonitor.on('lock-screen', () => product.suspend());
    powerMonitor.on('resume', () => product.resume()); powerMonitor.on('unlock-screen', () => product.resume());
    await Promise.all(windows().map(window => window.loadURL(trusted.get(window.webContents.id)!.url)));
    await product.initialize(storageErrors);
    if (process.env.TXCHAT_COMMUNITY_NO_NATIVE !== '1' && ['darwin', 'win32'].includes(process.platform) && existsSync(helper)) await native.start().catch(() => undefined);
    main.show(); publish();
  }).catch(() => { process.stderr.write('COMMUNITY_STARTUP_FAILED\n'); app.exit(1); });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    if (visibilityTimer) clearInterval(visibilityTimer);
    updates?.dispose(); product?.dispose(); input?.dispose(); controller?.dispose(); audio?.dispose(); tray?.destroy();
    const deadline = setTimeout(() => app.exit(0), 3000); deadline.unref();
    void Promise.allSettled([native?.stop(), store?.flush(), diagnostics?.terminate()]).finally(() => { diagnostics?.dispose(); clearTimeout(deadline); app.quit(); });
  });
}
