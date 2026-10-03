import { useSyncExternalStore } from 'react';
import { useI18n } from '../i18n';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';

type Request = { message: string; resolve: (value: boolean) => void };
let pending: Request | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => listeners.forEach((listener) => listener());
export function confirmAction(message: string): Promise<boolean> {
  // Ignore repeated actions while a decision is pending. No hidden confirmation queue.
  if (pending) return Promise.resolve(false);
  return new Promise((resolve) => {
    pending = { message, resolve };
    notify();
  });
}
function finish(value: boolean) {
  const request = pending;
  pending = undefined;
  notify();
  request?.resolve(value);
}
export function ConfirmDialog() {
  const t = useI18n();
  const request = useSyncExternalStore(subscribe, () => pending);
  return (
    <AlertDialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) finish(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>{t('Confirm action')}</AlertDialogTitle>
        <AlertDialogDescription>{request?.message}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus onClick={() => finish(false)}>
            {t('Cancel')}
          </AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => finish(true)}>
            {t('Continue')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
