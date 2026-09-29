import { useEffect, useRef, useState } from 'react';
import type { DictionaryEntry, DictionarySnapshot } from '../../shared/product';
import { dictionaryEditorError, type DictionaryEditorError } from '../../domain/dictionary-editor';
import { Icon, Modal, Toggle, type Dispatch, type Translate } from './ui';
import './dictionary.css';
const copyEntries = (entries: DictionaryEntry[]) => entries.map((entry) => ({ ...entry }));
type Editor = {
    index: number | null;
    entry: DictionaryEntry;
    error: DictionaryEditorError | null;
    confirmDelete: boolean;
};
export function Dictionary({ snapshot, command, t, disabled, onBack, registerLeave }: {
    snapshot: DictionarySnapshot;
    command: Dispatch;
    t: Translate;
    disabled: boolean;
    onBack: () => void;
    registerLeave: (guard: ((leave: () => void) => void) | null) => void;
}) {
    const [entries, setEntries] = useState(() => copyEntries(snapshot.entries));
    const [editor, setEditor] = useState<Editor | null>(null);
    const [deleting, setDeleting] = useState<number | null>(null);
    const [pending, setPending] = useState(false);
    const [localFailure, setLocalFailure] = useState<DictionarySnapshot['notice']>(null);
    const busy = snapshot.busy || disabled || pending;
    const busyRef = useRef(busy);
    busyRef.current = busy;
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        setEntries(copyEntries(snapshot.entries));
        setEditor(null);
        setDeleting(null);
    }, [snapshot.revision]);
    useEffect(() => {
        registerLeave((action) => { if (!busyRef.current)
            action(); });
        return () => registerLeave(null);
    }, [registerLeave]);
    const run = async (value: Parameters<Dispatch>[0], failure: DictionarySnapshot['notice']) => {
        if (busyRef.current)
            return;
        busyRef.current = true;
        setPending(true);
        setLocalFailure(null);
        try {
            await command(value);
        }
        catch {
            if (mounted.current)
                setLocalFailure(failure);
        }
        finally {
            if (mounted.current) {
                busyRef.current = false;
                setPending(false);
            }
        }
    };
    const save = () => void run({ type: 'dictionary-save', entries }, 'saveFailed');
    const openEditor = (index: number | null) => {
        if (busy)
            return;
        setEditor({ index, entry: index === null ? { wrong: '', correct: '', enabled: true } : { ...entries[index] }, error: null, confirmDelete: false });
    };
    const applyEditor = () => {
        if (!editor || busy || editor.error)
            return;
        const error = dictionaryEditorError(editor.entry, entries, editor.index);
        if (error) {
            setEditor({ ...editor, error });
            return;
        }
        const entry = { ...editor.entry };
        setEntries(editor.index === null ? [entry, ...entries] : entries.map((old, i) => i === editor.index ? entry : old));
        setEditor(null);
    };
    const deleteCard = () => { if (deleting === null || busy)
        return; setEntries(entries.filter((_, i) => i !== deleting)); setDeleting(null); };
    const keyboard = useRef<(event: KeyboardEvent) => void>(() => undefined);
    keyboard.current = (event) => {
        if (busy || event.isComposing || event.defaultPrevented)
            return;
        if (page.current?.closest('[inert]'))
            return;
        if (editor || deleting !== null) {
            if (event.key === 'Enter') {
                event.preventDefault();
                if (editor)
                    applyEditor();
                else
                    deleteCard();
            }
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            onBack();
        }
        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            save();
        }
    };
    const page = useRef<HTMLElement>(null);
    useEffect(() => { const key = (event: KeyboardEvent) => keyboard.current(event); document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
    const notice = localFailure ?? snapshot.notice ?? (snapshot.error ? 'loadFailed' : null);
    const partial = !notice && snapshot.skippedLines > 0;
    const noticeText = notice ? {
        loadFailed: t('无法读取词典，当前内容未更改', 'Couldn’t read the dictionary; current content is unchanged'),
        reloadFailed: t('重新加载失败，继续使用上次有效内容', 'Reload failed; the last valid content is still active'),
        saveFailed: t('保存失败，原文件保持不变', 'Save failed; the original file is unchanged'),
        openFileFailed: t('无法创建或打开词典文件', 'Couldn’t create or open the dictionary file'),
    }[notice] : partial ? t(`已加载 ${entries.length} 条，另有 ${snapshot.skippedLines} 行格式不正确，已跳过`, `Loaded ${entries.length} entries; skipped ${snapshot.skippedLines} invalid rows`) : '';
    const validation = editor?.error ? {
        wrongEmpty: t('请输入错误词', 'Enter the wrong term'), correctEmpty: t('请输入正确词', 'Enter the correct term'),
        equal: t('错误词和正确词不能相同', 'The two terms must differ'), tooLong: t('每个词最多 100 个字符', 'Each term can contain up to 100 characters'),
        duplicate: t('该错误词已存在，请编辑原词条', 'Already exists. Edit the existing entry.'), lineBreak: t('词条不能包含换行', 'Entries cannot contain line breaks'), limit: t('最多可保存 1000 条词条', 'You can save up to 1,000 entries'),
    }[editor.error] : '';
    const invalid = (field: 'wrong' | 'correct') => !!editor?.error && (['equal', 'tooLong', 'lineBreak'].includes(editor.error) || (field === 'wrong' ? ['wrongEmpty', 'duplicate'].includes(editor.error) : editor.error === 'correctEmpty'));
    return <section ref={page} className="tx-page tx-dictionary" aria-label={t('词典', 'Dictionary')}>
    <div className="tx-dictionary-heading"><h1>{t('词典', 'Dictionary')}</h1><p>{t('将识别结果中的错误词固定替换为正确词', 'Replace incorrectly recognized words with fixed corrections')}</p></div>
    <div className="tx-dictionary-tools"><button className="tx-icon-button" title={t('重新加载', 'Reload')} aria-label={t('重新加载', 'Reload')} disabled={busy} onClick={() => void run({ type: 'dictionary-reload' }, 'reloadFailed')}><Icon name="reload"/></button><button className="tx-icon-button" title={t('打开词典文件', 'Open Dictionary File')} aria-label={t('打开词典文件', 'Open Dictionary File')} disabled={busy} onClick={() => void run({ type: 'dictionary-open' }, 'openFileFailed')}><Icon name="folder"/></button></div>
    {entries.length === 0 ? <div className="tx-dictionary-empty"><div><Icon name="dictionary-empty"/></div><h2>{t('还没有词条', 'No entries yet')}</h2><p>{t('点击右下角“添加”，创建第一条“错误词 → 正确词”固定纠正规则。', 'Click “Add” in the bottom-right to create your first “incorrect → correct” rule.')}</p></div> : <div className={`tx-dictionary-list ${partial ? 'has-partial-notice' : entries.length > 12 ? 'is-long' : ''}`}><div className="tx-dictionary-grid">{entries.map((entry, index) => <div className={`tx-dictionary-card ${entry.enabled ? '' : 'is-disabled'}`} key={`${index}-${entry.wrong}`}>
      <div className="tx-dictionary-terms"><span title={entry.wrong}>{entry.wrong}</span><Icon name="dictionary-arrow"/><span title={entry.correct}>{entry.correct}</span></div>
      <div className="tx-dictionary-actions"><button className="tx-icon-button" aria-label={t(`编辑 ${entry.wrong}`, `Edit ${entry.wrong}`)} disabled={busy} onClick={() => openEditor(index)}><Icon name="dictionary-edit"/></button><button className="tx-icon-button" aria-label={t(`删除 ${entry.wrong}`, `Delete ${entry.wrong}`)} disabled={busy} onClick={() => setDeleting(index)}><Icon name="delete"/></button></div>
    </div>)}</div></div>}
    {noticeText && <div className={`tx-dictionary-notice ${partial ? 'is-partial' : ''}`} role={partial ? 'status' : 'alert'}>{partial ? <Icon name="reload"/> : <span aria-hidden="true">ⓘ</span>}<span>{noticeText}</span></div>}
    <footer className="tx-dictionary-footer"><button disabled={busy || entries.length >= 1000} onClick={() => openEditor(null)}>{t('添加', 'Add')}</button><button disabled={busy} onClick={onBack}>{t('取消', 'Cancel')}</button><button className="tx-primary" disabled={busy} onClick={save}>{t('保存', 'Save')}</button></footer>
    {busy && <div className="tx-dictionary-busy" role="status" aria-label={t('处理中', 'Working')}><span /></div>}
    {editor && <Modal variant="dictionary-editor" title={editor.index === null ? t('添加词条', 'Add Entry') : t('编辑词条', 'Edit Entry')} onClose={() => setEditor(null)} footer={<>{editor.index !== null && <button className="tx-dictionary-editor-delete" onClick={() => { if (editor.confirmDelete) {
            setEntries(entries.filter((_, i) => i !== editor.index));
            setEditor(null);
        }
        else
            setEditor({ ...editor, confirmDelete: true }); }}>{editor.confirmDelete ? t('确认删除', 'Confirm') : t('删除', 'Delete')}</button>}<button onClick={() => setEditor(null)}>{t('取消', 'Cancel')}</button><button className="tx-primary" disabled={!!editor.error || busy} onClick={applyEditor}>{t('保存', 'Save')}</button></>}>
      <div className="tx-dictionary-editor-fields">{(['wrong', 'correct'] as const).map((field) => <label key={field}>{field === 'wrong' ? t('识别结果中的错误词', 'Incorrect recognized word') : t('固定替换为正确词', 'Replace with correct word')}<input data-initial-focus={field === 'wrong' ? true : undefined} aria-invalid={invalid(field)} value={editor.entry[field]} onChange={(event) => setEditor({ ...editor, error: null, entry: { ...editor.entry, [field]: event.target.value } })} placeholder={field === 'wrong' ? t('请输入错误词', 'Enter incorrect word') : t('请输入正确词', 'Enter correct word')} maxLength={4096}/></label>)}<Icon name="dictionary-arrow"/></div>
      <div className="tx-dictionary-editor-enabled"><Toggle checked={editor.entry.enabled} label={t('启用此词条', 'Enable this entry')} onChange={() => setEditor({ ...editor, entry: { ...editor.entry, enabled: !editor.entry.enabled } })}/></div>
      {validation && <p className="tx-dictionary-validation" role="alert">{validation}</p>}
    </Modal>}
    {deleting !== null && <Modal variant="dictionary-delete" title={t('删除这个词条？', 'Delete this entry?')} onClose={onBack} footer={<><button onClick={() => setDeleting(null)}>{t('取消', 'Cancel')}</button><button className="tx-danger" onClick={deleteCard}>{t('删除', 'Delete')}</button></>}><p>{t('删除后，这条固定纠正规则将不再生效。', 'After deletion, this fixed correction will no longer apply.')}</p><p className="tx-dictionary-delete-preview" title={`${entries[deleting]?.wrong} → ${entries[deleting]?.correct}`}>{entries[deleting]?.wrong} → {entries[deleting]?.correct}</p></Modal>}
  </section>;
}
