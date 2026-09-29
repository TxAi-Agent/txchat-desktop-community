import type { Command } from '../shared/contracts';
import type { ProductCommand, ProductStage } from '../shared/product';

export interface ProductStageInput {
  launching: boolean;
  cloudConfigured: boolean;
  interruption: boolean;
  signedIn: boolean;
  demo: boolean;
  onboardingCompleted: boolean;
}

export function shouldRestoreCloudSession(cloudConfigured: boolean) {
  return cloudConfigured;
}

export async function restoreCloudAuthentication(cloudConfigured: boolean, restore: () => Promise<void>) {
  if (shouldRestoreCloudSession(cloudConfigured)) await restore();
}

export function productStage(input: ProductStageInput): ProductStage {
  if (input.launching) return 'launching';
  if (input.interruption) return 'interrupted';
  if (input.demo) return 'ready';
  if (!input.cloudConfigured) return 'setup-unavailable';
  if (!input.signedIn) return 'signed-out';
  return input.onboardingCompleted ? 'ready' : 'onboarding';
}

export function setupUnavailableCommandAllowed(command: Command) {
  if (['app-open', 'app-quit', 'menu-close', 'demo-enter', 'diagnostics-discard', 'diagnostics-done'].includes(command.type)) return true;
  return command.type === 'preferences' && command.mode === undefined && command.service === undefined;
}

export async function routeSetupUnavailableCommand(stage: ProductStage, command: Command, dispatch: (command: ProductCommand) => Promise<void>) {
  if (stage !== 'setup-unavailable') return false;
  if (!setupUnavailableCommandAllowed(command)) return true;
  if (command.type === 'demo-enter' || command.type === 'preferences' || command.type === 'diagnostics-discard' || command.type === 'diagnostics-done') {
    await dispatch(command);
    return true;
  }
  // Window lifecycle commands remain available through the normal IPC switch.
  // They cannot start services or mutate product state.
  return false;
}
