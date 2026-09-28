export type Unsubscribe = () => void;

export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<(value: unknown) => void>>();
  on<K extends keyof Events>(topic: K, listener: (value: Events[K]) => void): Unsubscribe {
    const set = this.listeners.get(topic) ?? new Set();
    set.add(listener as (value: unknown) => void);
    this.listeners.set(topic, set);
    return () => set.delete(listener as (value: unknown) => void);
  }
  emit<K extends keyof Events>(topic: K, value: Events[K]) { this.listeners.get(topic)?.forEach(fn => fn(value)); }
}
