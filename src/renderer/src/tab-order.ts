export const TAB_DRAG_TYPE = 'application/x-workspace-tab';
/** Move `id` next to `target`: before it when moving back, after it when moving forward. */
export function reorderTabs(ids: string[], id: string, target: string) {
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return undefined;
  const next = ids.filter((item) => item !== id);
  next.splice(next.indexOf(target) + (from < to ? 1 : 0), 0, id);
  return next;
}
