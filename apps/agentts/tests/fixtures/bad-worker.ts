#!/usr/bin/env bun
/**
 * bad-worker — test fixture for the worker pool suite (BRA-48).
 *
 * Returns valid JSON in the WRONG shape ({nonsense: true} instead
 * of a JudgeVerdict). The queue server accepts it (it is JSON); the
 * host's trap boundary must reject it with a ValidationError at the
 * call site — proving the boundary is enforced host-side and the
 * worker is never trusted.
 */
console.log(JSON.stringify({ nonsense: true }));
