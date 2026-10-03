import { createContext, useContext } from 'react';
import translations from './zh-TW.json';
import type { Settings } from '../../shared/types';

// Secure-storage diagnostics are kept with the translator so both dialogs share
// identical guidance without exposing or interpolating credential values.
const secureStorageTranslations: Record<string, string> = {
  'Secure credential storage': '安全憑證儲存',
  'Recheck secure storage': '重新檢查安全儲存',
  'Checking secure storage…': '正在檢查安全儲存…',
  'Could not check secure storage. Recheck to try again.': '無法檢查安全儲存，請重新檢查以重試。',
  'Not checked': '尚未檢查',
  Available: '可用',
  Unavailable: '無法使用',
  'Plaintext backend rejected': '已拒絕明文儲存後端',
  'Restart required': '需要重新啟動',
  'Explicit backend selection': '明確指定的後端',
  'Native platform default': '作業系統原生預設',
  'WSL libsecret default': 'WSL libsecret 預設',
  'Backend: {backend} · Selection: {source}': '後端：{backend} · 選擇來源：{source}',
  'Passwords cannot be saved until secure storage is available. SQLite and passwordless connections can still be saved.':
    '安全儲存可用之前無法儲存密碼。仍可儲存 SQLite 與無密碼連線。',
  'This check cannot tell whether a keyring is missing, locked, or unreachable. Plaintext fallback is not allowed.':
    '此檢查無法判斷金鑰圈是未安裝、已鎖定或無法連線。不允許改用明文儲存。',
  'Linux: install a Secret Service provider if needed, then unlock its keyring in your desktop session. For GNOME, open Passwords and Keys (Seahorse), right-click the login keyring and choose Unlock.':
    'Linux：如有需要，請安裝 Secret Service 提供者，並在桌面工作階段解鎖金鑰圈。GNOME 可開啟「密碼與金鑰」（Seahorse），在登入金鑰圈按右鍵並選擇「解鎖」。',
  'Ubuntu installation example (manual only; the app does not run these commands):':
    'Ubuntu 安裝範例（僅供手動操作；程式不會執行這些指令）：',
  'Other Linux distributions: use the equivalent packages from your distribution. WSL also needs a running Secret Service and an accessible desktop D-Bus session; installed packages alone do not guarantee availability.':
    '其他 Linux 發行版請使用對應套件。WSL 也需要運作中的 Secret Service 與可存取的桌面 D-Bus 工作階段；僅安裝套件不保證可用。',
  'macOS: open Keychain Access, unlock the login keychain if locked, and allow this app access when prompted. Contact your administrator if access is restricted.':
    'macOS：開啟「鑰匙圈存取」，若登入鑰匙圈已鎖定請解鎖，並在提示時允許此程式存取。若存取受限，請聯絡管理員。',
  'Windows: secure storage uses your Windows account protection. Sign in to your normal Windows account and contact your administrator if account protection is unavailable.':
    'Windows：安全儲存使用 Windows 帳戶保護。請登入平常使用的 Windows 帳戶；若帳戶保護無法使用，請聯絡管理員。',
  'Check that your operating system credential store is available in your signed-in desktop session. Contact your administrator for setup help.':
    '請確認作業系統憑證儲存在目前登入的桌面工作階段可用。如需設定協助，請聯絡管理員。',
  'Restart the app to retry the selected backend, then recheck secure storage.':
    '請重新啟動程式以重試選定的後端，再重新檢查安全儲存。',
  'After installing or unlocking the credential store, recheck secure storage. If the selected backend is still unavailable, restart the app and recheck.':
    '安裝或解鎖憑證儲存後，請重新檢查安全儲存。若選定的後端仍無法使用，請重新啟動程式再檢查。',
  'Cannot save password: secure credential storage is unavailable. Follow the guidance below, then recheck.':
    '無法儲存密碼：安全憑證儲存無法使用。請依下方說明操作，再重新檢查。',
  'Secure credential storage is unavailable. Follow the guidance below, then recheck before retrying.':
    '安全憑證儲存無法使用。請依下方說明操作，重新檢查後再重試。',
};

export const LanguageContext = createContext<Settings['language']>('zh-TW');
export function translator(language: Settings['language']) {
  return (message: string, values: Record<string, string | number> = {}) => {
    const template =
      language === 'zh-TW'
        ? (secureStorageTranslations[message] ??
          (translations as Record<string, string>)[message] ??
          message)
        : message;
    return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
  };
}
export function useI18n() {
  return translator(useContext(LanguageContext));
}
