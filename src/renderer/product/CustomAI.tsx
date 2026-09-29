import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ASR_PROVIDERS, OPTIMIZATION_PROVIDERS, getProvider, type ProviderDescriptor } from '../../shared/custom-ai';
import type { CustomCategory, CustomSnapshot, Language, ProductError, PublicProviderConfiguration, ServiceChoice } from '../../shared/product';
import { customAlertCopy, customAlertForError, customCardModelName, customCardPosition, customSheetLayout, customTestFailure, customTestResultMatches, type CustomAlertKind } from '../../domain/custom-ai-presentation';
import { customDraftSubmission, parseCustomDraftRead, type CustomEditorDraft } from '../../shared/custom-ai-editor';
import { Icon, Modal, type Dispatch, type Translate } from './ui';
import { clearCustomAIDraftEnabled, readCustomAIDraftEnabled, writeCustomAIDraftEnabled } from './custom-ai-draft-session';
import './custom-ai.css';
type Draft = CustomEditorDraft;
type Editing = {
    category: CustomCategory;
    providerId: string;
};
type ProviderTest = {
    editorId: number;
    revision: number;
    version: number;
    phase: 'running' | 'passed' | 'failed';
    code: string | null;
};
const keyOf = (editing: Editing) => `${editing.category}:${editing.providerId}`;
const serialize = (draft: Draft) => JSON.stringify(draft);
const nameOf = (provider: ProviderDescriptor, t: Translate) => t(provider.nameZh, provider.nameEn);
function initialDraft(provider: ProviderDescriptor, config?: PublicProviderConfiguration): Draft {
    return { modelId: config?.modelId ?? provider.models[0].id, values: Object.fromEntries(provider.fields.map((field) => [field.id, field.secret ? '' : config?.values[field.id] ?? field.defaultValue ?? ''])) };
}
function validDraft(provider: ProviderDescriptor, draft: Draft, config?: PublicProviderConfiguration) {
    return provider.models.some((model) => model.id === draft.modelId) && provider.fields.every((field) => {
        const value = draft.values[field.id]?.trim();
        if (value && /[\p{Cc}\p{Cf}]/u.test(value))
            return false;
        if (field.id === 'endpoint-id' && value && !/^[A-Za-z0-9._-]{1,256}$/.test(value))
            return false;
        return !field.required || !!value || (field.secret && !!config?.configuredFields.includes(field.id));
    });
}
export function CustomAI({ snapshot, service, command, t, disabled, onBack, registerLeave, storageError = null }: {
    snapshot: CustomSnapshot;
    service: ServiceChoice;
    demo: boolean;
    command: Dispatch;
    t: Translate;
    disabled: boolean;
    onBack: () => void;
    registerLeave: (guard: ((leave: () => void) => void) | null) => void;
    storageError?: ProductError | null;
}) {
    const language = t('zh', 'en') as Language;
    const sessionStorage = window.sessionStorage;
    const [draftEnabled, setDraftEnabled] = useState(() => readCustomAIDraftEnabled(sessionStorage, service === 'custom'));
    const [applying, setApplying] = useState(false);
    const [editing, setEditing] = useState<Editing | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [baseline, setBaseline] = useState<Draft | null>(null);
    const [draftVersion, setDraftVersion] = useState(0);
    const [draftRevision, setDraftRevision] = useState(0);
    const [reading, setReading] = useState(false);
    const editorEpoch = useRef(0);
    const mounted = useRef(true);
    const currentVersion = useRef(snapshot.version);
    currentVersion.current = snapshot.version;
    const [leave, setLeave] = useState<(() => void) | null>(null);
    const [alert, setAlert] = useState<Exclude<CustomAlertKind, 'unsaved'> | null>(null);
    const [pendingSave, setPendingSave] = useState<{
        key: string;
        version: number;
        finished: boolean;
        leaveAction?: () => void;
    } | null>(null);
    const [testPending, setTestPending] = useState(false);
    const [testedDraft, setTestedDraft] = useState<{
        key: string;
        editorId: number;
        revision: number;
        version: number;
        afterGeneration: number;
        category: CustomCategory;
        providerId: string;
    } | null>(null);
    const [providerTests, setProviderTests] = useState<Record<string, ProviderTest>>({});
    const [globalTestVersion, setGlobalTestVersion] = useState<{
        version: number;
        enabled: boolean;
        afterGeneration: number;
    } | null>(null);
    const [globalDispatchFailure, setGlobalDispatchFailure] = useState(false);
    const configFor = (target: Editing) => snapshot.configurations[target.category].find((config) => config.providerId === target.providerId);
    const providerDirty = !!draft && !!baseline && serialize(draft) !== serialize(baseline);
    const dirty = providerDirty || draftEnabled !== (service === 'custom');
    const dirtyRef = useRef(dirty);
    dirtyRef.current = dirty;
    const running = testPending || snapshot.test.phase === 'running';
    const actionBusy = disabled || snapshot.busy || pendingSave !== null || applying;
    const busy = actionBusy || reading;
    const loadBlocked = customAlertForError(storageError?.code) === 'load-failed';
    const guardRef = useRef<(action: () => void) => void>(() => undefined);
    const committedLeave = useRef(false);
    guardRef.current = (action) => { if (committedLeave.current) {
        action();
        return;
    } if (busy || running)
        return; if (dirtyRef.current)
        setLeave(() => action);
    else
        action(); };
    useEffect(() => { writeCustomAIDraftEnabled(sessionStorage, draftEnabled); }, [draftEnabled, sessionStorage]);
    useEffect(() => {
        registerLeave((action) => guardRef.current(() => { clearCustomAIDraftEnabled(sessionStorage); action(); }));
        return () => registerLeave(null);
    }, [registerLeave, sessionStorage]);
    function clearEditor() {
        editorEpoch.current++;
        setReading(false);
        setDraft(null);
        setBaseline(null);
        setEditing(null);
        setTestedDraft(null);
        setProviderTests({});
        setTestPending(false);
        setPendingSave(null);
        setLeave(null);
    }
    useEffect(() => {
        mounted.current = true;
        let accountMarker: string | null = null;
        const unsubscribe = window.txchat.subscribe((app) => {
            const auth = app.product.auth;
            const marker = `${auth.demo}:${auth.maskedPhone ?? ''}`;
            if (app.product.stage !== 'ready' || app.product.page !== 'custom-ai' || (!auth.signedIn && !auth.demo) || auth.busy || auth.interruption || accountMarker !== null && marker !== accountMarker)
                clearEditor();
            accountMarker = marker;
        });
        const stopInvalidation = window.txchat.onCustomDraftInvalidated(() => flushSync(clearEditor));
        return () => { mounted.current = false; editorEpoch.current++; unsubscribe(); stopInvalidation(); };
    }, []);
    useEffect(() => { if (disabled)
        clearEditor(); }, [disabled]);
    useEffect(() => {
        if (editing && !reading && !pendingSave && snapshot.version !== draftVersion) {
            clearEditor();
            setAlert('load-failed');
        }
    }, [snapshot.version, draftVersion, editing, reading, pendingSave]);
    useEffect(() => {
        if (loadBlocked)
            setAlert('load-failed');
        else if ((['asr', 'optimization'] as const).some((category) => snapshot.selected[category] && !getProvider(category, snapshot.selected[category])))
            setAlert('unsupported');
    }, [loadBlocked, snapshot.selected.asr, snapshot.selected.optimization]);
    useEffect(() => {
        if (!testedDraft || testedDraft.editorId !== editorEpoch.current || testedDraft.revision !== draftRevision || !customTestResultMatches(snapshot.test, testedDraft, snapshot.version) || !['passed', 'failed'].includes(snapshot.test.phase))
            return;
        setProviderTests((old) => ({ ...old, [testedDraft.key]: { ...testedDraft, phase: snapshot.test.phase as 'passed' | 'failed', code: snapshot.test.code } }));
    }, [testedDraft, snapshot.test.phase, snapshot.test.category, snapshot.test.providerId, snapshot.test.configurationVersion, snapshot.test.generation, snapshot.test.code, snapshot.version, draftRevision]);
    useEffect(() => {
        if (!pendingSave?.finished)
            return;
        if (snapshot.version > pendingSave.version && !snapshot.error) {
            const leaveAction = pendingSave.leaveAction;
            clearEditor();
            setPendingSave(null);
            setGlobalTestVersion(null);
            if (leaveAction)
                void savePage(leaveAction, true);
        }
        else if (!snapshot.busy) {
            setPendingSave(null);
            setAlert(customAlertForError(snapshot.error?.code) ?? 'save-failed');
        }
    }, [pendingSave, snapshot.version, snapshot.error, snapshot.busy]);
    const invalidateTests = () => { setTestedDraft(null); setProviderTests({}); setGlobalTestVersion(null); setGlobalDispatchFailure(false); };
    const requestCloseProvider = () => { if (!editing || actionBusy || running)
        return; clearEditor(); invalidateTests(); setAlert(null); };
    const open = async (category: CustomCategory, providerId: string) => {
        if (busy || running || !draftEnabled || loadBlocked)
            return;
        const next = { category, providerId };
        const provider = getProvider(category, providerId);
        if (!provider) {
            setAlert('unsupported');
            return;
        }
        clearEditor();
        const epoch = editorEpoch.current;
        setEditing(next);
        setDraft(initialDraft(provider));
        setBaseline(null);
        setReading(true);
        setAlert(null);
        try {
            const reply = await window.txchat.readCustomDraft(category, providerId);
            if (!mounted.current || epoch !== editorEpoch.current)
                return;
            const result = parseCustomDraftRead(reply, next);
            if (result.version !== currentVersion.current) {
                clearEditor();
                setAlert('load-failed');
                return;
            }
            const value = { modelId: result.modelId, values: result.values };
            setDraft(value);
            setBaseline(value);
            setDraftVersion(result.version);
            setDraftRevision(0);
            setReading(false);
        }
        catch {
            if (mounted.current && epoch === editorEpoch.current) {
                clearEditor();
                setAlert('load-failed');
            }
        }
    };
    const patch = (change: Partial<Draft>) => {
        if (!editing || !draft || busy || running)
            return;
        setDraft({ ...draft, ...change });
        setDraftRevision((revision) => revision + 1);
        setProviderTests({});
        setTestedDraft(null);
        setGlobalTestVersion(null);
        setGlobalDispatchFailure(false);
        setAlert(null);
    };
    const saveProvider = async (select: boolean, leaveAction?: () => void) => {
        if (!editing || !draft || busy || running || loadBlocked)
            return;
        const epoch = editorEpoch.current;
        const key = keyOf(editing), provider = getProvider(editing.category, editing.providerId)!;
        if (!validDraft(provider, draft)) {
            setAlert('incomplete');
            return;
        }
        setAlert(null);
        setPendingSave({ key, version: snapshot.version, finished: false, leaveAction });
        try {
            await command({ type: 'custom-save', ...editing, ...customDraftSubmission(provider, draft), select });
            if (mounted.current && epoch === editorEpoch.current)
                setPendingSave((old) => old ? { ...old, finished: true } : null);
        }
        catch {
            if (mounted.current && epoch === editorEpoch.current) {
                setPendingSave(null);
                setAlert('save-failed');
            }
        }
    };
    const testProvider = async () => {
        if (!editing || !draft || busy || running || loadBlocked)
            return;
        const epoch = editorEpoch.current;
        const key = keyOf(editing);
        const request = { key, ...editing, editorId: epoch, revision: draftRevision, version: draftVersion, afterGeneration: snapshot.test.generation };
        setTestedDraft(request);
        setProviderTests((old) => ({ ...old, [key]: { ...request, phase: 'running', code: null } }));
        setTestPending(true);
        try {
            await command({ type: 'custom-test', ...editing, ...customDraftSubmission(getProvider(editing.category, editing.providerId)!, draft) });
        }
        catch {
            if (mounted.current && epoch === editorEpoch.current) {
                setTestedDraft(null);
                setProviderTests((old) => ({ ...old, [key]: { ...request, phase: 'failed', code: null } }));
            }
        }
        finally {
            if (mounted.current && epoch === editorEpoch.current)
                setTestPending(false);
        }
    };
    async function savePage(after: () => void = onBack, afterProvider = false) {
        if ((!afterProvider && (busy || running || providerDirty)) || loadBlocked)
            return;
        if (draftEnabled && (['asr', 'optimization'] as const).some((category) => {
            const target = { category, providerId: snapshot.selected[category] };
            const provider = getProvider(category, target.providerId);
            const config = configFor(target);
            return !provider || !config || !validDraft(provider, initialDraft(provider, config), config);
        })) {
            setAlert('incomplete');
            return;
        }
        setApplying(true);
        setAlert(null);
        try {
            await command({ type: 'custom-apply', enabled: draftEnabled });
            dirtyRef.current = false;
            clearCustomAIDraftEnabled(sessionStorage);
            committedLeave.current = true;
            try {
                after();
            }
            finally {
                committedLeave.current = false;
            }
        }
        catch {
            setAlert('save-failed');
        }
        finally {
            setApplying(false);
        }
    }
    const testAll = async () => {
        if (busy || running || !draftEnabled || loadBlocked)
            return;
        setGlobalTestVersion({ version: snapshot.version, enabled: draftEnabled, afterGeneration: snapshot.test.generation });
        setGlobalDispatchFailure(false);
        setTestPending(true);
        try {
            await command({ type: 'custom-test', category: 'all' });
        }
        catch {
            setGlobalDispatchFailure(true);
        }
        finally {
            setTestPending(false);
        }
    };
    const discardPage = () => {
        const action = leave;
        setLeave(null);
        clearEditor();
        invalidateTests();
        setDraftEnabled(service === 'custom');
        dirtyRef.current = false;
        clearCustomAIDraftEnabled(sessionStorage);
        action?.();
    };
    const saveAndLeave = () => {
        const action = leave;
        if (!action)
            return;
        setLeave(null);
        if (editing && providerDirty)
            void saveProvider(false, action);
        else
            void savePage(action);
    };
    const provider = editing ? getProvider(editing.category, editing.providerId)! : null;
    const currentTest = editing ? providerTests[keyOf(editing)] : undefined;
    const draftTestCurrent = !!draft && !!currentTest && currentTest.editorId === editorEpoch.current && currentTest.revision === draftRevision && currentTest.version === snapshot.version;
    const providerPhase = draftTestCurrent && currentTest ? currentTest.phase === 'running' && !running ? 'idle' : currentTest.phase : 'idle';
    const providerResult = providerPhase === 'running' ? t('正在测试…', 'Testing…') : providerPhase === 'passed' ? t('测试通过', 'Test passed') : providerPhase === 'failed' ? customTestFailure(currentTest?.code ?? null, language) : t('尚未测试', 'Not tested');
    const allTestCurrent = globalTestVersion?.version === snapshot.version && globalTestVersion.enabled === draftEnabled && !providerDirty;
    const allBackendCurrent = !!globalTestVersion && customTestResultMatches(snapshot.test, { ...globalTestVersion, category: 'all', providerId: null }, snapshot.version);
    const allPhase = allTestCurrent ? globalDispatchFailure ? 'failed' : testPending && !editing ? 'running' : allBackendCurrent ? snapshot.test.phase : 'idle' : 'idle';
    const selectedNames = (['asr', 'optimization'] as const).map((category) => { const value = getProvider(category, snapshot.selected[category]); return value ? nameOf(value, t) : ''; }).filter(Boolean).join(' · ');
    const footerStatus = allPhase === 'running' ? t('正在测试…', 'Testing…') : allPhase === 'passed' ? t('整体测试通过', 'All tests passed') : allPhase === 'failed' ? t('测试未通过，请检查所选服务配置', 'Test failed. Check the selected service settings') : draftEnabled ? `${t('已选择：', 'Selected: ')}${selectedNames}` : t('当前使用 TxChat 云服务', 'Using TxChat Cloud Service');
    const renderProviders = (category: CustomCategory, providers: ProviderDescriptor[]) => providers.map((item, index) => {
        const target = { category, providerId: item.id };
        const config = configFor(target);
        const storedDraft = initialDraft(item, config);
        const isCurrentEditor = !!editing && keyOf(editing) === keyOf(target) && !reading;
        const cardDraft = isCurrentEditor && draft ? draft : storedDraft;
        const configured = isCurrentEditor ? validDraft(item, cardDraft) : !!config && validDraft(item, cardDraft, config);
        const feedback = providerTests[keyOf(target)];
        const failed = feedback?.version === snapshot.version && feedback.editorId === editorEpoch.current && feedback.revision === draftRevision && feedback.phase === 'failed';
        const model = customCardModelName(item.models.find((model) => model.id === cardDraft.modelId), language);
        const detail = configured || failed ? `${model} · ${failed ? t('配置异常', 'Configuration issue') : t('已配置', 'Configured')}` : t('点击配置', 'Configure');
        return <button key={`${category}:${item.id}`} type="button" className={`tx-ca-card${snapshot.selected[category] === item.id && draftEnabled ? ' is-selected' : ''}${!draftEnabled ? ' is-off' : ''}`} style={customCardPosition(category, index)} disabled={!draftEnabled || busy || running || loadBlocked} onClick={() => void open(category, item.id)} aria-label={`${nameOf(item, t)} · ${detail}`}>
      <span className="tx-ca-logo"><Icon name={item.id}/></span><span className="tx-ca-provider-copy"><strong>{nameOf(item, t)}</strong><FittedDetail text={detail} tone={failed ? 'failed' : configured ? 'passed' : 'idle'}/></span>
    </button>;
    });
    const sheet = provider ? customSheetLayout(provider.fields.length) : null;
    const editingSelected = !!editing && snapshot.selected[editing.category] === editing.providerId;
    const shownAlert = alert ?? (leave ? 'unsaved' : null);
    const alertCopy = shownAlert ? customAlertCopy(shownAlert, language) : null;
    return <section className="tx-page tx-custom-ai tx-ca-page" aria-label={t('AI 识别模型', 'Recognition Model')}>
    <h1 className="tx-ca-title">{t('AI 识别模型', 'Recognition Model')}</h1><p className="tx-ca-description">{t('开启后将使用自定义模型服务', 'Turn on to use custom model services')}</p>
    <button className={`tx-ca-toggle${draftEnabled ? ' is-on' : ''}`} type="button" role="switch" aria-label={t('使用自定义模型服务', 'Use custom model services')} aria-checked={draftEnabled} disabled={busy || running || loadBlocked} onClick={() => { invalidateTests(); setDraftEnabled(!draftEnabled); }}><span /></button>
    <h2 className="tx-ca-section-title tx-ca-asr-title">{t('语音识别服务', 'Speech Recognition')}</h2><h2 className="tx-ca-section-title tx-ca-optimization-title">{t('内容优化服务', 'Content Optimization')}</h2>
    {renderProviders('asr', ASR_PROVIDERS)}{renderProviders('optimization', OPTIMIZATION_PROVIDERS)}
    <div className={`tx-ca-status ${allPhase === 'passed' || allPhase === 'failed' ? `is-${allPhase}` : draftEnabled ? 'is-selected' : ''}`} role="status"><span className={`tx-ca-dot${draftEnabled ? ' is-selected' : ''}`}/><span>{footerStatus}</span></div>
    <button className="tx-ca-action tx-ca-test-all" disabled={busy || running || !draftEnabled || loadBlocked} title={t('使用内置测试音频，依次测试识别和内容优化，无需说话。', 'Uses built-in test audio to test recognition and optimization. No microphone recording is required.')} onClick={() => void testAll()}>{allPhase === 'running' ? t('正在测试…', 'Testing…') : t('测试', 'Test')}</button>
    <button className="tx-ca-action tx-ca-cancel" disabled={busy || running} onClick={() => guardRef.current(() => { clearCustomAIDraftEnabled(sessionStorage); onBack(); })}>{t('取消', 'Cancel')}</button>
    <button className="tx-ca-action tx-ca-primary tx-ca-save" disabled={busy || running || !dirty || providerDirty || loadBlocked} onClick={() => void savePage()}>{t('保存', 'Save')}</button>
    {editing && provider && draft && sheet && <Modal variant="custom-provider" focusReady={!reading} title={t(`配置 ${nameOf(provider, t)}`, nameOf(provider, t))} onClose={requestCloseProvider} footer={<div className={`tx-ca-sheet-actions${editingSelected ? ' is-selected' : ''}`}>
      <div className={`tx-ca-test-result is-${providerPhase}`} role="status"><span className="tx-ca-dot"/><span>{providerResult}</span></div>
      <button className="tx-ca-action tx-ca-provider-test" disabled={busy || running || loadBlocked} onClick={() => void testProvider()}>{providerPhase === 'running' ? t('正在测试…', 'Testing…') : t('测试配置', 'Test')}</button>
      <button className="tx-ca-action tx-ca-provider-cancel" disabled={actionBusy || running} onClick={requestCloseProvider}>{t('取消', 'Cancel')}</button>
      <button className={`tx-ca-action tx-ca-provider-save${editingSelected ? ' tx-ca-primary' : ''}`} disabled={busy || running || loadBlocked} onClick={() => void saveProvider(false)}>{t('保存', 'Save')}</button>
      {!editingSelected && <button className="tx-ca-action tx-ca-primary tx-ca-provider-use" disabled={busy || running || loadBlocked} onClick={() => void saveProvider(true)}>{t('保存并启用', 'Save & Use')}</button>}
    </div>}>
      <div className="tx-ca-provider-fields" data-fields={provider.fields.length} data-sheet-height={sheet.height}>
        {provider.fields.map((field, fieldIndex) => {
                const label = field.id === 'endpoint-id' ? t('Endpoint ID（可选）', 'Endpoint ID (optional)') : field.label;
                return <div className="tx-ca-field" key={field.id}><label htmlFor={`tx-ca-${field.id}`}>{label}</label><div className="tx-ca-input-wrap">
            <input id={`tx-ca-${field.id}`} data-initial-focus={fieldIndex === 0 ? 'true' : undefined} type={field.secret ? 'password' : 'text'} spellCheck={false} autoCapitalize="off" autoComplete="off" maxLength={16384} disabled={busy || running} value={draft.values[field.id] ?? ''} placeholder={t(`请输入${label}`, `Enter ${label}`)} onChange={(event) => patch({ values: { ...draft.values, [field.id]: event.target.value } })}/>
          </div></div>;
            })}
        <div className="tx-ca-field"><span className="tx-ca-field-label" id="tx-ca-model-label">{t('模型', 'Model')}</span><ModelPicker provider={provider} modelId={draft.modelId} disabled={busy || running} t={t} onChange={(modelId) => patch({ modelId })}/></div>
      </div>
    </Modal>}
    {shownAlert && alertCopy && <Modal variant="custom-alert" title={alertCopy.title} onClose={() => { if (!busy && !running) {
            setAlert(null);
            setLeave(null);
        } }} footer={<>
      {shownAlert === 'unsaved' && <><button className="tx-ca-action tx-ca-alert-keep" disabled={busy || running} onClick={() => setLeave(null)}>{t('继续编辑', 'Keep Editing')}</button><button className="tx-ca-action tx-ca-alert-discard" disabled={busy || running} onClick={discardPage}>{t('不保存', 'Don’t Save')}</button></>}
      <button className="tx-ca-action tx-ca-primary tx-ca-alert-save" disabled={busy || running} onClick={shownAlert === 'unsaved' ? saveAndLeave : () => { setAlert(null); setLeave(null); }}>{shownAlert === 'unsaved' ? t('保存', 'Save') : t('继续编辑', 'Keep Editing')}</button>
    </>}><p className="tx-ca-alert-copy">{alertCopy.body}</p></Modal>}
  </section>;
}
function FittedDetail({ text, tone }: {
    text: string;
    tone: string;
}) {
    const ref = useRef<HTMLElement>(null);
    useLayoutEffect(() => {
        let disposed = false;
        const fit = () => { const element = ref.current; if (!element || disposed)
            return; element.style.fontSize = '11px'; if (element.scrollWidth > element.clientWidth)
            element.style.fontSize = `${Math.max(8.25, 11 * element.clientWidth / element.scrollWidth)}px`; };
        fit();
        void document.fonts.ready.then(fit);
        const observer = new ResizeObserver(fit);
        if (ref.current)
            observer.observe(ref.current);
        return () => { disposed = true; observer.disconnect(); };
    }, [text]);
    return <small ref={ref} className={`is-${tone}`}>{text}</small>;
}
function ModelPicker({ provider, modelId, disabled, t, onChange }: {
    provider: ProviderDescriptor;
    modelId: string;
    disabled: boolean;
    t: Translate;
    onChange: (id: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    const options = useRef<(HTMLButtonElement | null)[]>([]);
    const selectedIndex = Math.max(0, provider.models.findIndex((model) => model.id === modelId));
    useEffect(() => { if (disabled)
        setOpen(false); }, [disabled]);
    useEffect(() => {
        if (!open)
            return;
        options.current[selectedIndex]?.focus();
        const outside = (event: PointerEvent) => { if (event.target instanceof Node && !ref.current?.contains(event.target))
            setOpen(false); };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open, selectedIndex]);
    const model = provider.models.find((item) => item.id === modelId);
    const label = model ? t(model.nameZh, model.nameEn) : '';
    if (provider.models.length === 1)
        return <div className="tx-ca-model-static" aria-labelledby="tx-ca-model-label">{label}</div>;
    return <div className="tx-ca-model-picker" ref={ref} onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                button.current?.focus();
            }
            if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                const current = options.current.findIndex((item) => item === document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? provider.models.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + provider.models.length) % provider.models.length;
                options.current[next]?.focus();
            }
        }}><button className="tx-ca-model-trigger" ref={button} type="button" aria-labelledby="tx-ca-model-label" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (!open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
    } }}><span>{label}</span><span className="tx-ca-chevron" aria-hidden="true"/></button>
    {open && <div className="tx-ca-model-options" role="listbox" aria-labelledby="tx-ca-model-label">{provider.models.map((item, index) => <button key={item.id} ref={(element) => { options.current[index] = element; }} type="button" role="option" aria-selected={item.id === modelId} tabIndex={-1} onClick={() => { onChange(item.id); setOpen(false); button.current?.focus(); }}><span>{t(item.nameZh, item.nameEn)}</span>{item.id === modelId && <span className="tx-ca-model-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}
