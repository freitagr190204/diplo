import { effect, signal, Signal } from '@angular/core';
import { Observable, Subscription } from 'rxjs';

export function computedAsync<T>(fct: () => Observable<T>): Signal<T | null> {
  const sig = signal<T | null>(null);
  let subscription: Subscription;

  effect(() => {
    sig.set(null);
    if (subscription && !subscription.closed) subscription.unsubscribe(); //unsubscribe if open
    subscription = fct().subscribe(x => sig.set(x));
  });

  return sig;
}

export function computedAsyncWithDefault<T>(fct: () => Observable<T>, initialValue: T): Signal<T> {
  const sig = signal<T>(initialValue);
  let subscription: Subscription;

  effect(() => {
    sig.set(initialValue);
    if (subscription && !subscription.closed) subscription.unsubscribe(); //unsubscribe if open
    subscription = fct().subscribe(x => sig.set(x));
  });

  return sig;
}