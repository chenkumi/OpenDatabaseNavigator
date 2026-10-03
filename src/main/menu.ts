import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

export function installMenu(language: string) {
  const zh = language === 'zh-TW';
  const mac = process.platform === 'darwin';
  const action = (payload: 'create-connection' | 'settings') => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    window?.webContents.send('application:event', { type: 'DesktopAction', payload });
  };
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const, label: zh ? `關於 ${app.name}` : `About ${app.name}` },
              { type: 'separator' as const },
              { role: 'services' as const, label: zh ? '服務' : 'Services' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: zh ? `隱藏 ${app.name}` : `Hide ${app.name}` },
              { role: 'hideOthers' as const, label: zh ? '隱藏其他程式' : 'Hide Others' },
              { role: 'unhide' as const, label: zh ? '顯示全部' : 'Show All' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: zh ? `結束 ${app.name}` : `Quit ${app.name}` },
            ],
          },
        ]
      : []),
    {
      label: zh ? '檔案' : 'File',
      submenu: [
        {
          id: 'create-connection',
          label: zh ? '新增連線' : 'Create Connection',
          click: () => action('create-connection'),
        },
        { id: 'settings', label: zh ? '設定' : 'Settings', click: () => action('settings') },
        { type: 'separator' },
        { role: 'minimize', label: zh ? '最小化' : 'Minimize' },
        { role: 'close', label: zh ? '關閉' : 'Close' },
      ],
    },
    // Aggregate Electron roles generate labels from Electron/OS defaults instead
    // of the application's saved language. Keep action roles, but label every item.
    {
      label: zh ? '編輯' : 'Edit',
      submenu: [
        { role: 'undo', label: zh ? '復原' : 'Undo' },
        { role: 'redo', label: zh ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: zh ? '剪下' : 'Cut' },
        { role: 'copy', label: zh ? '複製' : 'Copy' },
        { role: 'paste', label: zh ? '貼上' : 'Paste' },
        ...(mac
          ? [
              {
                role: 'pasteAndMatchStyle' as const,
                label: zh ? '貼上並符合樣式' : 'Paste and Match Style',
              },
            ]
          : []),
        { role: 'delete', label: zh ? '刪除' : 'Delete' },
        { type: 'separator' },
        { role: 'selectAll', label: zh ? '全選' : 'Select All' },
        ...(mac
          ? [
              { type: 'separator' as const },
              {
                label: zh ? '語音' : 'Speech',
                submenu: [
                  { role: 'startSpeaking' as const, label: zh ? '開始朗讀' : 'Start Speaking' },
                  { role: 'stopSpeaking' as const, label: zh ? '停止朗讀' : 'Stop Speaking' },
                ],
              },
            ]
          : []),
      ],
    },
    {
      label: zh ? '檢視' : 'View',
      submenu: [
        { role: 'reload', label: zh ? '重新載入' : 'Reload' },
        { role: 'forceReload', label: zh ? '強制重新載入' : 'Force Reload' },
        { role: 'toggleDevTools', label: zh ? '切換開發人員工具' : 'Toggle Developer Tools' },
        { type: 'separator' },
        { role: 'resetZoom', label: zh ? '實際大小' : 'Actual Size' },
        { role: 'zoomIn', label: zh ? '放大' : 'Zoom In' },
        { role: 'zoomOut', label: zh ? '縮小' : 'Zoom Out' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: zh ? '切換全螢幕' : 'Toggle Full Screen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
