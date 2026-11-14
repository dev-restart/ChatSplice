export const PROJECT_ORDER_STORAGE_KEY = 'chatsplice.project-order.v1';

export type DropPlacement = 'before' | 'after';

/** Reads a saved order; anything that is not a list of unique strings is ignored. */
export function parseProjectOrder(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((entry): entry is string => typeof entry === 'string');
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * Sorts projects by the saved order. Projects the order does not know yet keep
 * their original relative order after the known ones, and saved ids whose
 * project no longer exists are simply skipped.
 */
export function applyProjectOrder<T extends { workspace_id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  const known = items
    .filter((item) => rank.has(item.workspace_id))
    .sort((left, right) => rank.get(left.workspace_id)! - rank.get(right.workspace_id)!);
  return [...known, ...items.filter((item) => !rank.has(item.workspace_id))];
}

export function moveProject(
  ids: readonly string[],
  movedId: string,
  targetId: string,
  placement: DropPlacement,
): string[] {
  if (movedId === targetId || !ids.includes(movedId) || !ids.includes(targetId)) return [...ids];
  const rest = ids.filter((id) => id !== movedId);
  const targetIndex = rest.indexOf(targetId);
  rest.splice(placement === 'before' ? targetIndex : targetIndex + 1, 0, movedId);
  return rest;
}

export function stepProject(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const next = index + delta;
  if (index === -1 || next < 0 || next >= ids.length) return [...ids];
  const result = [...ids];
  [result[index], result[next]] = [result[next]!, result[index]!];
  return result;
}
