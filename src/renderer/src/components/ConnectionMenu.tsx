import { useI18n } from '../i18n';
import { ActionMenu } from './ActionMenu';
export function ConnectionMenu({
  name,
  connected,
  busy,
  onReconnect,
  onDisconnect,
  onDelete,
  onSettings,
}: {
  name: string;
  connected: boolean;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  onDelete: () => void;
  onSettings: () => void;
}) {
  const t = useI18n();
  return (
    <ActionMenu
      label={t('Connection actions for {name}', { name })}
      actions={[
        { label: t(connected ? 'Reconnect' : 'Connect'), run: onReconnect, disabled: busy },
        { label: t('Disconnect'), run: onDisconnect, disabled: !connected && !busy },
        { label: t('Delete connection'), run: onDelete, variant: 'destructive' },
        { label: t('Settings'), run: onSettings, separator: true },
      ]}
    />
  );
}
