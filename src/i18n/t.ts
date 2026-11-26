import { en, type MessageKey } from './en.ts';

export type { MessageKey };

/** Looks up interface text and fills `{name}` placeholders. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return en[key].replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export const LANG = 'en';
