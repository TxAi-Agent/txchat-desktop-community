import type { DocumentKind, ProductDocument } from '../shared/documents';
const titles: Record<DocumentKind, [string, string]> = { terms: ['服务条款', 'Terms of Service'], privacy: ['隐私说明', 'Privacy Notice'], guide: ['常见问题', 'Frequently Asked Questions'], about: ['关于 TxChat', 'About TxChat'], cloud: ['TxChat 云端服务', 'TxChat Cloud'] };
/** Small local-document parser, never executes Markdown/HTML. */
export function parseProductDocument(kind: DocumentKind, language: 'zh' | 'en', source: string): ProductDocument {
  const blocks: ProductDocument['blocks'] = [], paragraph: string[] = [];
  const flush = () => { const text = paragraph.join('\n').trim(); if (text) blocks.push({ kind: 'paragraph', text }); paragraph.length = 0; };
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const text = line.trim();
    if (!text) flush();
    else if (text.startsWith('## ')) { flush(); const heading = text.slice(3).trim(); if (heading) blocks.push({ kind: 'heading', text: heading }); }
    else if (text.startsWith('# ')) flush();
    else paragraph.push(text);
  }
  flush();
  if (!blocks.length) throw new Error('DOCUMENT_UNAVAILABLE');
  return { kind, language, title: titles[kind][language === 'zh' ? 0 : 1], blocks };
}
