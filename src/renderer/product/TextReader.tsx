import type { ProductDocument } from '../../shared/documents';
import { Modal } from './ui';
import './text-reader.css';
export function TextReader({ document, close }: {
    document: ProductDocument;
    close: () => void;
}) {
    return <Modal variant="reader" title={document.title} onClose={close} footer={<button className="tx-primary" onClick={close}>{document.language === 'zh' ? '关闭' : 'Close'}</button>}>
    <div className="tx-reader-scroll" tabIndex={0} role="region" aria-label={document.title} data-auto-focus onBlur={(event) => event.currentTarget.removeAttribute('data-auto-focus')}>
      {document.blocks.map((block, index) => block.kind === 'heading' ? <h3 key={index}>{block.text}</h3> : <p key={index}>{block.text}</p>)}
    </div>
  </Modal>;
}
