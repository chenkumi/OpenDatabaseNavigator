export interface SqlExportProgress {
  id: string;
  connectionId: string;
  database: string;
  includeData: boolean;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  bytes: number;
  tables: number;
  rows: number | null;
  currentTable?: string;
  error?: string;
}

export interface SqlExportOptions {
  includeData: boolean;
  signal: AbortSignal;
  timeout: number;
  write: (chunk: string) => Promise<void>;
  progress: (value: { tables: number; rows: number | null; currentTable?: string }) => void;
}
