export const checklistToolId = 'workspace.save-checklist';

export interface ChecklistChange {
  readonly title: string;
  readonly destination: string;
  readonly content: string;
}

/** Project the exact approved create payload into a document preview. */
export function readChecklistChange(raw: string): ChecklistChange | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 3
    || !('title' in value) || typeof value.title !== 'string' || !value.title.trim()
    || !('destination' in value) || typeof value.destination !== 'string' || !value.destination.trim()
    || !('content' in value) || typeof value.content !== 'string') return null;
  return { title: value.title, destination: value.destination, content: value.content };
}
