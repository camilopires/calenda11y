/** Field name → message. Order of insertion is the order shown in the error summary. */
export type FieldErrors = Record<string, string>;

/** The id of the control a field error links to. */
export const fieldId = (name: string): string => `f-${name.replace(/[^a-z0-9_-]/gi, '-')}`;
