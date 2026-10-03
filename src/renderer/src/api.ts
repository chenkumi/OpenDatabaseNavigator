import '../../shared/bridge';
export async function command<T = any>(name: string, args: unknown = {}): Promise<T> {
  const result = await window.desktop.command<T>(name, args);
  if (!result.success) throw new Error(result.error ?? 'Command failed.');
  return result.data as T;
}
