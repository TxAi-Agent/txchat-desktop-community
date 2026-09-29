import type { DictationSnapshot } from '../shared/contracts';
import type { ServiceChoice } from '../shared/product';

const USAGE_TERMINAL_PHASES = new Set<DictationSnapshot['phase']>(['completed', 'resultFallback']);

export function cloudUsageRefreshGeneration(
  state: Pick<DictationSnapshot, 'phase' | 'generation'>,
  service: ServiceChoice,
  lastGeneration: number | null,
): number | null {
  if (service !== 'cloud' || !USAGE_TERMINAL_PHASES.has(state.phase) || state.generation === lastGeneration) return null;
  return state.generation;
}
