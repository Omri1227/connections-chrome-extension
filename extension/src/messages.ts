// Messages between the content script / popup and the background service worker.
import type { AnalysisView } from './ui/Panel.tsx';
import type { ConnectionInput } from './core/types.ts';

/** `passenger`: EES status for passport-control times, kept in local storage only (never sent to any server). */
export interface Settings { serverUrl: string; token: string; passenger?: 'ees-exempt' | 'ees-registered' }
export const DEFAULT_SETTINGS: Settings = { serverUrl: 'http://127.0.0.1:8790', token: '' };

export type Request =
  | { type: 'analyze'; connections: ConnectionInput[]; today: string }
  | { type: 'test-server' };

export type Response =
  | { type: 'analysis'; views: AnalysisView[] }
  | { type: 'server'; ok: boolean; detail: string }
  | { type: 'error'; detail: string };

/** Origin pattern for the optional host permission of a server URL (any port). */
export const originPattern = (serverUrl: string) => { const u = new URL(serverUrl); return `${u.protocol}//${u.hostname}/*`; };
