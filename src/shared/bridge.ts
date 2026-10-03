import type { AppEvent, CommandResult } from './types';
export interface DesktopBridge {
  platform: string;
  command<T = unknown>(name: string, args?: unknown): Promise<CommandResult<T>>;
  subscribe(listener: (event: AppEvent) => void): () => void;
  chooseDatabase(): Promise<string | undefined>;
}
declare global {
  interface Window {
    desktop: DesktopBridge;
  }
}
