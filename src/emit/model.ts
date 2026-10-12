import type { Diagnostic } from '../schema/model.js';

export interface PlannedFile {
  /** Relative portable basename; the emitter does not write it. */
  path: string;
  content: string;
}

export type EmissionResult =
  | { ok: true; files: PlannedFile[]; diagnostics: [] }
  | { ok: false; diagnostics: Diagnostic[] };
