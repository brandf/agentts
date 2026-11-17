// wait-hub — the ONE blocking-wait primitive (BRA-65 + BRA-66).
//
// get-job and tick are both long-polls, and they share this
// mechanism — do not build a second one. A waiter is a synchronous
// check() re-run on every notify(): the check returns a non-null
// value when the wait is satisfied (a job is assignable, events
// are pending), null while it must keep waiting. The check runs
// immediately at registration (an already-satisfied wait returns
// at once) and again on every notify() until it returns non-null
// or the timeout fires (resolve null).
//
// The check MUST be safe to run repeatedly: pure on the null path
// (selection reads state only), and its side effect (assigning a
// job, draining the event queue) happens only on the path that
// returns non-null — and only once, because the waiter resolves
// and is never re-checked. Checks run synchronously inside
// notify(), and JS is single-threaded, so the check-and-assign is
// atomic: two workers waiting on the same job cannot both be
// assigned it. A check that throws keeps waiting (the timeout
// bounds it); the throw is swallowed, never delivered.
//
// Disconnect (BRA-81 fix): a waiter carries the request's
// AbortSignal (Bun aborts it when the client disconnects). When
// the signal fires, the waiter is unregistered and resolves null
// — a dead worker's parked get-job must NOT keep being assigned
// jobs (it would burn the job's attempts on a worker that can
// never complete it, and a dead tick agent's parked tick must not
// hold the tick slot). A client already gone at registration gets
// null immediately, without the check running — there is no point
// assigning a job to a caller that cannot receive it.

type Waiter = {
  check: () => unknown | null;
  resolve: (v: unknown | null) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class WaitHub {
  private waiters: Waiter[] = [];

  waiterCount(): number {
    return this.waiters.length;
  }

  /** Wait until check() returns non-null, or the timeout fires
   * (resolve null), or the client's AbortSignal fires (resolve
   * null — the caller is gone, so the waiter is unregistered and
   * nothing is assigned to it). check() runs immediately, then on
   * every notify(), until then. */
  waitFor<T>(check: () => T | null, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
    if (signal?.aborted) return Promise.resolve(null);
    const immediate = check();
    if (immediate !== null) return Promise.resolve(immediate);
    return new Promise<T | null>((resolve) => {
      const waiter: Waiter = {
        check: check as () => unknown | null,
        resolve: resolve as (v: unknown | null) => void,
        timer: setTimeout(() => {
          this.detach(waiter);
          this.remove(waiter);
          resolve(null);
        }, Math.max(0, timeoutMs)),
      };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          clearTimeout(waiter.timer);
          this.remove(waiter);
          resolve(null);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private remove(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** Drop the waiter's abort listener (it resolved another way —
   * a late abort must not touch an already-settled waiter). */
  private detach(w: Waiter): void {
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
  }

  /** Re-run every parked check; resolve the ones now satisfied. */
  notify(): void {
    for (const w of [...this.waiters]) {
      let v: unknown | null;
      try {
        v = w.check();
      } catch {
        continue;
      }
      if (v !== null) {
        clearTimeout(w.timer);
        this.detach(w);
        this.remove(w);
        w.resolve(v);
      }
    }
  }
}
