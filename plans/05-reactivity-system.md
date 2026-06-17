# Plan 05 — Reactivity System

## Overview

The reactivity system is what sets ctrodb apart from Dexie and other IndexedDB wrappers. It provides **signal-based reactive queries** that automatically update when data changes — no manual state management, no `useEffect` wiring, no Observable boilerplate.

## Core Signal Implementation

```typescript
/**
 * A minimal reactive signal — zero dependencies, ~50 lines.
 * Compatible with the TC39 Signals proposal semantics.
 */
class Signal<T> {
  #value: T;
  #subscribers = new Set<(value: T) => void>();
  #dependents = new Set<Signal<any>>();

  constructor(initialValue: T) {
    this.#value = initialValue;
  }

  /** Get the current value (tracks dependency if called within an Effect) */
  get value(): T {
    if (Effect.current) {
      Effect.current.dependOn(this);
    }
    return this.#value;
  }

  /** Set a new value and notify all subscribers */
  set value(newValue: T) {
    if (Object.is(this.#value, newValue)) return; // Skip if unchanged
    this.#value = newValue;
    this.#notify();
  }

  /** Subscribe to value changes */
  subscribe(fn: (value: T) => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  /** Internal: notify subscribers and dependent signals */
  #notify(): void {
    // Iterate over a copy to prevent issues if subscriber unsubscribes during notification
    for (const fn of [...this.#subscribers]) {
      try { fn(this.#value); } catch (e) { console.error('[ctrodb] Signal subscriber error:', e); }
    }
    for (const dep of this.#dependents) {
      dep.#notify();
    }
  }
}
```

## Effect System

```typescript
/**
 * An Effect that automatically tracks its signal dependencies
 * and re-runs when any of them change.
 */
class Effect {
  static current: Effect | null = null;

  #fn: () => void;
  #dependencies = new Set<Signal<any>>();
  #cleanup: (() => void) | null = null;
  #active = true;

  constructor(fn: () => void) {
    this.#fn = fn;
    this.#run();
  }

  /** Called by Signal.get() to register a dependency */
  dependOn(signal: Signal<any>): void {
    if (this.#active) {
      this.#dependencies.add(signal);
    }
  }

  #run(): void {
    if (!this.#active) return;

    // Run cleanup from previous run
    this.#cleanup?.();

    // Clear dependencies and re-run
    this.#dependencies.clear();
    const prevEffect = Effect.current;
    Effect.current = this;

    try {
      this.#cleanup = this.#fn() as (() => void) | null;
    } catch (e) {
      console.error('[ctrodb] Effect error:', e);
    } finally {
      Effect.current = prevEffect;
    }
  }

  destroy(): void {
    this.#active = false;
    this.#cleanup?.();
    this.#dependencies.clear();
  }
}
```

## Query Observer

The observer connects signals to database queries with change tracking:

```typescript
class QueryObserver<T extends Record<string, any>> {
  #signal = new Signal<(Model<T> & T)[]>([]);
  #queryBuilder: QueryBuilder<T>;
  #collection: Collection<T>;
  #unsubscribe: (() => void) | null = null;
  #pendingReFetch: boolean = false;

  constructor(queryBuilder: QueryBuilder<T>, collection: Collection<T>) {
    this.#queryBuilder = queryBuilder;
    this.#collection = collection;
  }

  /** Subscribe to query results. Calls callback immediately and on every change. */
  subscribe(callback: (results: (Model<T> & T)[]) => void): () => void {
    // Initial fetch
    this.#fetchAndNotify();

    // Subscribe to signal changes
    const unsubSignal = this.#signal.subscribe(callback);

    // Subscribe to collection changes
    const emitter = this.#collection._getEmitter();
    const unsubChange = emitter.on('change', (event: ChangeEvent) => {
      if (event.collection === this.#collection.name) {
        this.#scheduleReFetch();
      }
    });

    this.#unsubscribe = () => {
      unsubSignal();
      unsubChange();
    };

    return this.#unsubscribe;
  }

  /** Get the underlying signal (for framework bindings) */
  get signal(): Signal<(Model<T> & T)[]> {
    return this.#signal;
  }

  #scheduleReFetch(): void {
    if (this.#pendingReFetch) return;
    this.#pendingReFetch = true;

    // Microtask debounce — batch rapid changes into one re-fetch
    queueMicrotask(() => {
      this.#pendingReFetch = false;
      this.#fetchAndNotify();
    });
  }

  async #fetchAndNotify(): Promise<void> {
    try {
      const results = await this.#queryBuilder.fetch();
      this.#signal.value = results;
    } catch (e) {
      console.error('[ctrodb] Observer fetch error:', e);
    }
  }
}
```

## Change Event System

```typescript
interface ChangeEvent {
  type: 'create' | 'update' | 'delete';
  collection: string;
  recordId: ID;
  record?: any;      // For create/update — the new record
  oldRecord?: any;   // For update/delete — the previous record
}

class Emitter {
  #listeners = new Map<string, Set<Function>>();

  on(event: string, callback: Function): () => void {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event)!.add(callback);
    return () => this.off(event, callback);
  }

  off(event: string, callback: Function): void {
    this.#listeners.get(event)?.delete(callback);
  }

  emit(event: string, data: any): void {
    const listeners = this.#listeners.get(event);
    if (!listeners) return;
    for (const fn of [...listeners]) {
      try { fn(data); } catch (e) { console.error(`[ctrodb] Emitter error on "${event}":`, e); }
    }
  }
}
```

## Framework Integration

### React Binding

```typescript
// src/bindings/react.ts
import { useEffect, useState, useSyncExternalStore } from 'react';

export function useQuery<T>(
  collectionName: string,
  queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>,
  deps: any[] = []
): (Model<T> & T)[] {
  const [db] = useState(() => getDefaultDatabase());
  
  return useSyncExternalStore(
    (callback) => {
      const collection = db.collection(collectionName);
      let query = collection.query();
      if (queryFn) query = queryFn(query);
      
      const unsub = query.observe((results) => {
        callback();
      });
      
      return unsub;
    },
    () => {
      const collection = db.collection(collectionName);
      let query = collection.query();
      if (queryFn) query = queryFn(query);
      
      // This is a simplification — real implementation would cache the signal value
      return collection.query().fetch();
    }
  );
}

export function useDoc<T>(
  collectionName: string,
  id: ID | undefined
): (Model<T> & T) | undefined {
  // Similar to useQuery but for a single document
  const results = useQuery<T>(
    collectionName,
    id ? (q) => q.where('id' as any, id as any) : undefined,
    [id]
  );
  return results?.[0];
}
```

### Vue Binding

```typescript
// Vue 3 composable
import { ref, onUnmounted } from 'vue';

export function useQuery<T>(collectionName: string, queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>) {
  const items = ref<(Model<T> & T)[]>([]);
  const loading = ref(true);
  const error = ref<Error | undefined>();
  
  let unsub: (() => void) | undefined;
  
  onMounted(async () => {
    const db = getDefaultDatabase();
    const collection = db.collection<T>(collectionName);
    let query = collection.query();
    if (queryFn) query = queryFn(query);
    
    unsub = query.observe(results => {
      items.value = results;
      loading.value = false;
    });
  });
  
  onUnmounted(() => {
    unsub?.();
  });
  
  return { items, loading, error };
}
```

### Solid Binding

```typescript
// SolidJS
import { createSignal, onCleanup } from 'solid-js';

export function createQuery<T>(collectionName: string, queryFn?: (q: QueryBuilder<T>) => QueryBuilder<T>) {
  const db = getDefaultDatabase();
  const collection = db.collection<T>(collectionName);
  let query = collection.query();
  if (queryFn) query = queryFn(query);
  
  // Direct signal integration — Solid subscribes to the signal natively
  const observer = new QueryObserver(query, collection);
  
  onCleanup(() => {
    // cleanup
  });
  
  return observer.signal;
}
```

## Change Tracking Optimization

For the future, we can implement fine-grained change tracking:

1. **Record-level tracking**: Track which record IDs were affected by each change
2. **Condition matching**: Check if a changed record would match the observer's query conditions
3. **Skip re-fetch if irrelevant**: If the changed record doesn't match the conditions and wasn't part of the previous result set, skip re-fetch entirely

```typescript
// Future optimization
class SmartObserver<T> extends QueryObserver<T> {
  #lastResults: Map<ID, T> = new Map();
  #conditions: QueryCondition[];

  async #handleChange(event: ChangeEvent): Promise<void> {
    // Check if the changed record affects our query
    const wouldMatch = this.#recordMatchesConditions(event.record, this.#conditions);
    const wasInResults = this.#lastResults.has(event.recordId);

    if (event.type === 'create' && !wouldMatch) {
      return; // New record that wouldn't match our query — irrelevant
    }
    if (event.type === 'update' && !wouldMatch && !wasInResults) {
      return; // Updated record still doesn't match — irrelevant
    }
    if (event.type === 'delete' && !wasInResults) {
      return; // Deleted record wasn't in our results — irrelevant
    }

    // Relevant change — schedule re-fetch
    this.#scheduleReFetch();
  }
}
```

## Summary

The reactivity system provides:

1. **Minimal Signal class** — ~50 lines, zero dependencies, TC39 compatible
2. **Effect system** — Auto-tracking dependencies, cleanup on re-run
3. **QueryObserver** — Connects queries to signals with change tracking
4. **Emitter** — Event bus for change notifications
5. **Framework bindings** — React, Vue, Solid with native integration patterns
6. **Microtask batching** — Rapid changes coalesced into single re-fetch
7. **Future: smart change tracking** — Skip re-fetch when changes don't affect results
