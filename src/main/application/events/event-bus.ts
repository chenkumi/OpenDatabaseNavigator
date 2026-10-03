import { EventEmitter } from 'node:events';
import type { AppEvent } from '../../../shared/types';
export class EventBus {
  private emitter = new EventEmitter();
  emit(type: string, payload?: unknown) {
    this.emitter.emit('event', { type, payload } satisfies AppEvent);
  }
  subscribe(listener: (event: AppEvent) => void) {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
