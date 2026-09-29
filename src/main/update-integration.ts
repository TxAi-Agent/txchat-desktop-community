import type { SoftwareUpdateBackend } from './software-update-coordinator';

/** Implement a platform-appropriate backend with artifact and signature verification.
 * The repository provides the update state machine but no release channel or signing identity.
 * Do not implement this as an unchecked download-and-execute operation.
 */
export function createUpdateBackend(): SoftwareUpdateBackend | null {
  return null;
}
