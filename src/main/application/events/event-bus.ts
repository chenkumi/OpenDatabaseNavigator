import { EventEmitter } from 'node:events';
import type { AppEvent } from '../../../shared/types';
export class EventBus {
  private emitter = new EventEmitter();
  emit(type: string, payload?: unknown) {
    const event = { type, payload } satisfies AppEvent;
    // A failing subscriber (for example a disposed window) must not turn an
    // already-completed command into an error for the caller.
    for (const listener of this.emitter.listeners('event')) {
      try {
        listener(event);
      } catch (error) {
        console.error('Event listener failed', type, error);
      }
    }
  }
  subscribe(listener: (event: AppEvent) => void) {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
