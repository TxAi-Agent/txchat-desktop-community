import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupUnavailable } from '../src/renderer/product/SetupUnavailable';
import { errorText, Icon, translate } from '../src/renderer/product/ui';

test('unconfigured service screen explains integration and keeps local and login entry points', () => {
  const html = renderToStaticMarkup(createElement(SetupUnavailable, { t: translate('en'), enterLocal() {}, showLogin() {} }));
  assert.match(html, /No service adapter is configured/);
  assert.match(html, /rebuild/);
  assert.match(html, /Open Local Development/);
  assert.match(html, /View Login/);
  assert.match(html, /does not create an account/);
});

test('unconfigured screen supports Chinese without leaking an internal endpoint', () => {
  const html = renderToStaticMarkup(createElement(SetupUnavailable, { t: translate('zh'), enterLocal() {}, showLogin() {} }));
  assert.match(html, /尚未配置服务适配器/);
  assert.match(html, /进入本地开发界面/);
  assert.doesNotMatch(html, /https?:|\/Users\//);
});

test('known errors provide safe guidance and unknown details are suppressed', () => {
  assert.match(errorText('SERVICE_NOT_CONFIGURED', translate('en')), /service adapter/);
  assert.match(errorText('HELPER_NOT_BUILT', translate('en')), /npm run build:native/);
  assert.match(errorText('HELPER_NOT_BUILT', translate('zh')), /原生辅助程序尚未构建/);
  assert.match(errorText('RECOGNITION_NOT_CONFIGURED', translate('en')), /recognition adapter/);
  assert.match(errorText('HOTKEY_CONFLICT', translate('en')), /shortcut/i);
  const unknown = 'unrecognized-sensitive-diagnostic-value';
  assert.doesNotMatch(errorText(unknown, translate('en')), /unrecognized-sensitive/);
});

test('provider identities use plain text instead of vendor logo assets', () => {
  for (const name of ['alibaba-bailian', 'volcengine', 'deepseek', 'kimi', 'glm']) {
    const html = renderToStaticMarkup(createElement(Icon, { name }));
    assert.match(html, /tx-provider-initial/);
    assert.doesNotMatch(html, /<svg|<img|src=/);
  }
});

test('renderer entry exposes product windows without development or visual fixture routes', () => {
  const source = readFileSync(join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
  assert.match(source, /window\.txchat/);
  for (const route of ['hud', 'menu', 'result', 'diagnostics', 'update']) assert.ok(source.includes(`#${route}`));
  assert.doesNotMatch(source, /DevelopmentPanel|VisualFixture|visualFixture|#development|window\.community/);
});

test('public renderer assets contain only sanitized original SVG files', () => {
  const directory = join(process.cwd(), 'src/renderer/product/assets');
  const files = readdirSync(directory);
  assert.ok(files.length > 0);
  for (const filename of files) {
    assert.match(filename, /^TxChat-.*\.svg$/);
    const svg = readFileSync(join(directory, filename), 'utf8');
    assert.doesNotMatch(svg, /<metadata|<title|<desc|data-|\/Users\/|id="(?!s\d+")/);
  }
});

test('local HTML keeps renderer networking disabled', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8');
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /\.\/index\.js/);
});

test('diagnostic prompt and retry explain missing service and disable sending', async () => {
  const result = await build({ entryPoints: ['src/renderer/product/DiagnosticWindow.tsx'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' } });
  const module = { exports: {} as { DiagnosticWindow: ComponentType<{ snapshot: unknown; command: () => Promise<void> }> } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(join(process.cwd(), 'package.json')), module, module.exports);
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false }) } });
  try {
    for (const phase of ['prompt', 'failed']) {
      const html = renderToStaticMarkup(createElement(module.exports.DiagnosticWindow, {
        snapshot: { platform: 'darwin', product: { preferences: { language: 'en', theme: 'light' },
          environment: { configured: false }, diagnostics: { phase, isAbnormalExit: false, reportId: null, diagnosticNumber: null } } },
        command: async () => {}
      }));
      assert.match(html, /Report service not configured/);
      assert.match(html, /No report is uploaded/);
      assert.match(html, /<button[^>]*disabled=""[^>]*>Not configured<\/button>/);
      assert.match(html, /<button>Cancel<\/button>/);
      assert.doesNotMatch(html, /Check your connection/);
    }
  } finally { Object.assign(globalThis, { window: previousWindow }); }
});

test('unconfigured membership actions never imply a synchronization is in progress', async () => {
  const result = await build({ entryPoints: ['src/renderer/product/Membership.tsx'], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' } });
  const module = { exports: {} as { Membership: ComponentType<Record<string, unknown>> } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(join(process.cwd(), 'package.json')), module, module.exports);
  for (const language of ['en', 'zh'] as const) {
    const html = renderToStaticMarkup(createElement(module.exports.Membership, {
      product: { preferences: { language }, environment: { configured: false }, auth: { demo: true },
        billing: { offer: null, status: null, error: null, statusDisplayError: null, loading: false, payment: { order: null, busy: false } } },
      t: translate(language), command: async () => {}, disabled: false, onBack() {}
    }));
    assert.equal((html.match(language === 'en' ? />Not configured<\/button>/g : />尚未配置<\/button>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /Syncing|Please Wait|正在同步|请稍候/);
  }
});
