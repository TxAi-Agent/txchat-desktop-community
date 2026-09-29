export type DocumentKind = 'privacy' | 'terms' | 'guide' | 'about' | 'cloud';
export interface ProductDocument { kind: DocumentKind; language: 'zh' | 'en'; title: string; blocks: Array<{ kind: 'heading' | 'paragraph'; text: string }> }
