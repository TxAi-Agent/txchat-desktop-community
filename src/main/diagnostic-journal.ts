import { DIAGNOSTIC_RETENTION_MS, parseDiagnosticEvent, type DiagnosticCategory, type DiagnosticCode, type DiagnosticEvent, type DiagnosticStage } from '../shared/diagnostics';
export type { DiagnosticCategory, DiagnosticStage, DiagnosticCode } from '../shared/diagnostics';
/** Strict in-memory event buffer. Upload consent belongs exclusively to DiagnosticRuntime. */
export class DiagnosticJournal {
  private events: DiagnosticEvent[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  record(category: DiagnosticCategory, stage: DiagnosticStage, code: DiagnosticCode) {
    const event = parseDiagnosticEvent({ occurredAt: new Date(this.now()).toISOString(), category, stage, code });
    this.events = [...this.events, event].filter((entry) => Date.parse(entry.occurredAt) >= this.now() - DIAGNOSTIC_RETENTION_MS).slice(-200);
  }
  recent(confirmedAt = this.now()): DiagnosticEvent[] {
    return this.events.filter((event) => Date.parse(event.occurredAt) >= this.now() - DIAGNOSTIC_RETENTION_MS && Date.parse(event.occurredAt) <= confirmedAt).slice(-20).map((event) => ({ ...event }));
  }
  clear() { this.events = []; }
}
