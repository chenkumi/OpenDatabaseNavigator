import { Component, type ReactNode } from 'react';
import { Button } from './ui/button';
import { useI18n } from '../i18n';

function Fallback({ error, reset }: { error: Error; reset: () => void }) {
  const t = useI18n();
  return (
    <div className="navigation-empty" role="alert">
      <p>{t('This view failed to render.')}</p>
      <p>{error.message}</p>
      <Button variant="outline" onClick={reset}>
        {t('Retry')}
      </Button>
    </div>
  );
}

/** Keeps one broken tab from blanking the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    console.error('Renderer error:', error);
  }
  override render() {
    return this.state.error ? (
      <Fallback error={this.state.error} reset={() => this.setState({ error: undefined })} />
    ) : (
      this.props.children
    );
  }
}
