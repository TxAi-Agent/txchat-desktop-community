import type { ProductSnapshot } from '../shared/product';
import type { NativeInputStatus } from '../shared/native-input';
import type { AudioStatus } from '../shared/native-audio';

type Step = ProductSnapshot['onboarding']['step'];
/** Advances permission steps from observed capabilities; voice completion remains explicit. */
export function onboardingStep(current: Step, microphone: AudioStatus | null, input: NativeInputStatus | null,
  voiceFinished: boolean): Step {
  // Wait for actual snapshots: a helper still starting does not prove denial.
  if (!microphone || !input) return current;
  if (!['granted', 'systemManaged'].includes(microphone.permission)) return 'microphone';
  if (!['granted', 'notRequired'].includes(input.accessibility) || !input.enabled) return 'accessibility';
  return voiceFinished ? 'complete' : 'voice-test';
}
