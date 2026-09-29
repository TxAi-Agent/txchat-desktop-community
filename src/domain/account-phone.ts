/** Only a successfully verified login supplies the otherwise redacted prefix. */
export function verifiedPhoneDisplay(phone: string, serverMask: string): string {
  if (!/^1\d{10}$/.test(phone) || !/^\+86\*{7}\d{4}$/.test(serverMask) || !serverMask.endsWith(phone.slice(-4))) {
    throw new Error('ACCOUNT_PHONE_MISMATCH');
  }
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

/** Refresh never guesses missing digits or reuses a prefix for a different suffix. */
export function accountPhoneDisplay(serverMask: string, previous?: string): string {
  const match = /^(?:\+86\*{7}|\*{7}|1\d{2}\*{4})(\d{4})$/.exec(serverMask);
  if (!match) return '***********';
  if (previous && /^1\d{2}\*{4}\d{4}$/.test(previous) && previous.endsWith(match[1])) return previous;
  if (/^1\d{2}\*{4}\d{4}$/.test(serverMask)) return serverMask;
  return `*******${match[1]}`;
}
