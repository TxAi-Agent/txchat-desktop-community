import type { SoftwareUpdateSnapshot, SoftwareUpdateAction } from '../shared/software-update';
export function softwareUpdatePresentation(state: SoftwareUpdateSnapshot, language: 'zh' | 'en') {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const item = state.item;
  const size = item?.size ? new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 1 }).format(item.size / (item.size >= 1e9 ? 1e9 : item.size >= 1e6 ? 1e6 : 1e3)) + (item.size >= 1e9 ? ' GB' : item.size >= 1e6 ? ' MB' : ' KB') : t('大小未知', 'Size unknown');
  const heading = t('TxChat 有新版本', 'A New Version of TxChat Is Available');
  const versionLine = t(`版本 ${item?.version ?? state.version} · 约 ${size}`, `Version ${item?.version ?? state.version} · About ${size}`);
  let section = '', lines: string[] = [], caption: string | null = null, progress: number | null = null;
  let primary = '', secondary: string | null = null, primaryAction: SoftwareUpdateAction = 'update-download', secondaryAction: SoftwareUpdateAction = 'update-close';
  let enabled = !state.pendingAction, danger = false;
  if (state.phase === 'available') {
    section = item?.required ? t('为什么需要更新', 'Why This Update Is Required') : t('本次更新', "What's New");
    lines = item?.required ? [t('• 此版本包含必要的兼容性与安全修复', '• Required compatibility and security fixes'),
      // Electron has no Sparkle signature; never advertise a check this architecture cannot perform.
      t('• 更新包会校验开发者签名和文件完整性', '• Verifies the developer signature and package integrity'),
      t('• 当前任务结束后才会阻止开始新的听写', '• Blocks new dictation only after the current task ends')] : (item?.releaseNotes ?? []).map((note) => {
        const divider = note.indexOf('|'); return '• ' + (divider > 0 && divider < note.length - 1 ? language === 'zh' ? note.slice(0, divider) : note.slice(divider + 1) : note);
      });
    primary = t('立即更新', 'Update Now'); secondary = item?.required ? t('退出 TxChat', 'Quit TxChat') : t('跳过此版本', 'Skip This Version');
    secondaryAction = item?.required ? 'update-quit' : 'update-skip';
  } else if (state.phase === 'downloading') {
    section = t('正在下载更新', 'Downloading Update');
    lines = [t(`已下载 ${(state.downloadedBytes / 1e6).toFixed(1)} MB`, `${(state.downloadedBytes / 1e6).toFixed(1)} MB downloaded`)];
    progress = state.progress; primary = t('正在下载…', 'Downloading…'); enabled = false;
    secondary = item?.required ? t('退出 TxChat', 'Quit TxChat') : t('取消下载', 'Cancel Download'); secondaryAction = item?.required ? 'update-quit' : 'update-cancel';
  } else if (state.phase === 'ready') {
    section = t('更新已准备就绪', 'Update Ready'); lines = [t('TxChat 将退出并完成安装，随后自动重新启动。', 'TxChat will quit, install the update, and restart automatically.')];
    caption = item?.required ? t('安装前仍不会中断已经开始的听写任务。', 'Active dictation will not be interrupted before installation.') : t('你也可以稍后安装，不影响当前继续使用。', 'You can install later and keep using this version.');
    primary = t('安装并重新启动', 'Install and Restart'); primaryAction = 'update-install'; secondary = item?.required ? t('退出 TxChat', 'Quit TxChat') : t('稍后安装', 'Install Later'); secondaryAction = item?.required ? 'update-quit' : 'update-later';
  } else if (state.phase === 'installing') {
    section = t('正在安装更新', 'Installing Update'); lines = [t('TxChat 正在完成安装，随后将自动重新启动。', 'TxChat is finishing the update and will restart automatically.')];
    caption = t('安装期间请勿退出 TxChat。', 'Do not quit TxChat during installation.'); primary = t('正在安装…', 'Installing…'); enabled = false;
  } else {
    section = t('更新下载失败', 'Download Failed'); lines = [t('未能完成更新下载，请检查网络连接后重试。', 'The update could not be downloaded. Check your connection and try again.')];
    caption = item?.required ? t('重试成功前不能开始新的听写；已开始的任务不会被中断。', 'New dictation stays blocked until retry succeeds; active tasks continue.') : t('关闭提示后仍可继续使用当前版本。', 'Close this window to keep using the current version.');
    primary = t('重试', 'Retry'); primaryAction = 'update-retry'; secondary = item?.required ? t('退出 TxChat', 'Quit TxChat') : t('关闭', 'Close'); secondaryAction = item?.required ? 'update-quit' : 'update-close'; danger = true;
    if (state.failure === 'restart-required') {
      section = t('需要重新打开 TxChat', 'Reopen TxChat to Continue');
      lines = [t('更新状态需要重置，请退出并重新打开 TxChat 后再试。', 'Quit and reopen TxChat to reset the update state, then try again.')];
      primary = t('退出 TxChat', 'Quit TxChat'); primaryAction = 'update-quit';
      if (item?.required) secondary = null;
    }
  }
  return { heading, versionLine, section, lines, caption, progress, primary, secondary, primaryAction, secondaryAction, enabled, danger };
}
