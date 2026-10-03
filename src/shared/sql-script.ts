export const SQL_FILE_LIMIT = 16 * 1024 * 1024;
export interface ScriptUnit {
  sql: string;
  line: number;
}
export interface ScriptProgress {
  id: string;
  connectionId: string;
  database: string;
  fileName: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  total: number;
  completed: number;
  failed: number;
  currentLine?: number;
  error?: string;
  results: { index: number; line: number; success: boolean; error?: string; duration: number }[];
}
