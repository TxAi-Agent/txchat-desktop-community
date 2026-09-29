import type { DiagnosticState } from '../shared/diagnostics';
export function diagnosticPresentation(state: DiagnosticState, language: 'zh' | 'en', platform: 'darwin' | 'win32') {
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const secondary = t('暂不发送', 'Not Now');
  switch (state.phase) {
    case 'idle': return null;
    case 'prompt': return {
      title: state.isAbnormalExit ? t('TxChat 上次意外退出', 'TxChat quit unexpectedly') : t('TxChat 遇到问题', 'TxChat encountered an issue'),
      body: state.isAbnormalExit ? t('已检测到上次运行发生异常。是否发送问题，帮助我们定位原因？', 'TxChat did not exit normally last time. Send an issue report to help us find the cause?') : t('刚才的操作未能完成。是否发送问题，帮助我们分析并改进？', 'The last action could not be completed. Send an issue report to help us investigate and improve?'),
      caption: state.isAbnormalExit ? t('不会自动上传；仅在你确认后发送经过脱敏的诊断信息。', 'Nothing is uploaded automatically. Redacted diagnostics are sent only after you confirm.') : t('仅发送错误、版本、系统和操作阶段信息；不包含语音、识别文字、整理结果、手机号或密钥。', 'Sends only error, version, system, and workflow-stage data—never audio, transcripts, organized text, phone numbers, or keys.'),
      hint: null, secondary, primary: t('发送问题', 'Send Issue'), action: 'diagnostics-send' as const, enabled: true, tone: 'primary',
    };
    case 'sending': return { title: t('正在发送问题…', 'Sending issue…'), body: t('正在安全上传经过脱敏的错误日志，请稍候。', 'Securely uploading redacted diagnostic data. Please wait.'), caption: t('发送完成前可以继续等待；不会要求填写问题描述。', 'You can keep waiting while it sends; no issue description is required.'), hint: null, secondary: null, primary: t('正在发送…', 'Sending…'), action: 'diagnostics-send' as const, enabled: false, tone: 'primary' };
    case 'sent': return { title: t('问题已发送', 'Issue sent'), body: t(`感谢你的帮助。问题编号 ${state.diagnosticNumber} 可用于后续定位。`, `Thanks for helping. Report ID ${state.diagnosticNumber} can be used for follow-up.`), caption: t('本次仅上传经过脱敏的诊断信息。', 'Only redacted diagnostic data was uploaded.'), hint: null, secondary: null, primary: t('完成', 'Done'), action: 'diagnostics-done' as const, enabled: true, tone: 'success' };
    case 'failed': return { title: t('发送失败', 'Couldn’t send'), body: t('暂时无法发送问题，请检查网络连接后重试。', 'The issue could not be sent. Check your connection and try again.'), caption: t('如果选择暂不发送，本次错误日志将保留到本地诊断轮转期限结束。', `If you choose Not Now, this diagnostic stays on this ${platform === 'darwin' ? 'Mac' : 'PC'} until its local rotation period ends.`), hint: t('选择暂不发送会删除已确认的诊断报告；仅不含内容的本地错误事件环会保留到轮转期限。', 'Not Now deletes the consented diagnostic report; only the content-free local event ring remains until rotation.'), secondary, primary: t('重试', 'Retry'), action: 'diagnostics-retry' as const, enabled: true, tone: 'danger' };
  }
}
