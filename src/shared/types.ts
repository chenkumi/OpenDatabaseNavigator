import type { ConstraintChange, ConstraintCapabilities, TableConstraint } from './constraints';
import type { ColumnProperties, PropertyChange, TableProperties } from './structure-properties';
import type { Generation, GeneratedChange, GenerationCapabilities } from './generated-columns';
import type { ViewOptions, ViewCapabilities } from './view-options';
import type { IndexOptions, IndexCapabilities } from './index-options';
/** Nonsecret diagnostics only; backend is observed, not inferred from a candidate. */
export interface SecureStorageStatus {
  platform: string;
  backend: string;
  available: boolean;
  selectionSource: 'explicit' | 'native' | 'wsl-libsecret';
  /** Unavailable deliberately does not guess whether a keyring is missing or locked. */
  reason: 'not-checked' | 'available' | 'unavailable' | 'basic-text' | 'restart-required';
  restartRequired: boolean;
}
export type Engine = 'sqlite' | 'mysql' | 'postgres' | 'sqlserver' | 'redis' | 'sybase';
export type AgentAccess = 'disabled' | 'read' | 'write';
export type AgentLevel = 'observe' | 'assist' | 'execute';
export interface Connection {
  id: string;
  name: string;
  engine: Engine;
  host?: string;
  port?: number;
  username?: string;
  sqlServerAuth?: 'sql' | 'windows';
  /** Explicit Windows service principal, required when relaying native TCP I/O. */
  sqlServerSpn?: string;
  database: string;
  group: string;
  favorite: boolean;
  color: string;
  agentAccess: AgentAccess;
  tls: boolean;
  connectionTimeout?: number;
  /** Seconds between completed keepalive probes; zero disables probes. */
  heartbeatInterval?: number;
  readTimeout?: number;
  writeTimeout?: number;
  charset?: string;
  /** Optional trusted native PostgreSQL client executable selected by the desktop user. */
  pgDumpPath?: string;
  /** Native PowerShell host with SqlServer/SQLPS installed, selected by the desktop. */
  sqlServerPowerShellPath?: string;
  aseDriver?: string;
  aseTrustedFile?: string;
  aseJavaPath?: string;
  aseDdlgenPath?: string;
  aseJconnectPath?: string;
}
export interface Column {
  generated?: boolean;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: unknown;
  primaryKey: boolean;
}
export interface TableRef {
  database?: string;
  schema?: string;
  table: string;
}
export interface DatabaseObject {
  name: string;
  schema: string;
  table: string;
  kind: 'index' | 'trigger';
  definition?: string;
}
export interface DatabaseObjectDefinition extends DatabaseObject {
  indexOptions?: IndexOptions;
  indexCapabilities?: IndexCapabilities;
  mysqlNoBackslashEscapes?: boolean;
  engine: Engine;
  version: string;
  editableSql: string;
  readOnlyReason?: string;
  notice: string;
}
export interface DatabaseObjectPlan {
  statements: string[];
  atomic: boolean;
  notice: string;
}
export interface TableInfo {
  name: string;
  schema: string;
  kind: 'table' | 'view';
}
export interface StructureColumn extends Column {
  generation?: Generation;
  defaultSql: string;
  generated?: boolean;
  properties?: ColumnProperties;
  commentExists?: boolean;
}
export interface TableStructure {
  viewOptions?: ViewOptions;
  viewCapabilities?: ViewCapabilities;
  generationCapabilities?: GenerationCapabilities;
  kind: 'table' | 'view';
  engine: Engine;
  schema: string;
  table: string;
  columns: StructureColumn[];
  definition: string;
  version: string;
  readOnlyReason?: string;
  constraints?: TableConstraint[];
  constraintCapabilities?: ConstraintCapabilities;
  properties?: TableProperties;
  commentExists?: boolean;
  mysqlNoBackslashEscapes?: boolean;
}
export type ColumnPropertyChange =
  | { action: 'rename'; column: string; name: string }
  | { action: 'type'; column: string; type: string }
  | { action: 'nullable'; column: string; nullable: boolean }
  | { action: 'default'; column: string; defaultSql: string };
export type StructureChange =
  | { action: 'view-options'; options: ViewOptions }
  | GeneratedChange
  | PropertyChange
  | ConstraintChange
  | ColumnPropertyChange
  | { action: 'edit-columns'; changes: ColumnPropertyChange[]; primaryKey?: string[] }
  | {
      action: 'add';
      name: string;
      type: string;
      nullable: boolean;
      defaultSql: string;
      primaryKey?: boolean;
    }
  | { action: 'drop'; column: string }
  | { action: 'primary-key'; columns: string[] }
  | { action: 'view'; sql: string };
export interface StructurePlan {
  statements: string[];
  atomic: boolean;
  destructive: boolean;
  rebuildTable?: string;
  recoveryStatements?: string[];
  notice?: string;
}
export interface QueryResult {
  success: true;
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  affectedRows: number;
  duration: number;
  hasMore: boolean;
  nextCursor?: string;
}
export type FilterOperator =
  '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL';
export interface Filter {
  column: string;
  operator: FilterOperator;
  value?: unknown;
}
export interface SelectInput extends TableRef {
  columns?: string[];
  filters?: Filter[];
  sort?: { column: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}
export interface Actor {
  kind: 'human' | 'agent';
  id: string;
  name: string;
}
export interface WorkspaceTab {
  objectName?: string;
  objectVersion?: string;
  id: string;
  type: 'query' | 'table' | 'redis' | 'index' | 'trigger' | 'create';
  createKind?: 'table' | 'view' | 'index' | 'trigger';
  title: string;
  connectionId: string;
  database?: string;
  schema?: string;
  table?: string;
  sql: string;
  dirty: boolean;
  result?: QueryResult;
  /** Bumps whenever `result` is replaced, so a change event can leave an unchanged result out. */
  resultVersion?: number;
  selectedRows: unknown[];
}
export interface Workspace {
  tabs: WorkspaceTab[];
  activeTab?: string;
  activeConnection?: string;
}
export type PolicyDecision = 'allow' | 'ask' | 'deny';
export interface Settings {
  theme: 'light' | 'dark' | 'system';
  language: 'en' | 'zh-TW';
  pageSize: number;
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  queryTimeout: number;
  maxRows: number;
  agentLevel: AgentLevel;
  policy: {
    insert: PolicyDecision;
    update: PolicyDecision;
    delete: PolicyDecision;
    ddl: PolicyDecision;
    destructive: PolicyDecision;
  };
  mcp: {
    enabled: boolean;
    host: string;
    port: number;
    remote: boolean;
    allowedHosts: string[];
    tlsCert: string;
    tlsKey: string;
  };
}
export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  language: 'zh-TW',
  pageSize: 500,
  fontSize: 14,
  tabSize: 2,
  wordWrap: false,
  queryTimeout: 30000,
  maxRows: 5000,
  agentLevel: 'assist',
  policy: { insert: 'ask', update: 'ask', delete: 'ask', ddl: 'deny', destructive: 'deny' },
  mcp: {
    enabled: false,
    host: '127.0.0.1',
    port: 7799,
    remote: false,
    allowedHosts: ['localhost', '127.0.0.1'],
    tlsCert: '',
    tlsKey: '',
  },
};
export type Risk = 'read' | 'workspace' | 'insert' | 'update' | 'delete' | 'ddl' | 'destructive';
export interface AuditEntry {
  id: string;
  timestamp: string;
  actor: Actor;
  command: string;
  connectionId?: string;
  database?: string;
  summary: string;
  sql?: string;
  status: 'success' | 'error' | 'pending' | 'denied';
  duration: number;
  result?: string;
  approvalId?: string;
}
export interface Approval {
  id: string;
  actor: Actor;
  command: string;
  connectionId?: string;
  args: Record<string, unknown>;
  risk: Risk;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}
export interface AppEvent {
  type: string;
  payload?: unknown;
}
export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  approvalId?: string;
}
