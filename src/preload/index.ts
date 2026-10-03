import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../shared/bridge';
const bridge: DesktopBridge = {
  platform: process.platform,
  command: (name, args = {}) => ipcRenderer.invoke('application:command', name, args),
  subscribe: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) =>
      listener(payload);
    ipcRenderer.on('application:event', handler);
    return () => {
      ipcRenderer.removeListener('application:event', handler);
    };
  },
  chooseDatabase: () => ipcRenderer.invoke('application:choose-database'),
};
contextBridge.exposeInMainWorld('desktop', bridge);
