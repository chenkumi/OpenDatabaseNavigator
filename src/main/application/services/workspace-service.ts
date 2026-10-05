import { randomUUID } from 'node:crypto';
import type { Workspace, WorkspaceTab } from '../../../shared/types';
import type { Store } from './store';
import { EventBus } from '../events/event-bus';
import { matchesDroppedObject } from '../../../shared/drop-object';
import type { RenameObjectInput } from '../../../shared/rename-object';
const MAX_TABS = 100;
export class WorkspaceService {
  private state: Workspace;
  /** Coalesce disk writes of per-keystroke updates (enabled by the app, off for tests). */
  debounced = false;
  constructor(
    private store: Store<Workspace>,
    private events: EventBus,
    private sanitize: <T>(value: T) => T = (value) => value,
  ) {
    this.state = store.read();
    this.state.tabs = this.state.tabs.map((tab) => ({
      ...tab,
      dirty:
        tab.type === 'create'
          ? tab.dirty
          : ['index', 'trigger', 'table'].includes(tab.type) && !!tab.objectVersion,
    }));
  }
  /** Version 0 is implicit, so tabs that never had a result stay unchanged. */
  private versioned<T extends object>(tab: T, version: number): T {
    return version ? { ...tab, resultVersion: version } : tab;
  }
  private resultVersions = new Map<string, number>();
  private sentVersions = new Map<string, number>();
  get() {
    return structuredClone({
      ...this.state,
      tabs: this.state.tabs.map((tab) => this.versioned(tab, this.resultVersions.get(tab.id) ?? 0)),
    });
  }
  open(input: Omit<WorkspaceTab, 'id' | 'dirty' | 'selectedRows'>) {
    // Every tab keeps its view mounted; unbounded opens (for example from an agent)
    // would exhaust memory and make the tab strip unusable.
    if (this.state.tabs.length >= MAX_TABS)
      throw new Error(`At most ${MAX_TABS} tabs can be open. Close some tabs first.`);
    const tab: WorkspaceTab = { ...input, id: randomUUID(), dirty: false, selectedRows: [] };
    this.state.tabs.push(tab);
    this.state.activeTab = tab.id;
    this.state.activeConnection = tab.connectionId;
    this.changed(input.type === 'table' ? 'TableOpened' : 'TabCreated');
    return structuredClone(tab);
  }
  update(
    id: string,
    patch: Partial<
      Pick<WorkspaceTab, 'sql' | 'dirty' | 'title' | 'result' | 'selectedRows' | 'objectVersion'>
    >,
  ) {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab) throw new Error('Tab not found.');
    Object.assign(tab, patch);
    if ('result' in patch) this.resultVersions.set(id, (this.resultVersions.get(id) ?? 0) + 1);
    this.changed('WorkspaceChanged');
    // The (possibly large) result is delivered by events, not echoed to the caller.
    return structuredClone({ ...tab, result: undefined });
  }
  activate(id: string) {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab) throw new Error('Tab not found.');
    this.state.activeTab = id;
    this.state.activeConnection = tab.connectionId;
    this.changed('WorkspaceChanged');
  }
  close(id: string, discard = false, others = false) {
    const removed = this.state.tabs.filter((tab) => (others ? tab.id !== id : tab.id === id));
    if (!discard && removed.some((tab) => tab.dirty))
      throw new Error('Unsaved changes: save or explicitly discard before closing.');
    this.state.tabs = this.state.tabs.filter((tab) => !removed.includes(tab));
    if (!this.state.tabs.some((tab) => tab.id === this.state.activeTab))
      this.state.activeTab = this.state.tabs.at(-1)?.id;
    this.state.activeConnection = this.state.tabs.find(
      (tab) => tab.id === this.state.activeTab,
    )?.connectionId;
    this.changed('WorkspaceChanged');
  }
  closeConnection(connectionId: string, discard = false) {
    const tabs = this.state.tabs.filter((tab) => tab.connectionId === connectionId);
    if (!discard && tabs.some((tab) => tab.dirty))
      throw new Error('Unsaved changes: save or explicitly discard before closing.');
    this.state.tabs = this.state.tabs.filter((tab) => tab.connectionId !== connectionId);
    if (tabs.some((tab) => tab.id === this.state.activeTab))
      this.state.activeTab = this.state.tabs.at(-1)?.id;
    if (this.state.activeConnection === connectionId)
      this.state.activeConnection = this.state.tabs.find(
        (tab) => tab.id === this.state.activeTab,
      )?.connectionId;
    this.changed('WorkspaceChanged');
  }
  /** Drop every tab, including dirty ones; callers confirm discarding first. */
  reset() {
    this.state = { ...this.state, tabs: [], activeTab: undefined, activeConnection: undefined };
    this.changed('WorkspaceChanged');
  }
  reorder(ids: string[]) {
    if (
      new Set(ids).size !== this.state.tabs.length ||
      ids.length !== this.state.tabs.length ||
      ids.some((id) => !this.state.tabs.some((tab) => tab.id === id))
    )
      throw new Error('Invalid tab order.');
    this.state.tabs = ids.map((id) => this.state.tabs.find((tab) => tab.id === id)!);
    this.changed('WorkspaceChanged');
  }
  renamedObject(ref: RenameObjectInput, defaultSchema: string) {
    const retainedDrafts: string[] = [];
    this.state.tabs = this.state.tabs.map((tab) => {
      if (!matchesDroppedObject(tab, ref, defaultSchema)) return tab;
      // A draft created while DDL was running must never be discarded.
      if (tab.dirty) {
        retainedDrafts.push(tab.title);
        return tab;
      }
      const id = randomUUID();
      if (this.state.activeTab === tab.id) this.state.activeTab = id;
      return {
        ...tab,
        id,
        table: ref.kind === 'table' || ref.kind === 'view' ? ref.newName : tab.table,
        objectName: ref.kind === 'index' || ref.kind === 'trigger' ? ref.newName : tab.objectName,
        title:
          tab.type === 'table' || ref.kind === 'index' || ref.kind === 'trigger'
            ? ref.newName
            : tab.title,
        sql: '',
        objectVersion: undefined,
        result: undefined,
        selectedRows: [],
      };
    });
    this.changed('WorkspaceChanged');
    return retainedDrafts;
  }
  private persistTimer?: ReturnType<typeof setTimeout>;
  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    // Results can be large and may contain sensitive data; only persist tab metadata.
    this.store.write(
      this.sanitize({
        ...this.state,
        tabs: this.state.tabs.map(({ result, selectedRows, ...tab }) => ({
          ...tab,
          selectedRows: [],
        })),
      }),
    );
  }
  /** Write any pending debounced state; call before the process exits. */
  flush() {
    if (this.persistTimer) this.persist();
  }
  private changed(type: string) {
    // Editing sends an update per keystroke: coalesce those disk writes. Structural
    // changes (open, close, reorder) are still written immediately.
    if (type === 'WorkspaceChanged' && this.debounced) {
      this.persistTimer ??= setTimeout(() => {
        try {
          this.persist();
        } catch (error) {
          console.error('Workspace write failed:', (error as Error).message);
        }
      }, 300);
    } else this.persist();
    this.events.emit(type, this.snapshot());
  }
  /**
   * Event payload: every tab's result is up to thousands of rows, and each
   * keystroke emits one. A result is sent only when it changed since the last
   * event; the renderer keeps the previous one while `resultVersion` matches.
   */
  private snapshot(): Workspace {
    const sent = new Map<string, number>();
    const tabs = this.state.tabs.map((tab) => {
      const version = this.resultVersions.get(tab.id) ?? 0;
      sent.set(tab.id, version);
      const { result, ...rest } = tab;
      const include = result !== undefined && this.sentVersions.get(tab.id) !== version;
      return structuredClone(this.versioned(include ? { ...rest, result } : rest, version));
    });
    for (const id of this.resultVersions.keys()) if (!sent.has(id)) this.resultVersions.delete(id);
    this.sentVersions = sent;
    return { ...structuredClone({ ...this.state, tabs: [] }), tabs };
  }
}
