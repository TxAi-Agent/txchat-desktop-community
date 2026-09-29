import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let command;
let args;
if (process.platform === 'darwin') {
  if (process.arch !== 'arm64') throw new Error('The macOS helper requires Apple silicon');
  const directory = path.join(root, '.build', 'native', 'darwin-arm64');
  mkdirSync(directory, { recursive: true });
  command = '/usr/bin/xcrun';
  args = ['swiftc', '-O', '-warnings-as-errors', '-target', 'arm64-apple-macosx14.0',
    ...readdirSync(path.join(root, 'native', 'macos')).filter((name) => name.endsWith('.swift')).sort()
      .map((name) => path.join(root, 'native', 'macos', name)),
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker',
    path.join(root, 'native', 'macos', 'Info.plist'), '-o', path.join(directory, 'txchat-native-host')];
} else if (process.platform === 'win32') {
  command = 'powershell.exe';
  args = ['-NoLogo', '-NoProfile', '-File', path.join(root, 'scripts', 'build-native.ps1')];
} else {
  throw new Error('Native helper builds support macOS arm64 and Windows x64 only');
}
const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (process.platform === 'darwin') {
  const addon = spawnSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup',
    '-arch', 'arm64', '-mmacosx-version-min=14.0', '-framework', 'AppKit',
    '-I', path.join(root, 'node_modules/node-api-headers/include'),
    path.join(root, 'native/macos-platform/main.mm'), '-o', path.join(root, '.build/native/darwin-arm64/txchat-platform.node')],
    { cwd: root, stdio: 'inherit', shell: false });
  if (addon.error) throw addon.error;
  if (addon.status !== 0) process.exit(addon.status ?? 1);
}
