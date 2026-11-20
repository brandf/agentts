/*
 * DurableTS core library + thin host CLI (Linear BRA-43).
 *
 * The C core knows ONLY: the trap(type, arg) builtin (the single
 * dispatch point — suspends the run, hands the trap to the host
 * plugin, resumes with the plugin's result), the all / any / race
 * core builtins (fork/join, Q13 semantics), suspend-a-run-into-a-blob
 * / resume-a-blob-with-a-value-or-throw, the run registry (in-memory,
 * per-slice — the plugin maintains the durable registry from the
 * lifecycle events below), trapId identity (runId + ordinal), the
 * workflow-entry guard (__agentts_begin + the in-workflow flag), and
 * run-result capture (<blob>.result.json on top-level completion).
 * The core does NOT journal (the journal is the plugin's), does NOT
 * know what a step, job, gate, judge, or workflow is, and never
 * chooses a blob path: the blob file it reads/writes is the path the
 * plugin passes on the command line. The core's only filesystem
 * writes are that blob file and the result file derived from it.
 *
 * Trap types are dispatched by type string; the core only routes
 * them — the plugin interprets them: job, exec, gate, sleep, cron,
 * decide. A run is a workflow function: the host-generated driver
 * (global code) calls __agentts_begin() and then the exported entry
 * function with the input JSON; the entry's return value is the run
 * result. The core enforces the entry guard at runtime — a trap or
 * combinator call NOT under the entry function on the stack throws
 * immediately (TypeError naming the call) — and captures the
 * completion value as <blob>.result.json when a top-level run
 * completes (run path and every resume/join path; branch runs report
 * their outcome instead). The core's filesystem writes are the blob
 * file and the result file, both paths the plugin passes or derives
 * from the blob path.
 *
 * Cancellation (Q14): cancel a pending trap, cancel a whole
 * combinator, sticky cancellation, cancel-vs-complete race (journal
 * order wins — the plugin records it), nested propagation down the
 * tree. Delivered by resuming the suspended wait throwing a real
 * CancellationError (name "CancellationError").
 *
 * Error rehydration (BRA-41): every resume-with-throw path rehydrates
 * {name, message} error records into real Errors — trap results
 * included, not just joins. The old prototype delivered throwing
 * steps as raw strings / plain objects; that bug is fixed here.
 *
 * Trap arg-in JSON rule (BRA-43 follow-up): trap() validates its arg
 * before suspending — only clean JSON (plus Date, which crosses as
 * its ISO string) may cross. A dirty arg (undefined, function, Map,
 * class instance, circular, ...) throws a JsonBoundaryError
 * synchronously at the call site and never dispatches: no trap event,
 * no ordinal consumed, no blob. Plain JSON.stringify is not the
 * mechanism — the walk validates and builds a clean copy first.
 *
 * Events: the core emits one JSON object per line on stderr, each
 * prefixed "[durablets] ", for the plugin to record (journal) and to
 * maintain its run registry from:
 *   {"event":"lifecycle","lifecycle":"started"|"suspended"|"resumed"|
 *    "completed"|"failed","runId":...,"kind":2|3}
 *   {"event":"trap","runId","trapId","ordinal":N,"type":"job","arg":{}}
 *   {"event":"trap-result"|"trap-error","runId","trapId","ordinal":N,
 *    "result"|"error":{}}
 *   {"event":"fork","runId","forkId","kind":"all"|"any"|"race",
 *    "branches":N,"failFast":bool?,"childRuns":[...]}
 *   {"event":"join", ...}  (same shapes as the experiments' join
 *    events: outcome array | winner | failedBranch+error | aggregate)
 *   {"event":"cancel","runId","what":"trap"|"fork","ordinal":N?,
 *    "forkId":...?,"trigger","reason","when":<epoch>,"cancelled":[]?,
 *    "parentForkId":...?,"branch":i?}
 *   {"event":"branch-start"|"branch-done","runId","parentForkId",
 *    "branch":i,"outcome":{...}?}
 * Branch outcomes also print on stdout as "branch <i> outcome: <json>".
 *
 * Modes (exit codes: 0 = done, 1 = error, 2 = suspended at a trap,
 * 3 = suspended at a combinator; stdout is workflow output, stderr
 * is host diagnostics + [durablets] events):
 *   durablets run <workflow.ts> <blob>
 *   durablets resume <blob> <result-json> | throw:<json>
 *   durablets cancel <blob> <cancel.json>
 *   durablets branch <blob> <index>
 *   durablets join <blob> <outcome.json>...
 *   durablets join-value <blob> <record.json>
 *   durablets join-throw <blob> <record.json>
 *   durablets join-aggregate <blob> <record.json>
 *
 * Run context lives in heap globals, set from the environment by the
 * run/branch modes and carried by the snapshot afterwards:
 *   __run_id         run id, e.g. "run-judges" or
 *                    "run-judges/fork-0/branch-1"
 *   __fork_count     fork ordinal counter for this run (snapshotted)
 *   __trap_count     trap ordinal counter for this run (snapshotted)
 *   __cancelled      1 once the run is cancelled (sticky, snapshotted)
 *   __cancel_reason  the cancel reason, for immediate throws
 *   __branch_index   branch index, branch runs only
 *   __parent_fork    parent fork id, branch runs only
 *
 * Built against the patched minimal dquickts tree
 * (~/workspace/dquickts-build-minimal, BRA-42 JS_AbandonSuspended).
 * The engine tree is NOT modified by this library.
 *
 * Ownership notes (QuickJS traps): JS_SetProperty* consumes its value
 * argument; JS_SetPropertyValue frees both prop and val, so the stashed
 * thunks array is dup'd first; JS_ResumeWith frees its result argument.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <stdarg.h>
#include <inttypes.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

#include "quickjs.h"
#include "durablets.h"

/* ---- tiny string buffer ---- */
struct strbuf { char *s; size_t len, cap; };
static void sb_init(struct strbuf *b)
{
    b->cap = 256; b->len = 0; b->s = malloc(b->cap); b->s[0] = '\0';
}
static void sb_printf(struct strbuf *b, const char *fmt, ...)
{
    va_list ap;
    int n;
    for (;;) {
        va_start(ap, fmt);
        n = vsnprintf(b->s + b->len, b->cap - b->len, fmt, ap);
        va_end(ap);
        if (n < 0)
            return;
        if ((size_t)n < b->cap - b->len) { b->len += (size_t)n; return; }
        b->cap = (b->len + (size_t)n + 1) * 2;
        b->s = realloc(b->s, b->cap);
    }
}
static void sb_free(struct strbuf *b) { free(b->s); b->s = NULL; b->len = b->cap = 0; }

/* 2 = suspended at trap, 3 = suspended at a combinator. Set by the
 * builtin that suspends; save() returns it. */
static int g_suspend_kind = 2;

/* The workflow-entry guard (Brandon, 06:03 PST): a trap call (any of
 * job/exec/gate/sleep/cron/decide) or a combinator call (all/any/race)
 * that is NOT under a workflow function on the stack must fail the
 * run. The run's entry-function frame must be on the stack below the
 * call — in a child run, the entry is the branch thunk. This is a
 * runtime property (a helper called from the entry is fine; the same
 * helper called from top-level code is not), so it is enforced here,
 * not statically: the flag is set by the driver's __agentts_begin()
 * call (run path — the driver calls it, then calls the entry from
 * global code) and by the C host before resuming/branching (resume
 * paths continue inside the entry; a branch thunk IS the entry for
 * its child run). The run path deliberately does NOT set it — a trap
 * in the driver's own top-level code, or in a workflow file's
 * top-level code (which runs before the driver's __agentts_begin),
 * must fail. */
static int g_in_workflow = 0;

static JSValue js_print(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    int i;
    for (i = 0; i < argc; i++) {
        const char *str = JS_ToCString(ctx, argv[i]);
        if (!str)
            return JS_EXCEPTION;
        printf("%s%s", i ? " " : "", str);
        JS_FreeCString(ctx, str);
    }
    printf("\n");
    return JS_UNDEFINED;
}

/* ---- heap globals: run context ---- */
static char *get_global_cstring(JSContext *ctx, const char *name)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    char *s = NULL;
    if (!JS_IsException(v) && !JS_IsUndefined(v)) {
        const char *c = JS_ToCString(ctx, v);
        if (c)
            s = strdup(c);
        if (c)
            JS_FreeCString(ctx, c);
    }
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return s;
}

static int64_t get_global_int(JSContext *ctx, const char *name, int64_t def)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue v = JS_GetPropertyStr(ctx, global, name);
    int64_t n = def;
    if (!JS_IsException(v) && !JS_IsUndefined(v))
        JS_ToInt64(ctx, &n, v);
    JS_FreeValue(ctx, v);
    JS_FreeValue(ctx, global);
    return n;
}

static void set_global_str(JSContext *ctx, const char *name, const char *s)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, name, JS_NewString(ctx, s));
    JS_FreeValue(ctx, global);
}

static void set_global_int(JSContext *ctx, const char *name, int64_t n)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, name, JS_NewInt64(ctx, n));
    JS_FreeValue(ctx, global);
}

static char *current_run_id(JSContext *ctx)
{
    char *s = get_global_cstring(ctx, "__run_id");
    return s ? s : strdup("run-parent");
}

/* JSON-stringify a value; returns a malloc'd string or NULL. */
static char *json_stringify(JSContext *ctx, JSValueConst v)
{
    JSValue js = JS_JSONStringify(ctx, v, JS_UNDEFINED, JS_UNDEFINED);
    const char *c = NULL;
    char *s = NULL;
    if (!JS_IsException(js)) {
        c = JS_ToCString(ctx, js);
        if (c)
            s = strdup(c);
        if (c)
            JS_FreeCString(ctx, c);
    }
    JS_FreeValue(ctx, js);
    return s;
}

/* Derive the run-result path from a snapshot path: <base>.snap ->
 * <base>.result.json (same dir). Returns a malloc'd string. */
static char *result_path_for(const char *snap)
{
    size_t n = strlen(snap);
    const char *suffix = ".snap";
    size_t sl = strlen(suffix);
    char *out;
    if (n > sl && !strcmp(snap + n - sl, suffix)) {
        out = malloc(n - sl + strlen(".result.json") + 1);
        memcpy(out, snap, n - sl);
        strcpy(out + (n - sl), ".result.json");
    } else {
        out = malloc(n + strlen(".result.json") + 1);
        strcpy(out, snap);
        strcat(out, ".result.json");
    }
    return out;
}

/* ---- atomic file write (BRA-83, G4) ----
 *
 * Both of the core's filesystem writes — the live snapshot
 * (save_snapshot) and the run result (write_result_json) — go
 * through this one helper: write to a pid-suffixed tmp file in the
 * SAME directory as the target (so the rename stays on one
 * filesystem), fsync the tmp file, rename into place, fsync the
 * containing directory. A kill at any point leaves the target old
 * or new, never torn: before the rename the old target is
 * untouched; after it the new bytes are fully written and
 * fsynced. A leftover <target>.<pid>.tmp from a killed write is
 * never read — nothing in the core opens a *.tmp path (the resume
 * paths open exactly the path passed on the command line) — and
 * the next write to the same target uses its own pid-suffixed tmp
 * name (fopen("wb") truncates it), so stale tmps are harmless
 * litter, at most one per killed write.
 *
 * fsync choice: the file fsync before rename is what makes the
 * new bytes durable — without it a power loss after the rename
 * could leave the renamed file torn. The directory fsync after
 * rename makes the rename itself durable. The audit (§4.15 G4)
 * prescribes "+ fsync" here, and the cost is two syscalls per
 * suspension / result write — not a hot path (one snapshot per
 * suspension, one result per completion) — so both are done,
 * unlike the host side (BRA-76), whose threat model is a process
 * crash only. A failed file fsync is a hard failure (the tmp is
 * unlinked, the old target intact, the caller fails loudly); a
 * failed directory fsync only warns — the rename already
 * happened and the bytes are fsynced, so only the directory
 * entry's durability is uncertain, and a power loss in that
 * window leaves the old (valid) target.
 *
 * Returns 0 on success, -1 on failure (with a message on
 * stderr). The tmp file is unlinked on every failure path. */
static int write_file_atomic(const char *path, const void *data, size_t len)
{
    char *tmp;
    FILE *f;
    size_t tmplen = strlen(path) + 32;

    tmp = malloc(tmplen);
    snprintf(tmp, tmplen, "%s.%ld.tmp", path, (long)getpid());
    f = fopen(tmp, "wb");
    if (!f) {
        fprintf(stderr, "[host] could not write %s: %s\n", tmp, strerror(errno));
        free(tmp);
        return -1;
    }
    if (len > 0 && fwrite(data, 1, len, f) != len) {
        fprintf(stderr, "[host] could not write %s: %s\n", tmp, strerror(errno));
        fclose(f);
        unlink(tmp);
        free(tmp);
        return -1;
    }
    if (fflush(f) != 0 || fsync(fileno(f)) != 0) {
        fprintf(stderr, "[host] could not fsync %s: %s\n", tmp, strerror(errno));
        fclose(f);
        unlink(tmp);
        free(tmp);
        return -1;
    }
    if (fclose(f) != 0) {
        fprintf(stderr, "[host] could not close %s: %s\n", tmp, strerror(errno));
        unlink(tmp);
        free(tmp);
        return -1;
    }
    if (rename(tmp, path) != 0) {
        fprintf(stderr, "[host] could not rename %s to %s: %s\n", tmp, path, strerror(errno));
        unlink(tmp);
        free(tmp);
        return -1;
    }
    free(tmp);
    /* fsync the directory so the rename itself is durable. Opened
     * read-only; failure here only warns (see the header comment)
     * — the new file is already in place and fsynced. */
    {
        char *dir = strdup(path);
        char *slash = strrchr(dir, '/');
        int dfd;
        if (slash == NULL) {
            free(dir);
            dir = strdup(".");
        } else if (slash == dir) {
            dir[1] = '\0'; /* "/file" -> "/" */
        } else {
            *slash = '\0';
        }
        dfd = open(dir, O_RDONLY);
        if (dfd >= 0) {
            if (fsync(dfd) != 0)
                fprintf(stderr, "[host] warning: could not fsync directory %s: %s\n", dir, strerror(errno));
            close(dfd);
        } else {
            fprintf(stderr, "[host] warning: could not open directory %s: %s\n", dir, strerror(errno));
        }
        free(dir);
    }
    return 0;
}

/* Write a pre-stringified JSON result to the run-result file.
 * Atomic (BRA-83, G4): tmp + fsync + rename, same helper as
 * save_snapshot — a kill mid-write leaves the previous result
 * file (or none) intact, never a torn .result.json. Best-effort
 * as before: a write failure is reported on stderr; the run's
 * exit code is unchanged (the host surfaces a missing result
 * file when the result is fetched). */
static void write_result_json(const char *json, const char *snap)
{
    char *path = result_path_for(snap);
    const char *text = json ? json : "null";
    if (write_file_atomic(path, text, strlen(text)) != 0)
        fprintf(stderr, "[host] could not write run result %s\n", path);
    free(path);
}

/* Write the run's completion value as <snap>.result.json (the run
 * result, for `agentts result <runId>`). A completion value that
 * stringifies to "undefined" (a script that returns nothing) is
 * recorded as null — the result file always holds JSON. */
static void write_run_result(JSContext *ctx, JSValueConst val,
                             const char *snap)
{
    char *json = json_stringify(ctx, val);
    if (!json || !strcmp(json, "undefined")) {
        free(json);
        json = strdup("null");
    }
    write_result_json(json, snap);
    free(json);
}

/* ---- trap arg-in JSON check (BRA-43 follow-up) ----
 *
 * The core enforces the trap-boundary JSON rule at trap() entry, for
 * direct trap() callers (the agentts module, BRA-46, enforces the same
 * rule in TS before calling trap(); the plugin, BRA-45, enforces
 * result-out before resume). The check runs BEFORE suspending, before
 * the trap ordinal is consumed and before any trap event is emitted,
 * so a dirty arg throws synchronously at the call site and never
 * dispatches: no trap event, no blob.
 *
 * ACCEPT: null, boolean, string, finite number, array, plain object
 * (Object.prototype or null prototype, string keys). Date is the ONE
 * sanctioned conversion, to its ISO string (Date.prototype.toJSON —
 * the standard JSON convention).
 *
 * REJECT, each with a precise error (path, what the value was, what to
 * do — mirroring the module's JsonBoundaryError message): undefined
 * anywhere (use null, not undefined, for no value), function, symbol,
 * BigInt, NaN/Infinity, Map/Set, typed arrays/DataView/ArrayBuffer
 * (incl. SharedArrayBuffer), class instances (non-plain prototype),
 * circular references, non-string (symbol) keys, array holes, extra
 * keys on arrays, nesting past the depth cap, unreadable properties.
 *
 * Plain JSON.stringify is NOT the mechanism: it fails silently (drops
 * functions/undefined/symbols from objects, turns Map/Set into {},
 * NaN/Infinity into null, class instances into plain objects with
 * methods dropped). Instead the walk below validates AND builds a
 * fresh clean copy — the author's object is never mutated, getters are
 * read exactly once per property (the copy, not the original, is what
 * gets stringified for the trap event), and a value referenced twice
 * without a cycle (a DAG) is copied at each occurrence, exactly as
 * JSON.stringify duplicates it. Only true cycles are rejected
 * (ancestors, not all seen objects, are tracked).
 *
 * Two deliberate strictness notes vs the TS walk: array keys are
 * enumerated without the enumerable-only filter, so a non-enumerable
 * index element is validated (the TS walk reads every index too) and
 * a non-enumerable extra key on an array is rejected (JSON.stringify
 * would silently drop it — the same silent-loss class the rule
 * targets). Plain-object keys stay enumerable-only, matching
 * Object.keys / JSON.stringify. */

#define DURABLETS_MAX_JSON_DEPTH 1000

struct arg_check {
    char *err;            /* malloc'd full message on failure, else NULL */
    const void **ancestors; /* object pointers on the current walk path */
    char **ancestor_paths;  /* path of each ancestor, for cycle detail */
    size_t nanc, capanc;
};

static void arg_fail(struct arg_check *st, const char *path,
                     const char *detail, const char *fix)
{
    struct strbuf b;
    if (st->err)
        return; /* keep the first (outermost-path) failure */
    sb_init(&b);
    sb_printf(&b, "JSON boundary (trap arg): %s %s; %s", path, detail,
              fix);
    st->err = strdup(b.s);
    sb_free(&b);
}

/* Clear a pending JS exception, if any, discarding it. */
static void clear_js_exception(JSContext *ctx)
{
    if (JS_HasException(ctx)) {
        JSValue e = JS_GetException(ctx);
        JS_FreeValue(ctx, e);
    }
}

/* Describe the pending JS exception as a malloc'd string ("Error:
 * boom" for an Error, the value itself otherwise), clearing it. Only
 * call when an exception is pending. */
static char *exc_detail(JSContext *ctx)
{
    JSValue e = JS_GetException(ctx);
    const char *c = JS_ToCString(ctx, e);
    char *s = c ? strdup(c) : strdup("unknown error");
    if (c)
        JS_FreeCString(ctx, c);
    JS_FreeValue(ctx, e);
    return s;
}

static char *path_join_dot(const char *path, const char *key)
{
    struct strbuf b;
    sb_init(&b);
    sb_printf(&b, "%s.%s", path, key);
    return b.s; /* ownership transfers to the caller */
}

static char *path_join_index(const char *path, int64_t i)
{
    struct strbuf b;
    sb_init(&b);
    sb_printf(&b, "%s[%" PRId64 "]", path, i);
    return b.s; /* ownership transfers to the caller */
}

/* Is k a canonical array index ("0", "1", ..., no leading zeros)
 * below len? Fills *idx_out on success. */
static int is_canonical_index(const char *k, int64_t len, int64_t *idx_out)
{
    int64_t v = 0;
    const char *p;
    if (!*k)
        return 0;
    if (k[0] == '0' && k[1])
        return 0;
    for (p = k; *p; p++) {
        if (*p < '0' || *p > '9')
            return 0;
        v = v * 10 + (*p - '0');
        if (v >= len)
            return 0;
    }
    *idx_out = v;
    return 1;
}

static const char *typed_array_name(int t)
{
    switch (t) {
    case JS_TYPED_ARRAY_UINT8C: return "Uint8ClampedArray";
    case JS_TYPED_ARRAY_INT8: return "Int8Array";
    case JS_TYPED_ARRAY_UINT8: return "Uint8Array";
    case JS_TYPED_ARRAY_INT16: return "Int16Array";
    case JS_TYPED_ARRAY_UINT16: return "Uint16Array";
    case JS_TYPED_ARRAY_INT32: return "Int32Array";
    case JS_TYPED_ARRAY_UINT32: return "Uint32Array";
    case JS_TYPED_ARRAY_BIG_INT64: return "BigInt64Array";
    case JS_TYPED_ARRAY_BIG_UINT64: return "BigUint64Array";
    case JS_TYPED_ARRAY_FLOAT16: return "Float16Array";
    case JS_TYPED_ARRAY_FLOAT32: return "Float32Array";
    case JS_TYPED_ARRAY_FLOAT64: return "Float64Array";
    default: return "typed array";
    }
}

/* The registered class name of an object ("Map", "SharedArrayBuffer",
 * ...), malloc'd, or NULL. */
static char *class_name_of(JSContext *ctx, JSValueConst v)
{
    JSAtom atom = JS_GetClassName(JS_GetRuntime(ctx), JS_GetClassID(v));
    const char *c;
    char *s = NULL;
    if (atom == JS_ATOM_NULL)
        return NULL;
    c = JS_AtomToCString(ctx, atom);
    if (c)
        s = strdup(c);
    JS_FreeAtom(ctx, atom);
    return s;
}

/* The constructor's name of an object ("Point", ...), malloc'd, or
 * NULL when it cannot be read. */
static char *ctor_name_of(JSContext *ctx, JSValueConst v)
{
    JSValue ctor = JS_GetPropertyStr(ctx, v, "constructor");
    JSValue name;
    const char *c;
    char *s = NULL;
    if (JS_IsException(ctor)) {
        clear_js_exception(ctx);
        return NULL;
    }
    name = JS_GetPropertyStr(ctx, ctor, "name");
    JS_FreeValue(ctx, ctor);
    if (JS_IsException(name)) {
        clear_js_exception(ctx);
        return NULL;
    }
    if (JS_IsString(name)) {
        c = JS_ToCString(ctx, name);
        if (c)
            s = strdup(c);
        if (c)
            JS_FreeCString(ctx, c);
    }
    JS_FreeValue(ctx, name);
    return s;
}

static int ancestors_contains(struct arg_check *st, const void *p,
                              const char **path_out)
{
    size_t i;
    for (i = 0; i < st->nanc; i++) {
        if (st->ancestors[i] == p) {
            if (path_out)
                *path_out = st->ancestor_paths[i];
            return 1;
        }
    }
    return 0;
}

static int ancestors_push(struct arg_check *st, const void *p,
                          const char *path)
{
    if (st->nanc == st->capanc) {
        size_t ncap = st->capanc ? st->capanc * 2 : 16;
        const void **np = realloc(st->ancestors, ncap * sizeof(*np));
        char **sp;
        if (!np)
            return -1;
        st->ancestors = np;
        sp = realloc(st->ancestor_paths, ncap * sizeof(*sp));
        if (!sp)
            return -1;
        st->ancestor_paths = sp;
        st->capanc = ncap;
    }
    st->ancestors[st->nanc] = p;
    st->ancestor_paths[st->nanc] = strdup(path);
    st->nanc++;
    return 0;
}

static void ancestors_pop(struct arg_check *st)
{
    if (st->nanc == 0)
        return;
    st->nanc--;
    free(st->ancestor_paths[st->nanc]);
    st->ancestor_paths[st->nanc] = NULL;
}

/* Fail with the "unreadable" kind: the pending exception (if any) is
 * consumed for its detail. Returns JS_EXCEPTION. */
static JSValue arg_unreadable(JSContext *ctx, struct arg_check *st,
                              const char *path)
{
    char *detail = NULL;
    struct strbuf b;
    if (JS_HasException(ctx))
        detail = exc_detail(ctx);
    sb_init(&b);
    sb_printf(&b, "could not be read (%s)",
              detail ? detail : "unknown error");
    arg_fail(st, path, b.s, "make the property readable or drop it");
    sb_free(&b);
    free(detail);
    return JS_EXCEPTION;
}

/* Validate v and build a fresh clean copy of it (owned by the caller).
 * Returns JS_EXCEPTION on failure, with st->err set to the full
 * "JSON boundary (trap arg): ..." message. The caller must NOT
 * JS_FreeValue a JS_EXCEPTION return. */
static JSValue arg_clean(JSContext *ctx, JSValueConst v, char *path,
                         int depth, struct arg_check *st)
{
    if (depth > DURABLETS_MAX_JSON_DEPTH) {
        struct strbuf b;
        sb_init(&b);
        sb_printf(&b, "is nested past %d levels",
                  DURABLETS_MAX_JSON_DEPTH);
        arg_fail(st, path, b.s, "flatten the value");
        sb_free(&b);
        return JS_EXCEPTION;
    }
    if (JS_IsNull(v))
        return JS_DupValue(ctx, v);
    if (JS_IsBool(v) || JS_IsString(v))
        return JS_DupValue(ctx, v);
    if (JS_IsNumber(v)) {
        double d;
        if (JS_ToFloat64(ctx, &d, v))
            return arg_unreadable(ctx, st, path);
        if (!isfinite(d)) {
            const char *c = JS_ToCString(ctx, v);
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "is %s", c ? c : "non-finite");
            arg_fail(st, path, b.s,
                     "use a finite number or null — JSON has no NaN or Infinity");
            sb_free(&b);
            if (c)
                JS_FreeCString(ctx, c);
            return JS_EXCEPTION;
        }
        return JS_DupValue(ctx, v);
    }
    if (JS_IsUndefined(v)) {
        arg_fail(st, path, "is undefined",
                 "a trap must return a value or throw — use null, not undefined, for no value");
        return JS_EXCEPTION;
    }
    if (JS_IsFunction(ctx, v)) {
        arg_fail(st, path, "is a function",
                 "functions cannot cross a trap boundary — pass plain JSON data instead");
        return JS_EXCEPTION;
    }
    if (JS_IsSymbol(v)) {
        /* JS_ToCString throws on a symbol (implicit conversion is
         * forbidden), so read the description property instead. */
        JSValue desc = JS_GetPropertyStr(ctx, v, "description");
        const char *d = NULL;
        struct strbuf b;
        if (!JS_IsException(desc) && JS_IsString(desc))
            d = JS_ToCString(ctx, desc);
        sb_init(&b);
        sb_printf(&b, "is a symbol (Symbol(%s))", d ? d : "");
        arg_fail(st, path, b.s,
                 "symbols cannot cross a trap boundary — pass plain JSON data instead");
        sb_free(&b);
        if (d)
            JS_FreeCString(ctx, d);
        JS_FreeValue(ctx, desc);
        clear_js_exception(ctx);
        return JS_EXCEPTION;
    }
    if (JS_IsBigInt(ctx, v)) {
        const char *c = JS_ToCString(ctx, v);
        struct strbuf b;
        sb_init(&b);
        sb_printf(&b, "is a BigInt (%s)", c ? c : "?");
        arg_fail(st, path, b.s,
                 "BigInts cannot cross a trap boundary — pass a string or number instead");
        sb_free(&b);
        if (c)
            JS_FreeCString(ctx, c);
        return JS_EXCEPTION;
    }
    if (!JS_IsObject(v)) {
        arg_fail(st, path, "has an unhandled type",
                 "pass plain JSON data instead");
        return JS_EXCEPTION;
    }

    /* Object from here on. A true cycle is rejected; a DAG (same
     * object twice, not on the current path) is copied per occurrence. */
    {
        const void *ptr = JS_VALUE_GET_PTR(v);
        const char *seen_at = NULL;
        if (ancestors_contains(st, ptr, &seen_at)) {
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "is a circular reference (already seen at %s)",
                      seen_at ? seen_at : "?");
            arg_fail(st, path, b.s,
                     "break the cycle — JSON cannot represent circular structures");
            sb_free(&b);
            return JS_EXCEPTION;
        }
    }

    /* Date: the one sanctioned conversion, to its ISO string. */
    if (JS_IsDate(v)) {
        double ms;
        JSValue fn, iso;
        if (JS_ThisDateValue(ctx, &ms, v))
            return arg_unreadable(ctx, st, path);
        if (!isfinite(ms)) {
            arg_fail(st, path, "is an invalid Date",
                     "pass a valid Date or an ISO string");
            return JS_EXCEPTION;
        }
        fn = JS_GetPropertyStr(ctx, v, "toISOString");
        if (JS_IsException(fn))
            return arg_unreadable(ctx, st, path);
        iso = JS_Call(ctx, fn, v, 0, NULL);
        JS_FreeValue(ctx, fn);
        if (JS_IsException(iso))
            return arg_unreadable(ctx, st, path);
        return iso;
    }
    if (JS_IsMap(v)) {
        JSValue size_v = JS_GetPropertyStr(ctx, v, "size");
        int64_t n = -1;
        struct strbuf b;
        if (!JS_IsException(size_v))
            JS_ToInt64(ctx, &n, size_v);
        else
            clear_js_exception(ctx);
        JS_FreeValue(ctx, size_v);
        sb_init(&b);
        if (n >= 0)
            sb_printf(&b, "is a Map with %" PRId64 " entries", n);
        else
            sb_printf(&b, "is a Map");
        arg_fail(st, path, b.s,
                 "convert it to a plain object or array first — JSON.stringify would silently turn it into {}");
        sb_free(&b);
        return JS_EXCEPTION;
    }
    if (JS_IsSet(v)) {
        JSValue size_v = JS_GetPropertyStr(ctx, v, "size");
        int64_t n = -1;
        struct strbuf b;
        if (!JS_IsException(size_v))
            JS_ToInt64(ctx, &n, size_v);
        else
            clear_js_exception(ctx);
        JS_FreeValue(ctx, size_v);
        sb_init(&b);
        if (n >= 0)
            sb_printf(&b, "is a Set with %" PRId64 " entries", n);
        else
            sb_printf(&b, "is a Set");
        arg_fail(st, path, b.s,
                 "convert it to an array first — JSON.stringify would silently turn it into {}");
        sb_free(&b);
        return JS_EXCEPTION;
    }
    if (JS_IsArrayBuffer(v)) {
        arg_fail(st, path, "is an ArrayBuffer",
                 "binary data cannot cross a trap boundary — encode it (e.g. base64) first");
        return JS_EXCEPTION;
    }
    {
        /* SharedArrayBuffer has no public predicate; its registered
         * class name identifies it. */
        char *cn = class_name_of(ctx, v);
        if (cn && !strcmp(cn, "SharedArrayBuffer")) {
            free(cn);
            arg_fail(st, path, "is a SharedArrayBuffer",
                     "binary data cannot cross a trap boundary — encode it (e.g. base64) first");
            return JS_EXCEPTION;
        }
        free(cn);
    }
    if (JS_IsDataView(v)) {
        arg_fail(st, path, "is a DataView",
                 "typed arrays cannot cross a trap boundary — convert to a plain array first");
        return JS_EXCEPTION;
    }
    {
        int t = JS_GetTypedArrayType(v);
        if (t >= 0) {
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "is a %s", typed_array_name(t));
            arg_fail(st, path, b.s,
                     "typed arrays cannot cross a trap boundary — convert to a plain array first");
            sb_free(&b);
            return JS_EXCEPTION;
        }
    }

    if (JS_IsArray(ctx, v)) {
        JSValue out = JS_NewArray(ctx);
        JSPropertyEnum *tab = NULL;
        JSPropertyEnum *stab = NULL;
        uint32_t n = 0, sn = 0, i;
        int64_t len = -1, expect = 0;
        char *extra_key = NULL;
        JSValue ret = out;
        if (JS_GetLength(ctx, v, &len) < 0) {
            JS_FreeValue(ctx, out);
            return arg_unreadable(ctx, st, path);
        }
        if (ancestors_push(st, JS_VALUE_GET_PTR(v), path) < 0) {
            JS_FreeValue(ctx, out);
            arg_fail(st, path, "could not be read (out of memory)",
                     "make the property readable or drop it");
            return JS_EXCEPTION;
        }
        /* Symbol keys (enumerable) are non-string keys: reject. */
        if (JS_GetOwnPropertyNames(ctx, &stab, &sn, v,
                                  JS_GPN_SYMBOL_MASK | JS_GPN_ENUM_ONLY)) {
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return arg_unreadable(ctx, st, path);
        }
        if (sn > 0) {
            JSValue keystr = JS_AtomToString(ctx, stab[0].atom);
            const char *c = JS_ToCString(ctx, keystr);
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "has a symbol key (%s)", c ? c : "?");
            arg_fail(st, path, b.s,
                     "JSON keys must be strings — drop the symbol key");
            sb_free(&b);
            if (c)
                JS_FreeCString(ctx, c);
            JS_FreeValue(ctx, keystr);
            JS_FreePropertyEnum(ctx, stab, sn);
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_FreePropertyEnum(ctx, stab, sn);
        /* Own string keys, integer indices first in ascending order:
         * a missing index below the length is a hole; any other key
         * is an extra key on the array. */
        if (JS_GetOwnPropertyNames(ctx, &tab, &n, v,
                                  JS_GPN_STRING_MASK)) {
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return arg_unreadable(ctx, st, path);
        }
        for (i = 0; i < n; i++) {
            JSValue keystr = JS_AtomToString(ctx, tab[i].atom);
            const char *k = JS_ToCString(ctx, keystr);
            int64_t idx;
            /* "length" is an own (non-enumerable) key of every array:
             * it is not an element and not an extra key. */
            if (k && !strcmp(k, "length")) {
                JS_FreeCString(ctx, k);
                JS_FreeValue(ctx, keystr);
                continue;
            }
            if (k && is_canonical_index(k, len, &idx)) {
                char *cpath;
                JSValue elem, copy;
                if (idx > expect) {
                    /* The first missing index is the hole. */
                    cpath = path_join_index(path, expect);
                    arg_fail(st, cpath, "is a hole in an array",
                             "fill the hole or use null — JSON.stringify would silently turn it into null");
                    free(cpath);
                    if (k)
                        JS_FreeCString(ctx, k);
                    JS_FreeValue(ctx, keystr);
                    ret = JS_EXCEPTION;
                    break;
                }
                expect = idx + 1;
                elem = JS_GetPropertyUint32(ctx, v, (uint32_t)idx);
                if (JS_IsException(elem)) {
                    cpath = path_join_index(path, idx);
                    JS_FreeValue(ctx, keystr);
                    if (k)
                        JS_FreeCString(ctx, k);
                    ret = arg_unreadable(ctx, st, cpath);
                    free(cpath);
                    break;
                }
                cpath = path_join_index(path, idx);
                copy = arg_clean(ctx, elem, cpath, depth + 1, st);
                JS_FreeValue(ctx, elem);
                free(cpath);
                if (JS_IsException(copy)) {
                    if (k)
                        JS_FreeCString(ctx, k);
                    JS_FreeValue(ctx, keystr);
                    ret = JS_EXCEPTION;
                    break;
                }
                if (JS_DefinePropertyValueUint32(ctx, out, (uint32_t)idx,
                                                 copy, JS_PROP_C_W_E) < 0) {
                    cpath = path_join_index(path, idx);
                    if (k)
                        JS_FreeCString(ctx, k);
                    JS_FreeValue(ctx, keystr);
                    ret = arg_unreadable(ctx, st, cpath);
                    free(cpath);
                    break;
                }
            } else if (k && !extra_key) {
                extra_key = strdup(k);
            }
            if (k)
                JS_FreeCString(ctx, k);
            JS_FreeValue(ctx, keystr);
        }
        JS_FreePropertyEnum(ctx, tab, n);
        if (!JS_IsException(ret) && expect < len) {
            /* Trailing hole: no key at or after the last present index. */
            char *cpath = path_join_index(path, expect);
            arg_fail(st, cpath, "is a hole in an array",
                     "fill the hole or use null — JSON.stringify would silently turn it into null");
            free(cpath);
            ret = JS_EXCEPTION;
        }
        if (!JS_IsException(ret) && extra_key) {
            char *cpath = path_join_dot(path, extra_key);
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "is an extra property \"%s\" on an array",
                      extra_key);
            arg_fail(st, cpath, b.s,
                     "move it to a plain object — JSON.stringify would silently drop it");
            sb_free(&b);
            free(cpath);
            ret = JS_EXCEPTION;
        }
        free(extra_key);
        ancestors_pop(st);
        if (JS_IsException(ret))
            JS_FreeValue(ctx, out);
        return ret;
    }

    /* Plain object: prototype must be Object.prototype or null.
     * Anything else is a class instance (Error, RegExp, Promise,
     * WeakMap, user classes, ...). */
    {
        JSValue proto = JS_GetPrototype(ctx, v);
        JSValue global, obj_ctor, obj_proto;
        int plain = 0;
        char *ctor_name = NULL;
        if (JS_IsException(proto))
            return arg_unreadable(ctx, st, path);
        if (JS_IsNull(proto)) {
            plain = 1;
        } else {
            global = JS_GetGlobalObject(ctx);
            obj_ctor = JS_GetPropertyStr(ctx, global, "Object");
            obj_proto = JS_IsException(obj_ctor)
                ? JS_EXCEPTION
                : JS_GetPropertyStr(ctx, obj_ctor, "prototype");
            JS_FreeValue(ctx, global);
            JS_FreeValue(ctx, obj_ctor);
            if (!JS_IsException(obj_proto) &&
                JS_VALUE_GET_PTR(proto) == JS_VALUE_GET_PTR(obj_proto))
                plain = 1;
            JS_FreeValue(ctx, obj_proto);
            clear_js_exception(ctx);
        }
        if (!plain) {
            struct strbuf b;
            ctor_name = ctor_name_of(ctx, v);
            sb_init(&b);
            sb_printf(&b, "is an instance of %s",
                      ctor_name ? ctor_name : "unknown");
            arg_fail(st, path, b.s,
                     "only plain objects cross a trap boundary — convert it to a plain object first (JSON.stringify would silently drop its methods)");
            sb_free(&b);
            free(ctor_name);
            JS_FreeValue(ctx, proto);
            return JS_EXCEPTION;
        }
        JS_FreeValue(ctx, proto);
    }
    {
        JSValue out = JS_NewObject(ctx);
        JSPropertyEnum *tab = NULL;
        JSPropertyEnum *stab = NULL;
        uint32_t n = 0, sn = 0, i;
        JSValue ret = out;
        if (ancestors_push(st, JS_VALUE_GET_PTR(v), path) < 0) {
            JS_FreeValue(ctx, out);
            arg_fail(st, path, "could not be read (out of memory)",
                     "make the property readable or drop it");
            return JS_EXCEPTION;
        }
        /* Enumerable symbol keys are non-string keys: reject. */
        if (JS_GetOwnPropertyNames(ctx, &stab, &sn, v,
                                  JS_GPN_SYMBOL_MASK | JS_GPN_ENUM_ONLY)) {
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return arg_unreadable(ctx, st, path);
        }
        if (sn > 0) {
            JSValue keystr = JS_AtomToString(ctx, stab[0].atom);
            const char *c = JS_ToCString(ctx, keystr);
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "has a symbol key (%s)", c ? c : "?");
            arg_fail(st, path, b.s,
                     "JSON keys must be strings — drop the symbol key");
            sb_free(&b);
            if (c)
                JS_FreeCString(ctx, c);
            JS_FreeValue(ctx, keystr);
            JS_FreePropertyEnum(ctx, stab, sn);
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return JS_EXCEPTION;
        }
        JS_FreePropertyEnum(ctx, stab, sn);
        if (JS_GetOwnPropertyNames(ctx, &tab, &n, v,
                                  JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY)) {
            ancestors_pop(st);
            JS_FreeValue(ctx, out);
            return arg_unreadable(ctx, st, path);
        }
        for (i = 0; i < n; i++) {
            JSValue keystr = JS_AtomToString(ctx, tab[i].atom);
            const char *k = JS_ToCString(ctx, keystr);
            JSValue elem, copy;
            char *cpath;
            /* DefineProperty (not SetProperty): "__proto__" must land
             * as an own data property, not a prototype setter. */
            if (!k) {
                JS_FreeValue(ctx, keystr);
                ret = arg_unreadable(ctx, st, path);
                break;
            }
            elem = JS_GetProperty(ctx, v, tab[i].atom);
            if (JS_IsException(elem)) {
                cpath = path_join_dot(path, k);
                JS_FreeCString(ctx, k);
                JS_FreeValue(ctx, keystr);
                ret = arg_unreadable(ctx, st, cpath);
                free(cpath);
                break;
            }
            cpath = path_join_dot(path, k);
            copy = arg_clean(ctx, elem, cpath, depth + 1, st);
            JS_FreeValue(ctx, elem);
            free(cpath);
            if (JS_IsException(copy)) {
                JS_FreeCString(ctx, k);
                JS_FreeValue(ctx, keystr);
                ret = JS_EXCEPTION;
                break;
            }
            if (JS_DefinePropertyValue(ctx, out, tab[i].atom, copy,
                                       JS_PROP_C_W_E) < 0) {
                cpath = path_join_dot(path, k);
                JS_FreeCString(ctx, k);
                JS_FreeValue(ctx, keystr);
                ret = arg_unreadable(ctx, st, cpath);
                free(cpath);
                break;
            }
            JS_FreeCString(ctx, k);
            JS_FreeValue(ctx, keystr);
        }
        JS_FreePropertyEnum(ctx, tab, n);
        ancestors_pop(st);
        if (JS_IsException(ret))
            JS_FreeValue(ctx, out);
        return ret;
    }
}

/* Validate a trap arg and build its clean copy. Returns the copy
 * (owned) or JS_EXCEPTION with *err_out set to the malloc'd message
 * (owned by the caller, NULL on success). */
static JSValue check_trap_arg(JSContext *ctx, JSValueConst arg,
                              char **err_out)
{
    struct arg_check st;
    JSValue copy;
    char *root = strdup("$");
    size_t i;
    st.err = NULL;
    st.ancestors = NULL;
    st.ancestor_paths = NULL;
    st.nanc = 0;
    st.capanc = 0;
    copy = arg_clean(ctx, arg, root, 0, &st);
    free(root);
    for (i = 0; i < st.nanc; i++)
        free(st.ancestor_paths[i]);
    free(st.ancestors);
    free(st.ancestor_paths);
    *err_out = st.err;
    return copy;
}

/* Throw the arg-boundary error (a real Error named JsonBoundaryError)
 * synchronously at the trap call site. Takes ownership of msg. */
static JSValue throw_arg_boundary(JSContext *ctx, char *msg)
{
    JSValue e = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, e, "message",
                      JS_NewString(ctx, msg ? msg : "trap arg is not clean JSON"));
    JS_SetPropertyStr(ctx, e, "name",
                      JS_NewString(ctx, "JsonBoundaryError"));
    free(msg);
    return JS_Throw(ctx, e);
}

/* Emit one event for the plugin: a JSON object on stderr, prefixed
 * "[durablets] ". The plugin records these (its journal) and maintains
 * its run registry from the lifecycle events. The core writes no
 * journal file itself — this is its only event channel. */
void durablets_emit_event(const char *json)
{
    fprintf(stderr, "[durablets] %s\n", json);
    fflush(stderr);
}

/* Last exception's "Name: message", stashed by print_exception so
 * the "failed" lifecycle event can name WHY the run failed (the
 * journal — and `agentts result` — must carry the reason, not just
 * that it failed). One C-host process handles one operation, so the
 * stash is consumed (cleared) by the single failed event it feeds. */
static char *g_last_exception = NULL;

/* Lifecycle event helper: {"event":"lifecycle","lifecycle":...,
 * "runId":...} with an optional numeric "kind" (2 = trap, 3 =
 * combinator, for "suspended"). A "failed" event carries an "error"
 * field with the last exception's "Name: message" when one was
 * stashed (the stash is cleared once consumed). */
static void emit_lifecycle(JSContext *ctx, const char *phase, int kind)
{
    char *run = current_run_id(ctx);
    struct strbuf b;
    sb_init(&b);
    if (kind >= 0)
        sb_printf(&b, "{\"event\":\"lifecycle\",\"lifecycle\":\"%s\","
                  "\"runId\":\"%s\",\"kind\":%d}", phase, run, kind);
    else if (!strcmp(phase, "failed") && g_last_exception) {
        /* JSON-escape via the engine (a hand-rolled escaper would
         * miss a quote or a newline in the message). */
        JSValue js = JS_NewString(ctx, g_last_exception);
        JSValue j = JS_JSONStringify(ctx, js, JS_UNDEFINED, JS_UNDEFINED);
        const char *s = NULL;
        if (!JS_IsException(j)) s = JS_ToCString(ctx, j);
        sb_printf(&b, "{\"event\":\"lifecycle\",\"lifecycle\":\"%s\","
                  "\"runId\":\"%s\",\"error\":%s}",
                  phase, run, s ? s : "\"?\"");
        if (s) JS_FreeCString(ctx, s);
        JS_FreeValue(ctx, j);
        JS_FreeValue(ctx, js);
        free(g_last_exception);
        g_last_exception = NULL;
    } else
        sb_printf(&b, "{\"event\":\"lifecycle\",\"lifecycle\":\"%s\","
                  "\"runId\":\"%s\"}", phase, run);
    durablets_emit_event(b.s);
    sb_free(&b);
    free(run);
}

/* Build a real CancellationError (a genuine Error object, name
 * "CancellationError") with the given message. Same shape as
 * rehydrate_error: JS_NewError plus own "message" and "name"
 * properties shadowing the prototype's. */
static JSValue make_cancellation_error(JSContext *ctx,
                                       const char *message)
{
    JSValue e = JS_NewError(ctx);
    JS_SetPropertyStr(ctx, e, "message",
                      JS_NewString(ctx, message ? message
                                                : "run cancelled"));
    JS_SetPropertyStr(ctx, e, "name",
                      JS_NewString(ctx, "CancellationError"));
    return e;
}

/* Sticky cancellation (Q14): 1 once the run's cancellation token has
 * been delivered. Heap global, so it rides along in the snapshot. */
static int is_cancelled(JSContext *ctx)
{
    return get_global_int(ctx, "__cancelled", 0) != 0;
}

/* Throw a CancellationError immediately (no dispatch, no suspension,
 * no event) for a trap/combinator call on a cancelled run.
 * Reuses the stored cancel reason, so the refusal carries the same
 * why as the cancellation itself. */
static JSValue throw_cancelled(JSContext *ctx)
{
    char *reason = get_global_cstring(ctx, "__cancel_reason");
    JSValue err = make_cancellation_error(ctx, reason);
    free(reason);
    return JS_Throw(ctx, err);
}

/* __agentts_begin(): the driver's marker (see g_in_workflow above).
 * Called by the host-generated driver before it calls the entry
 * function, from global code. It only sets the flag — it never calls
 * into JS, so the entry function's suspension is unaffected (the
 * entry is still called from plain JS global code, never on behalf
 * of native code). */
static JSValue js_agentts_begin(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    g_in_workflow = 1;
    return JS_UNDEFINED;
}

/* Throw the workflow-entry error: a trap/combinator called outside
 * the entry function. Names the call (trap("job"), all(), ...) so
 * the author sees exactly which call is misplaced. */
static JSValue throw_not_in_workflow(JSContext *ctx, const char *what)
{
    return JS_ThrowTypeError(
        ctx,
        "%s must be called under the workflow function — move the call "
        "inside the exported entry function (or a helper it calls)",
        what);
}

/* trap(type, arg): the core's single dispatch point (plan doc §8).
 * Dispatches by type string — the core only routes; the plugin
 * interprets the type (job, exec, gate, sleep, cron, decide). Emits
 * the trap event (trapId = runId + "/trap-N", the Q9 identity), then
 * suspends. On a cancelled run it throws a CancellationError
 * immediately instead (sticky, Q14) — no event, no suspension, no
 * dispatch. The arg is checked FIRST (trap-boundary JSON rule, BRA-43
 * follow-up): a dirty arg throws a JsonBoundaryError synchronously at
 * the call site — no trap event, no ordinal consumed, no suspension,
 * no blob — and only the validated clean copy is serialized for the
 * trap event (a Date crosses as its ISO string). */
static JSValue js_trap(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    JSValue arg = argc > 1 ? argv[1] : JS_UNDEFINED;
    const char *type_c = NULL;
    char *type_s = NULL, *arg_json, *run, *trap_id;
    char *arg_err = NULL;
    JSValue clean_arg;
    int64_t ordinal;
    struct strbuf b;
    /* Workflow-entry guard: a trap outside the entry function fails
     * immediately — no event, no ordinal consumed, no suspension.
     * Names the trap type when it is a string. */
    if (!g_in_workflow) {
        const char *t = NULL;
        char what[160];
        if (argc >= 1 && JS_IsString(argv[0]))
            t = JS_ToCString(ctx, argv[0]);
        if (t) {
            snprintf(what, sizeof(what), "trap(\"%s\")", t);
            JS_FreeCString(ctx, t);
        } else {
            snprintf(what, sizeof(what), "trap()");
        }
        return throw_not_in_workflow(ctx, what);
    }
    if (is_cancelled(ctx))
        return throw_cancelled(ctx);
    if (argc < 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(ctx, "trap(type, arg) needs a type string");
    type_c = JS_ToCString(ctx, argv[0]);
    if (!type_c)
        return JS_EXCEPTION;
    type_s = strdup(type_c);
    JS_FreeCString(ctx, type_c);
    /* Arg-in JSON check, before suspending: a dirty arg throws
     * synchronously here and never dispatches. The clean copy is what
     * gets serialized below (its Date values are already ISO strings,
     * and JSON.stringify can no longer silently drop anything). */
    clean_arg = check_trap_arg(ctx, arg, &arg_err);
    if (JS_IsException(clean_arg)) {
        free(type_s);
        return throw_arg_boundary(ctx, arg_err);
    }
    fprintf(stderr, "[host] trap(%s) — suspending\n", type_s);

    ordinal = get_global_int(ctx, "__trap_count", 0);
    set_global_int(ctx, "__trap_count", ordinal + 1);
    arg_json = json_stringify(ctx, clean_arg);
    JS_FreeValue(ctx, clean_arg);
    run = current_run_id(ctx);
    sb_init(&b);
    sb_printf(&b, "%s/trap-%" PRId64, run, ordinal);
    trap_id = strdup(b.s);
    sb_free(&b);
    sb_init(&b);
    sb_printf(&b, "{\"event\":\"trap\",\"runId\":\"%s\",\"trapId\":\"%s\","
              "\"ordinal\":%" PRId64 ",\"type\":\"%s\",\"arg\":%s}",
              run, trap_id, ordinal, type_s,
              arg_json ? arg_json : "null");
    durablets_emit_event(b.s);
    sb_free(&b);
    free(arg_json);
    free(run);
    free(trap_id);
    free(type_s);
    g_suspend_kind = 2;
    return JS_SuspendCall(ctx);
}

/* Throw new AggregateError([], "All branches failed") — the
 * Promise.any([]) shape. Returns JS_EXCEPTION; the thrown value is
 * owned by the exception. */
static JSValue throw_aggregate_empty(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue ctor = JS_GetPropertyStr(ctx, global, "AggregateError");
    JSValue errors = JS_NewArray(ctx);
    JSValue msg = JS_NewString(ctx, "All branches failed");
    JSValue args[2];
    JSValue e;
    args[0] = errors;
    args[1] = msg;
    e = JS_Call(ctx, ctor, JS_UNDEFINED, 2, args);
    JS_FreeValue(ctx, ctor);
    JS_FreeValue(ctx, errors);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, global);
    if (JS_IsException(e))
        return JS_EXCEPTION;
    return JS_Throw(ctx, e);
}

/* The combinator builtins: all / any / race (Q13). All three stash the
 * thunks array under a fresh Symbol key on the global object (the
 * hidden spot from Q13), emit the fork event, then suspend. The
 * driver joins per the combinator's rule.
 *   all(thunks[, failFast]): an empty array returns [] immediately —
 *     no fork, no suspension (Promise.all([])). failFast is an
 *     optional boolean second argument: omitted or false is
 *     collect-all; true is fail-fast (the driver joins with bare
 *     values on success, join-throw on the first branch error).
 *   any(thunks): an empty array throws an AggregateError with no
 *     errors immediately — no fork, no suspension (Promise.any([])).
 *     The driver joins with the first success's bare value
 *     (join-value), or with an AggregateError of all branch errors
 *     if every branch fails (join-aggregate).
 *   race(thunks): an empty array suspends on a 0-branch fork and
 *     never settles (Promise.race([])) — the driver has nothing to
 *     spawn and nothing to join, so the run stays suspended. The
 *     driver joins with the first settler's result (join-value on
 *     success, join-throw on failure). */
static JSValue js_combinator_impl(JSContext *ctx, JSValueConst *argv,
                                  int argc, const char *kind)
{
    JSValue global, sym, len_v;
    int64_t n = -1, i, fork_n;
    int fail_fast = 0;
    int is_any = !strcmp(kind, "any");
    int is_race = !strcmp(kind, "race");
    char *run, *fork_id;
    struct strbuf b;
    /* Workflow-entry guard: a combinator outside the entry function
     * fails immediately — no fork event, no stash, no suspension. */
    if (!g_in_workflow) {
        char what[160];
        snprintf(what, sizeof(what), "%s()", kind);
        return throw_not_in_workflow(ctx, what);
    }
    /* Sticky cancellation (Q14): a combinator call on a cancelled run
     * throws immediately — no fork event, no stash, no suspension. */
    if (is_cancelled(ctx))
        return throw_cancelled(ctx);
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "%s() needs an array of thunks",
                                 kind);
    len_v = JS_GetPropertyStr(ctx, argv[0], "length");
    if (!JS_IsException(len_v))
        JS_ToInt64(ctx, &n, len_v);
    JS_FreeValue(ctx, len_v);
    if (n == 0) {
        if (is_any)
            return throw_aggregate_empty(ctx);
        if (!is_race)
            return JS_NewArray(ctx); /* all([]) -> [] */
        /* race([]): fall through to a 0-branch fork; it never settles. */
    }
    if (argc >= 2 && !is_any && !is_race)
        fail_fast = JS_ToBool(ctx, argv[1]) == 1;
    fprintf(stderr, "[host] %s(%" PRId64 " branches%s) — stashing "
            "thunks, suspending\n", kind, n,
            (!is_any && !is_race && fail_fast) ? ", fail-fast" : "");

    /* Fork event: fork id is (run id, ordinal), child run ids derive.
     * failFast is an all-only field. */
    run = current_run_id(ctx);
    fork_n = get_global_int(ctx, "__fork_count", 0);
    set_global_int(ctx, "__fork_count", fork_n + 1);
    sb_init(&b);
    sb_printf(&b, "%s/fork-%" PRId64, run, fork_n);
    fork_id = strdup(b.s);
    sb_free(&b);
    sb_init(&b);
    sb_printf(&b, "{\"event\":\"fork\",\"runId\":\"%s\",\"forkId\":\"%s\","
              "\"kind\":\"%s\",\"branches\":%" PRId64,
              run, fork_id, kind, n);
    if (!is_any && !is_race)
        sb_printf(&b, ",\"failFast\":%s", fail_fast ? "true" : "false");
    sb_printf(&b, ",\"childRuns\":[");
    for (i = 0; i < n; i++)
        sb_printf(&b, "%s\"%s/branch-%" PRId64 "\"", i ? "," : "",
                  fork_id, i);
    sb_printf(&b, "]}");
    durablets_emit_event(b.s);
    sb_free(&b);
    free(run);
    free(fork_id);

    global = JS_GetGlobalObject(ctx);
    sym = JS_NewSymbol(ctx, "agentts:stash", 0);
    /* JS_SetPropertyValue frees prop and val: dup the thunks array. */
    /* NB: JS_SetProperty* returns TRUE on success, -1 on failure. */
    if (JS_SetPropertyValue(ctx, global, sym,
                            JS_DupValue(ctx, argv[0]), JS_PROP_THROW) < 0) {
        JS_FreeValue(ctx, global);
        return JS_EXCEPTION;
    }
    JS_FreeValue(ctx, global);
    g_suspend_kind = 3;
    return JS_SuspendCall(ctx);
}

static JSValue js_all(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    return js_combinator_impl(ctx, argv, argc, "all");
}

static JSValue js_any(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    return js_combinator_impl(ctx, argv, argc, "any");
}

static JSValue js_race(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    return js_combinator_impl(ctx, argv, argc, "race");
}

static const void * const durablets_natives[] = {
    (const void *)js_print,
    (const void *)js_trap,
    (const void *)js_all,
    (const void *)js_any,
    (const void *)js_race,
    (const void *)js_agentts_begin,
};

const JSSnapshotHost durablets_host = {
    .natives = durablets_natives,
    .native_count = 6,
};

static void print_exception(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);
    JSValue name, msg, js;
    const char *str;
    fprintf(stderr, "exception: isError=%d\n", JS_IsError(ctx, exc) ? 1 : 0);
    name = JS_GetPropertyStr(ctx, exc, "name");
    msg = JS_GetPropertyStr(ctx, exc, "message");
    if (!JS_IsException(name) && !JS_IsException(msg)) {
        const char *n = JS_ToCString(ctx, name);
        const char *m = JS_ToCString(ctx, msg);
        fprintf(stderr, "exception: %s: %s\n", n ? n : "?",
                m ? m : "?");
        /* Stash "Name: message" for the "failed" lifecycle event
         * (emit_lifecycle consumes and clears it). */
        free(g_last_exception);
        g_last_exception = NULL;
        if (n || m) {
            size_t need = strlen(n ? n : "?") + strlen(m ? m : "?") + 4;
            g_last_exception = malloc(need);
            if (g_last_exception)
                snprintf(g_last_exception, need, "%s: %s",
                         n ? n : "?", m ? m : "?");
        }
        if (n) JS_FreeCString(ctx, n);
        if (m) JS_FreeCString(ctx, m);
    }
    js = JS_JSONStringify(ctx, exc, JS_UNDEFINED, JS_UNDEFINED);
    if (!JS_IsException(js)) {
        str = JS_ToCString(ctx, js);
        fprintf(stderr, "exception: json=%s\n", str ? str : "?");
        if (str) JS_FreeCString(ctx, str);
    }
    JS_FreeValue(ctx, name);
    JS_FreeValue(ctx, msg);
    JS_FreeValue(ctx, js);
    str = JS_ToCString(ctx, exc);
    fprintf(stderr, "exception: tostring=%s\n", str ? str : "?");
    if (str) JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, exc);
}

/* BRA-171: read a whole file into a NUL-terminated buffer, or NULL
 * when it cannot be read (missing, directory, short read). Unlike
 * load_file, this never exits: the caller reports the failure
 * loudly instead of dying mid-slice. */
static char *read_text_file(const char *filename)
{
    FILE *f = fopen(filename, "rb");
    char *buf;
    long len;
    if (!f) return NULL;
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    len = ftell(f);
    if (len < 0) {
        fclose(f);
        return NULL;
    }
    if (fseek(f, 0, SEEK_SET) != 0) {
        fclose(f);
        return NULL;
    }
    buf = malloc((size_t)len + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (len > 0 && fread(buf, 1, (size_t)len, f) != (size_t)len) {
        free(buf);
        fclose(f);
        return NULL;
    }
    buf[len] = '\0';
    fclose(f);
    return buf;
}

static uint8_t *load_file(const char *filename, size_t *plen)
{
    FILE *f = fopen(filename, "rb");
    uint8_t *buf;
    long len;
    if (!f) {
        perror(filename);
        exit(1);
    }
    fseek(f, 0, SEEK_END);
    len = ftell(f);
    fseek(f, 0, SEEK_SET);
    buf = malloc(len + 1);
    if (fread(buf, 1, len, f) != (size_t)len) {
        perror(filename);
        exit(1);
    }
    buf[len] = '\0';
    fclose(f);
    *plen = len;
    return buf;
}

/* ---- BRA-90: incremental snapshots (hash-linked chain) ----
 *
 * The snapshot chain is always on (one mode, no threshold). The
 * TypeScript host owns the chain: it names the keyframe by content
 * hash, records each checkpoint in a manifest, and decides per
 * slice whether this suspension writes a base (keyframe) or a
 * delta. This file is only the snapshot engine -- it obeys two
 * per-slice instructions passed in the environment:
 *
 *   DURABLETS_SAVE_MODE=base|delta
 *       What save_snapshot writes. "base" writes a full snapshot
 *       with JS_SNAPSHOT_BASE (which becomes the runtime's base,
 *       replacing any previous one); "delta" writes
 *       JS_SNAPSHOT_DELTA against the attached base. Default is
 *       "base" -- a fresh run, a legacy resume, or any direct use
 *       of this binary writes a full snapshot, exactly as before.
 *       A delta write with no base attached fails loudly
 *       (JS_WriteSnapshot returns NULL).
 *   DURABLETS_BASE_PATH=<path>
 *       The keyframe file to read alongside the snapshot file on
 *       resume/branch/join/cancel. When set, the snapshot file is
 *       read as a delta against that base; when unset, the snapshot
 *       file is read as a plain full snapshot (the legacy path,
 *       kept so blobs written before the chain still resume).
 *
 * The engine itself verifies a delta against its base (a wrong
 * pair fails JS_ReadSnapshot loudly with "the delta was not
 * written from this base"; a truncated file fails loudly too), so
 * a mismatched or torn checkpoint is a loud failure, never a
 * silently wrong resume. A missing base file exits loudly in
 * load_file.
 *
 * Resume loads ONE keyframe + ONE delta, never a replay: deltas
 * are not chained (each one only needs the base). Keyframing is
 * the host's rebase rule (DURABLETS_KEYFRAME_INTERVAL, default
 * 25 suspensions, 0 = full snapshot every suspension); this file
 * never decides it.
 */
static int bra90_save_delta(void)
{
    const char *v = getenv("DURABLETS_SAVE_MODE");
    return v && !strcmp(v, "delta");
}

/* Pair-aware snapshot load for resume/branch/join/cancel.
 * Returns 0 on success, 1 on failure (message already printed). */
static int read_snapshot(JSRuntime *rt, const char *filename,
                         JSSnapshotResult *res)
{
    char err[256];
    const char *base_path = getenv("DURABLETS_BASE_PATH");
    if (base_path && base_path[0]) {
        size_t blen, dlen;
        uint8_t *bbuf = load_file(base_path, &blen);
        uint8_t *dbuf = load_file(filename, &dlen);
        int rc = JS_ReadSnapshot(rt, bbuf, blen, dbuf, dlen,
                                 &durablets_host, res, err, sizeof(err));
        if (rc) {
            fprintf(stderr, "%s + %s: %s\n", base_path, filename, err);
            free(bbuf);
            free(dbuf);
            return 1;
        }
        free(bbuf);
        free(dbuf);
        return 0;
    }
    {
        size_t len;
        uint8_t *buf = load_file(filename, &len);
        int rc = JS_ReadSnapshot(rt, buf, len, NULL, 0, &durablets_host,
                                 res, err, sizeof(err));
        if (rc) {
            fprintf(stderr, "%s: %s\n", filename, err);
            free(buf);
            return 1;
        }
        free(buf);
        return 0;
    }
}

static int save_snapshot(JSContext *ctx, const char *filename)
{
    size_t size;
    /* BRA-90: the host decides per slice (DURABLETS_SAVE_MODE);
     * "base" is the default, so a fresh run or a direct use of
     * this binary writes a full snapshot exactly as before -- only
     * now it is a BASE snapshot, which is itself a complete,
     * restorable snapshot and also becomes the runtime's base. */
    int delta = bra90_save_delta();
    uint8_t *buf = JS_WriteSnapshot(ctx, &size, &durablets_host, NULL, 0,
                                    delta ? JS_SNAPSHOT_DELTA : JS_SNAPSHOT_BASE);
    int rc;
    if (!buf) {
        print_exception(ctx);
        return 1;
    }
    /* G4 (BRA-83): atomic — tmp + fsync + rename, so a kill
     * mid-write leaves the previous live snapshot intact (old or
     * new, never torn). A failure here returns 1 before the old
     * snapshot is touched, and save() fails the slice loudly. */
    rc = write_file_atomic(filename, buf, size);
    js_free(ctx, buf);
    if (rc != 0)
        return 1;
    fprintf(stderr, "[host] snapshot saved: %s (%zu bytes, %s)\n", filename, size,
            delta ? "delta" : "base");
    return 0;
}

/* Save the state and free the runtime. Exit code 2 = suspended at a trap,
 * 3 = suspended at a combinator. */
static int save(JSRuntime *rt, JSContext *ctx, const char *snap)
{
    if (save_snapshot(ctx, snap))
        return 1;
    emit_lifecycle(ctx, "suspended", g_suspend_kind);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return g_suspend_kind;
}

/* Drain pending jobs. Returns 0 done, 1 error, 2/3 suspended (saved).
 * Sync-only workflows create no jobs, so a drain that ends without a
 * suspension means the workflow is done. */
static int finish_slice(JSRuntime *rt, JSContext *ctx, const char *snap)
{
    JSContext *ctx1;
    int ret;
    while ((ret = JS_ExecutePendingJob(rt, &ctx1)) > 0) {
        if (JS_IsSuspended(rt))
            return save(rt, ctx, snap);
    }
    if (ret < 0) {
        if (JS_IsSuspended(rt))
            return save(rt, ctx, snap);
        print_exception(ctx1);
        return 1;
    }
    if (JS_IsSuspended(rt))
        return save(rt, ctx, snap);
    return 0;
}

static JSValue parse_result(JSContext *ctx, const char *json)
{
    JSValue v = JS_ParseJSON(ctx, json, strlen(json), "<result>");
    if (JS_IsException(v))
        print_exception(ctx);
    return v;
}

/* ---- branch outcomes ---- */

/* Serialize a thrown value as an error record: { name, message } for
 * Error objects, the raw value otherwise (Q13: a thrown non-Error
 * crosses as-is). */
static JSValue serialize_error(JSContext *ctx, JSValueConst exc)
{
    if (JS_IsError(ctx, exc)) {
        JSValue obj = JS_NewObject(ctx);
        JSValue name = JS_GetPropertyStr(ctx, exc, "name");
        JSValue msg = JS_GetPropertyStr(ctx, exc, "message");
        /* JS_SetPropertyStr consumes its value argument. */
        JS_SetPropertyStr(ctx, obj, "name",
                          JS_IsException(name) ? JS_NewString(ctx, "Error")
                                               : name);
        JS_SetPropertyStr(ctx, obj, "message",
                          JS_IsException(msg) ? JS_NewString(ctx, "")
                                              : msg);
        return obj;
    }
    return JS_DupValue(ctx, exc);
}

/* Rehydrate an error record { name, message } into a real Error object
 * (Q13: branch errors cross the process boundary as records and are
 * rehydrated as Errors in the parent, where a combinator throws them).
 * A thrown non-Error crosses as-is, so any other JSON value is
 * returned unchanged. */
static JSValue rehydrate_error(JSContext *ctx, JSValueConst err)
{
    JSValue name, msg;
    if (!JS_IsObject(err))
        return JS_DupValue(ctx, err);
    name = JS_GetPropertyStr(ctx, err, "name");
    msg = JS_GetPropertyStr(ctx, err, "message");
    if (!JS_IsException(name) && !JS_IsException(msg) &&
        JS_IsString(name) && JS_IsString(msg)) {
        JSValue e = JS_NewError(ctx);
        /* JS_NewError gives message undefined; set message and name
         * (shadowing the prototype's "name"). */
        JS_SetPropertyStr(ctx, e, "message", JS_DupValue(ctx, msg));
        JS_SetPropertyStr(ctx, e, "name", JS_DupValue(ctx, name));
        JS_FreeValue(ctx, name);
        JS_FreeValue(ctx, msg);
        return e;
    }
    JS_FreeValue(ctx, name);
    JS_FreeValue(ctx, msg);
    return JS_DupValue(ctx, err);
}

/* { ok: true, value } or { ok: false, error }. */
static JSValue make_outcome(JSContext *ctx, int ok, JSValueConst val)
{
    JSValue obj = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, obj, "ok", JS_NewBool(ctx, ok));
    JS_SetPropertyStr(ctx, obj, ok ? "value" : "error",
                      JS_DupValue(ctx, val));
    return obj;
}

/* Journal the branch-done event for this run. */
static void record_branch_done(JSContext *ctx, JSValueConst outcome)
{
    char *run = current_run_id(ctx);
    char *parent = get_global_cstring(ctx, "__parent_fork");
    char *ojson = json_stringify(ctx, outcome);
    int64_t i = get_global_int(ctx, "__branch_index", -1);
    struct strbuf b;
    sb_init(&b);
    sb_printf(&b, "{\"event\":\"branch-done\",\"runId\":\"%s\","
              "\"parentForkId\":\"%s\",\"branch\":%" PRId64
              ",\"outcome\":%s}", run, parent ? parent : "",
              i, ojson ? ojson : "null");
    durablets_emit_event(b.s);
    sb_free(&b);
    free(run);
    free(parent);
    free(ojson);
}

/* Print the branch outcome on stdout as "branch <i> outcome: <json>".
 * The plugin reads it from the child's stdout — the core writes no
 * outcome file. */
static void write_outcome(JSContext *ctx, JSValueConst outcome)
{
    char *json = json_stringify(ctx, outcome);
    int64_t i = get_global_int(ctx, "__branch_index", -1);
    if (json) {
        printf("branch %" PRId64 " outcome: %s\n", i, json);
        fflush(stdout);
    }
    free(json);
}

/* Complete a branch run with an outcome: emit branch-done, print it,
 * and emit the lifecycle "completed" — the plugin closes the branch's
 * registry entry from this event (branch-done alone does not close
 * it). Every branch completion flows through here, success or error. */
static void finish_branch(JSContext *ctx, JSValueConst outcome)
{
    record_branch_done(ctx, outcome);
    write_outcome(ctx, outcome);
    emit_lifecycle(ctx, "completed", -1);
}

/* Is this run a branch run? (__branch_index is set.) */
static int is_branch_run(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue idx = JS_GetPropertyStr(ctx, global, "__branch_index");
    int is = !JS_IsException(idx) && !JS_IsUndefined(idx);
    JS_FreeValue(ctx, idx);
    JS_FreeValue(ctx, global);
    return is;
}

/* Complete a branch run with a failed outcome from a thrown value. */
static void finish_branch_error(JSContext *ctx, JSValueConst exc)
{
    JSValue err = serialize_error(ctx, exc);
    JSValue outcome = make_outcome(ctx, 0, err);
    finish_branch(ctx, outcome);
    JS_FreeValue(ctx, err);
    JS_FreeValue(ctx, outcome);
}

/* Find the stashed thunks array: the first array-valued property under
 * a symbol key on the global object. Returns 1 and fills *atom_out and
 * *val_out (owned) if found, else 0. */
static int find_stash(JSContext *ctx, JSAtom *atom_out, JSValue *val_out)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0, i;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, global,
                               JS_GPN_SYMBOL_MASK)) {
        JS_FreeValue(ctx, global);
        return 0;
    }
    fprintf(stderr, "[host] global has %u symbol-keyed propert%s\n", len,
            len == 1 ? "y" : "ies");
    for (i = 0; i < len; i++) {
        JSValue v = JS_GetProperty(ctx, global, tab[i].atom);
        JSValue keystr = JS_AtomToString(ctx, tab[i].atom);
        const char *ks = JS_ToCString(ctx, keystr);
        fprintf(stderr, "[host] symbol key: %s -> %s\n", ks ? ks : "?",
                JS_IsException(v) ? "<exception>" :
                JS_IsArray(ctx, v) ? "array (stash?)" : "other");
        if (ks)
            JS_FreeCString(ctx, ks);
        JS_FreeValue(ctx, keystr);
        if (!JS_IsException(v) && JS_IsArray(ctx, v)) {
            /* Dup the atom: JS_FreePropertyEnum frees every atom in
             * the tab, including this one. */
            *atom_out = JS_DupAtom(ctx, tab[i].atom);
            *val_out = v;
            JS_FreePropertyEnum(ctx, tab, len);
            JS_FreeValue(ctx, global);
            return 1;
        }
        JS_FreeValue(ctx, v);
    }
    JS_FreePropertyEnum(ctx, tab, len);
    JS_FreeValue(ctx, global);
    return 0;
}

/* Delete the stash symbol property from the global object (Q13: the
 * stash is removed on every resume path). The stash value is freed. */
static void delete_stash(JSContext *ctx)
{
    JSAtom atom;
    JSValue val;
    JSValue global;
    if (!find_stash(ctx, &atom, &val))
        return;
    global = JS_GetGlobalObject(ctx);
    JS_DeleteProperty(ctx, global, atom, 0);
    JS_FreeAtom(ctx, atom);
    JS_FreeValue(ctx, val);
    JS_FreeValue(ctx, global);
    fprintf(stderr, "[host] stash removed from the global object\n");
}

/* The native registry: print, trap, all, any, race, __agentts_begin —
 * in this order. Appended builtins go after race so existing natives
 * keep their snapshot indices. */
void durablets_register(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "trap",
                      JS_NewCFunction(ctx, js_trap, "trap", 2));
    JS_SetPropertyStr(ctx, global, "all",
                      JS_NewCFunction(ctx, js_all, "all", 1));
    JS_SetPropertyStr(ctx, global, "any",
                      JS_NewCFunction(ctx, js_any, "any", 1));
    JS_SetPropertyStr(ctx, global, "race",
                      JS_NewCFunction(ctx, js_race, "race", 1));
    JS_SetPropertyStr(ctx, global, "__agentts_begin",
                      JS_NewCFunction(ctx, js_agentts_begin,
                                      "__agentts_begin", 0));
    JS_FreeValue(ctx, global);
}

/* Set the heap globals for a fresh run from the environment. No
 * journal path: the core keeps no journal. */
static void set_run_context(JSContext *ctx)
{
    const char *run_id = getenv("AGENTTS_RUN_ID");
    set_global_str(ctx, "__run_id", run_id ? run_id : "run-parent");
    set_global_int(ctx, "__fork_count", 0);
    set_global_int(ctx, "__trap_count", 0);
    set_global_int(ctx, "__cancelled", 0);
}

/* Set the heap globals for a branch run from the environment (after a
 * snapshot restore). */
static void set_branch_context(JSContext *ctx)
{
    const char *run_id = getenv("AGENTTS_RUN_ID");
    const char *parent_fork = getenv("AGENTTS_PARENT_FORK");
    set_global_str(ctx, "__run_id", run_id ? run_id : "run-branch");
    set_global_str(ctx, "__parent_fork",
                   parent_fork ? parent_fork : "");
    /* A branch is a fresh run for fork/trap ordinals: its own forks
     * count from 0 under its own run id. It also starts uncancelled:
     * cancellation of a branch arrives via the plugin (the cancel
     * path), never by inheriting the parent's token. */
    set_global_int(ctx, "__fork_count", 0);
    set_global_int(ctx, "__trap_count", 0);
    set_global_int(ctx, "__cancelled", 0);
}

int main(int argc, char **argv)
{
    JSRuntime *rt;
    JSContext *ctx;
    JSValue val, global;
    uint8_t *buf;
    size_t len;

    if (argc == 4 && !strcmp(argv[1], "run")) {
        buf = load_file(argv[2], &len);
        rt = JS_NewRuntime();
        ctx = JS_NewContext(rt);
        durablets_register(ctx);
        set_run_context(ctx);

        emit_lifecycle(ctx, "started", -1);
        val = JS_Eval(ctx, (char *)buf, len, argv[2],
                      JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_TYPESCRIPT);
        free(buf);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[3]);
            /* print_exception first: it stashes the "Name: message"
             * that the failed lifecycle event carries. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        /* Capture the completion value as the run result (the entry
         * function's return value) before freeing it: finish_slice
         * may suspend and free the runtime, so the string must be
         * taken now. Written only if the run actually completes. */
        char *result_json = json_stringify(ctx, val);
        if (!result_json || !strcmp(result_json, "undefined")) {
            free(result_json);
            result_json = strdup("null");
        }
        JS_FreeValue(ctx, val);
        {
            int rc = finish_slice(rt, ctx, argv[3]);
            if (rc == 0) {
                write_result_json(result_json, argv[3]);
                emit_lifecycle(ctx, "completed", -1);
            } else if (rc == 1)
                emit_lifecycle(ctx, "failed", -1);
            free(result_json);
            return rc;
        }
    }

    if (argc == 4 && !strcmp(argv[1], "resume")) {
        JSSnapshotResult res;
        int throw_flag = 0, rc, branch;
        const char *result_json = argv[3];
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);

        if (!strncmp(result_json, "throw:", 6)) {
            throw_flag = 1;
            result_json += 6;
        }
        /* BRA-171: a result over the inline argv cap arrives as
         * `agentts-file:<path>` (the TS host writes the JSON to a
         * scratch file and passes the marker); small results still
         * arrive inline. The marker starts with `a`, which no JSON
         * document starts with, so it can never collide with an
         * inline result. A missing or unreadable file fails LOUDLY
         * — a lifecycle `failed` event plus a named stderr line —
         * never a resume with a wrong or empty result. The buffer is
         * freed right after parsing: parse_result copies the text
         * into a value, so nothing below needs the raw string. */
        char *result_file_buf = NULL;
        if (!strncmp(result_json, "agentts-file:", 13)) {
            result_file_buf = read_text_file(result_json + 13);
            if (!result_file_buf) {
                fprintf(stderr, "durablets: cannot read result file %s\n", result_json + 13);
                emit_lifecycle(ctx, "failed", -1);
                return 1;
            }
            result_json = result_file_buf;
        }
        val = parse_result(ctx, result_json);
        free(result_file_buf);
        if (JS_IsException(val))
            return 1;
        if (JS_IsSuspended(rt)) {
            emit_lifecycle(ctx, "resumed", -1);
            /* Emit the trap completing with this result (or error)
             * before JS_ResumeWith frees it. The trap being resumed is
             * ordinal __trap_count - 1. */
            JSValue result = val;
            char *rjson = json_stringify(ctx, result);
            char *run = current_run_id(ctx);
            int64_t ordinal = get_global_int(ctx, "__trap_count", 0) - 1;
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "{\"event\":\"%s\",\"runId\":\"%s\",\"trapId\":\"%s/trap-%"
                      PRId64 "\",\"ordinal\":%" PRId64 ",\"%s\":%s}",
                      throw_flag ? "trap-error" : "trap-result", run, run,
                      ordinal, ordinal, throw_flag ? "error" : "result",
                      rjson ? rjson : "null");
            durablets_emit_event(b.s);
            sb_free(&b);
            free(rjson);
            free(run);
            /* BRA-41: a resume-with-throw rehydrates the {name,message}
             * error record into a real Error before throwing it at the
             * trap call site — a throwing trap arrives as a real Error
             * (instanceof Error true), not a raw string or plain
             * object. Non-object throws cross as-is. */
            if (throw_flag) {
                /* rehydrate_error returns a NEW value (a fresh Error
                 * for a record, a dup for anything else) and does not
                 * consume its input — free the parsed value, or the
                 * leaked heap object trips JS_FreeRuntime's
                 * list_empty assertion at save time. */
                JSValue rehydrated = rehydrate_error(ctx, result);
                JS_FreeValue(ctx, result);
                result = rehydrated;
            }
            /* The pending trap() call completes with the result — or
             * throws it, if throw_flag is set. */
            val = JS_ResumeWith(ctx, result, throw_flag);
            if (JS_IsException(val)) {
                if (JS_IsSuspended(rt))
                    return save(rt, ctx, argv[2]);
                /* The resumed execution threw (uncaught) and the run
                 * fails: record the failed lifecycle event (with the
                 * stashed exception message) — without it the journal
                 * ends at the trap-result and the failure has no
                 * recorded reason. In a branch run that is a failed
                 * outcome, not a host error. */
                if (branch) {
                    JSValue exc = JS_GetException(ctx);
                    finish_branch_error(ctx, exc);
                    JS_FreeValue(ctx, exc);
                    return 0;
                }
                print_exception(ctx);
                emit_lifecycle(ctx, "failed", -1);
                return 1;
            }
            rc = finish_slice(rt, ctx, argv[2]);
            if (rc == 0 && branch) {
                JSValue outcome = make_outcome(ctx, 1, val);
                finish_branch(ctx, outcome);
                JS_FreeValue(ctx, outcome);
            }
            if (rc == 0 && !branch) {
                /* The run completed: capture the completion value as
                 * the run result (<snap>.result.json) for
                 * `agentts result`. */
                write_run_result(ctx, val, argv[2]);
                emit_lifecycle(ctx, "completed", -1);
            } else if (rc == 1 && !branch)
                emit_lifecycle(ctx, "failed", -1);
            if (rc != 2 && rc != 3)
                JS_FreeValue(ctx, val);
            return rc;
        }
        fprintf(stderr, "[host] restored runtime is not suspended; "
                "nothing to resume\n");
        JS_FreeValue(ctx, val);
        return 1;
    }

    if (argc == 4 && !strcmp(argv[1], "branch")) {
        JSSnapshotResult res;
        char driver[64];
        int index = atoi(argv[3]);
        JSAtom atom;
        JSValue stash;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        set_branch_context(ctx);
        emit_lifecycle(ctx, "resumed", -1);
        fprintf(stderr, "[host] restored runtime suspended=%d before "
                "driver eval\n", JS_IsSuspended(rt) ? 1 : 0);

        /* ABANDON: the restored runtime still holds the parent's
         * suspended all() call, and the engine allows only one
         * suspended execution at a time (js_can_suspend_from:
         * rt->suspended != NULL -> the thunk's trap() throws "this
         * call cannot be suspended"). The child never resumes the
         * parent's call — its job is the branch — so abandon it with
         * JS_AbandonSuspended (fork abandon API, BRA-42): the
         * suspended frames are discarded without running any parent
         * code. The parent's own snapshot file is untouched; the host
         * resumes it at join time. */
        if (JS_IsSuspended(rt)) {
            if (JS_AbandonSuspended(ctx)) {
                fprintf(stderr, "[host] parent call abandoned; "
                        "suspended=0\n");
            } else {
                fprintf(stderr, "[host] abandon reported nothing "
                        "pending despite suspended=1\n");
                return 1;
            }
        }

        if (!find_stash(ctx, &atom, &stash)) {
            fprintf(stderr, "[host] no stash array found on the global "
                    "object\n");
            return 1;
        }
        global = JS_GetGlobalObject(ctx);
        /* JS_SetPropertyStr consumes its value: the stash array moves
         * under the __stash name. Delete the symbol-keyed entry so a
         * nested fork's stash cannot be confused with this one. */
        JS_SetPropertyStr(ctx, global, "__stash", stash);
        JS_DeleteProperty(ctx, global, atom, 0);
        JS_FreeAtom(ctx, atom);
        JS_SetPropertyStr(ctx, global, "__branch_index",
                          JS_NewInt32(ctx, index));
        JS_FreeValue(ctx, global);

        {
            char *run = current_run_id(ctx);
            char *parent = get_global_cstring(ctx, "__parent_fork");
            struct strbuf b;
            sb_init(&b);
            sb_printf(&b, "{\"event\":\"branch-start\",\"runId\":\"%s\","
                      "\"parentForkId\":\"%s\",\"branch\":%d}",
                      run, parent ? parent : "", index);
            durablets_emit_event(b.s);
            sb_free(&b);
            free(run);
            free(parent);
        }

        snprintf(driver, sizeof(driver), "__stash[%d]()", index);
        fprintf(stderr, "[host] evaluating driver: %s\n", driver);
        val = JS_Eval(ctx, driver, strlen(driver), "<driver>",
                      JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(val)) {
            /* JS_IsSuspendException distinguishes the driver suspending
             * at a trap() (the suspension marker) from the eval itself
             * failing. */
            if (JS_IsSuspendException(ctx))
                return save(rt, ctx, argv[2]);
            {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
            }
            return 0;
        }
        {
            int rc = finish_slice(rt, ctx, argv[2]);
            if (rc == 2 || rc == 3)
                return rc; /* saved; the runtime is freed by save() */
            if (rc == 0) {
                JSValue outcome = make_outcome(ctx, 1, val);
                finish_branch(ctx, outcome);
                JS_FreeValue(ctx, outcome);
            }
            JS_FreeValue(ctx, val);
            return rc;
        }
    }

    if (argc >= 4 && !strcmp(argv[1], "join")) {
        JSSnapshotResult res;
        int i, rc, branch;
        struct strbuf b;
        char *outcomes_json, *run;
        int64_t fork_n;
        JSValue outcomes;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);
        emit_lifecycle(ctx, "resumed", -1);

        if (!JS_IsSuspended(rt)) {
            fprintf(stderr, "[host] restored runtime is not suspended; "
                    "nothing to join\n");
            return 1;
        }
        /* Q13: the stash is removed on every resume path. */
        delete_stash(ctx);

        /* The joined outcomes, in branch order, as one JSON array. */
        sb_init(&b);
        sb_printf(&b, "[");
        for (i = 3; i < argc; i++) {
            size_t flen;
            uint8_t *fbuf = load_file(argv[i], &flen);
            sb_printf(&b, "%s%.*s", i > 3 ? "," : "", (int)flen,
                      (char *)fbuf);
            free(fbuf);
        }
        sb_printf(&b, "]");
        outcomes_json = strdup(b.s);
        sb_free(&b);
        outcomes = JS_ParseJSON(ctx, outcomes_json, strlen(outcomes_json),
                                "<outcomes>");
        if (JS_IsException(outcomes)) {
            print_exception(ctx);
            free(outcomes_json);
            return 1;
        }

        /* The pending fork is ordinal __fork_count - 1 of this run. */
        run = current_run_id(ctx);
        fork_n = get_global_int(ctx, "__fork_count", 0) - 1;
        sb_init(&b);
        sb_printf(&b, "{\"event\":\"join\",\"runId\":\"%s\",\"forkId\":"
                  "\"%s/fork-%" PRId64 "\",\"outcome\":%s}",
                  run, run, fork_n, outcomes_json);
        durablets_emit_event(b.s);
        sb_free(&b);
        free(run);
        free(outcomes_json);

        val = JS_ResumeWith(ctx, outcomes, 0);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[2]);
            if (branch) {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
                return 0;
            }
            /* BRA-121: record the failed lifecycle event, like the
             * run/resume/cancel paths do — without it the host
             * classifies the rc=1 slice as a crash and retries the
             * join 3 times, misreporting the workflow's real error
             * as "C host crashed joining". print_exception first: it
             * stashes the "Name: message" the failed event carries. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        rc = finish_slice(rt, ctx, argv[2]);
        if (rc == 0 && branch) {
            JSValue outcome = make_outcome(ctx, 1, val);
            finish_branch(ctx, outcome);
            JS_FreeValue(ctx, outcome);
        }
        if (rc == 0 && !branch) {
            /* The run completed: capture the completion value as the
             * run result (<snap>.result.json) for `agentts result`. */
            write_run_result(ctx, val, argv[2]);
            emit_lifecycle(ctx, "completed", -1);
        } else if (rc == 1 && !branch)
            emit_lifecycle(ctx, "failed", -1);
        if (rc != 2 && rc != 3)
            JS_FreeValue(ctx, val);
        return rc;
    }

    if (argc == 4 && !strcmp(argv[1], "join-value")) {
        JSSnapshotResult res;
        int rc, branch;
        struct strbuf b;
        size_t rlen;
        uint8_t *rbuf;
        JSValue record, value, winner, cancelled, completed;
        char *value_json, *cancelled_json, *completed_json;
        char *run;
        int64_t fork_n, winner_n = -1;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);
        emit_lifecycle(ctx, "resumed", -1);

        if (!JS_IsSuspended(rt)) {
            fprintf(stderr, "[host] restored runtime is not suspended; "
                    "nothing to join\n");
            return 1;
        }
        /* Q13: the stash is removed on every resume path. */
        delete_stash(ctx);

        /* The join record: {"value":..., "winner":i, "cancelled":[...],
         * "completed":[...]}. */
        rbuf = load_file(argv[3], &rlen);
        record = JS_ParseJSON(ctx, (char *)rbuf, rlen, "<join-record>");
        free(rbuf);
        if (JS_IsException(record)) {
            print_exception(ctx);
            return 1;
        }
        value = JS_GetPropertyStr(ctx, record, "value");
        winner = JS_GetPropertyStr(ctx, record, "winner");
        cancelled = JS_GetPropertyStr(ctx, record, "cancelled");
        completed = JS_GetPropertyStr(ctx, record, "completed");
        if (!JS_IsException(winner))
            JS_ToInt64(ctx, &winner_n, winner);
        value_json = json_stringify(ctx, value);
        cancelled_json = json_stringify(ctx, cancelled);
        completed_json = json_stringify(ctx, completed);

        /* The pending fork is ordinal __fork_count - 1 of this run. */
        run = current_run_id(ctx);
        fork_n = get_global_int(ctx, "__fork_count", 0) - 1;
        sb_init(&b);
        sb_printf(&b, "{\"event\":\"join\",\"runId\":\"%s\",\"forkId\":"
                  "\"%s/fork-%" PRId64 "\",\"outcome\":%s,\"winner\":%"
                  PRId64 ",\"cancelled\":%s,\"completed\":%s}",
                  run, run, fork_n,
                  value_json ? value_json : "null", winner_n,
                  cancelled_json ? cancelled_json : "null",
                  completed_json ? completed_json : "null");
        durablets_emit_event(b.s);
        sb_free(&b);
        free(run);
        free(value_json);
        free(cancelled_json);
        free(completed_json);
        JS_FreeValue(ctx, winner);
        JS_FreeValue(ctx, cancelled);
        JS_FreeValue(ctx, completed);
        JS_FreeValue(ctx, record);

        /* The winner's bare value, delivered to the any()/race() call
         * site. JS_ResumeWith frees value. */
        val = JS_ResumeWith(ctx, value, 0);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[2]);
            if (branch) {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
                return 0;
            }
            /* BRA-121: record the failed lifecycle event, like the
             * run/resume/cancel paths do — without it the host
             * classifies the rc=1 slice as a crash and retries the
             * join 3 times, misreporting the workflow's real error
             * as "C host crashed joining". print_exception first: it
             * stashes the "Name: message" the failed event carries. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        rc = finish_slice(rt, ctx, argv[2]);
        if (rc == 0 && branch) {
            JSValue outcome = make_outcome(ctx, 1, val);
            finish_branch(ctx, outcome);
            JS_FreeValue(ctx, outcome);
        }
        if (rc == 0 && !branch) {
            /* The run completed: capture the completion value as the
             * run result (<snap>.result.json) for `agentts result`. */
            write_run_result(ctx, val, argv[2]);
            emit_lifecycle(ctx, "completed", -1);
        } else if (rc == 1 && !branch)
            emit_lifecycle(ctx, "failed", -1);
        if (rc != 2 && rc != 3)
            JS_FreeValue(ctx, val);
        return rc;
    }

    if (argc == 4 && !strcmp(argv[1], "join-aggregate")) {
        JSSnapshotResult res;
        int rc, branch, i;
        struct strbuf b;
        size_t rlen;
        uint8_t *rbuf;
        JSValue record, errors, completed, cancelled;
        JSValue agg_errors, ctor, msg, agg;
        char *errors_json, *completed_json, *cancelled_json;
        char *run;
        int64_t fork_n, nerr = 0;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);
        emit_lifecycle(ctx, "resumed", -1);

        if (!JS_IsSuspended(rt)) {
            fprintf(stderr, "[host] restored runtime is not suspended; "
                    "nothing to join\n");
            return 1;
        }
        /* Q13: the stash is removed on every resume path. */
        delete_stash(ctx);

        /* The join record: {"errors":[{name,message},...],
         * "completed":[{ok:false,error}...], "cancelled":[...]}. */
        rbuf = load_file(argv[3], &rlen);
        record = JS_ParseJSON(ctx, (char *)rbuf, rlen, "<join-record>");
        free(rbuf);
        if (JS_IsException(record)) {
            print_exception(ctx);
            return 1;
        }
        errors = JS_GetPropertyStr(ctx, record, "errors");
        completed = JS_GetPropertyStr(ctx, record, "completed");
        cancelled = JS_GetPropertyStr(ctx, record, "cancelled");
        errors_json = json_stringify(ctx, errors);
        completed_json = json_stringify(ctx, completed);
        cancelled_json = json_stringify(ctx, cancelled);

        /* The pending fork is ordinal __fork_count - 1 of this run. */
        run = current_run_id(ctx);
        fork_n = get_global_int(ctx, "__fork_count", 0) - 1;
        sb_init(&b);
        sb_printf(&b, "{\"event\":\"join\",\"runId\":\"%s\",\"forkId\":"
                  "\"%s/fork-%" PRId64 "\",\"aggregate\":true,"
                  "\"errors\":%s,\"completed\":%s,\"cancelled\":%s}",
                  run, run, fork_n,
                  errors_json ? errors_json : "null",
                  completed_json ? completed_json : "null",
                  cancelled_json ? cancelled_json : "null");
        durablets_emit_event(b.s);
        sb_free(&b);
        free(run);
        free(errors_json);
        free(completed_json);
        free(cancelled_json);

        /* Rehydrate each branch error and build the AggregateError
         * the parent catches: new AggregateError(rehydrated, msg).
         * JS_SetPropertyUint32 consumes each rehydrated error; the
         * AggregateError constructor copies the array, so the
         * temporaries are freed after the call. */
        {
            JSValue len_v = JS_GetPropertyStr(ctx, errors, "length");
            if (!JS_IsException(len_v))
                JS_ToInt64(ctx, &nerr, len_v);
            JS_FreeValue(ctx, len_v);
        }
        agg_errors = JS_NewArray(ctx);
        for (i = 0; i < nerr; i++) {
            JSValue rec = JS_GetPropertyUint32(ctx, errors, (uint32_t)i);
            JSValue e = rehydrate_error(ctx, rec);
            JS_FreeValue(ctx, rec);
            JS_SetPropertyUint32(ctx, agg_errors, (uint32_t)i, e);
        }
        {
            JSValue global = JS_GetGlobalObject(ctx);
            ctor = JS_GetPropertyStr(ctx, global, "AggregateError");
            JS_FreeValue(ctx, global);
        }
        msg = JS_NewString(ctx, "All branches failed");
        {
            JSValue args[2];
            args[0] = agg_errors;
            args[1] = msg;
            agg = JS_Call(ctx, ctor, JS_UNDEFINED, 2, args);
        }
        JS_FreeValue(ctx, ctor);
        JS_FreeValue(ctx, agg_errors);
        JS_FreeValue(ctx, msg);
        JS_FreeValue(ctx, errors);
        JS_FreeValue(ctx, completed);
        JS_FreeValue(ctx, cancelled);
        JS_FreeValue(ctx, record);
        if (JS_IsException(agg)) {
            print_exception(ctx);
            return 1;
        }
        /* The AggregateError, thrown at the any() call site. The
         * parent catches it with ordinary try/catch. JS_ResumeWith
         * frees agg. */
        val = JS_ResumeWith(ctx, agg, 1);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[2]);
            if (branch) {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
                return 0;
            }
            /* BRA-121: record the failed lifecycle event, like the
             * run/resume/cancel paths do — without it the host
             * classifies the rc=1 slice as a crash and retries the
             * join 3 times, misreporting the workflow's real error
             * as "C host crashed joining". print_exception first: it
             * stashes the "Name: message" the failed event carries. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        rc = finish_slice(rt, ctx, argv[2]);
        if (rc == 0 && branch) {
            JSValue outcome = make_outcome(ctx, 1, val);
            finish_branch(ctx, outcome);
            JS_FreeValue(ctx, outcome);
        }
        if (rc == 0 && !branch) {
            /* The run completed: capture the completion value as the
             * run result (<snap>.result.json) for `agentts result`. */
            write_run_result(ctx, val, argv[2]);
            emit_lifecycle(ctx, "completed", -1);
        } else if (rc == 1 && !branch)
            emit_lifecycle(ctx, "failed", -1);
        if (rc != 2 && rc != 3)
            JS_FreeValue(ctx, val);
        return rc;
    }

    if (argc == 4 && !strcmp(argv[1], "join-throw")) {
        JSSnapshotResult res;
        int rc, branch;
        struct strbuf b;
        size_t rlen;
        uint8_t *rbuf;
        JSValue record, failed, error, cancelled, completed;
        JSValue err_val;
        char *failed_json, *error_json, *cancelled_json, *completed_json;
        char *run;
        int64_t fork_n, failed_branch = -1;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);
        emit_lifecycle(ctx, "resumed", -1);

        if (!JS_IsSuspended(rt)) {
            fprintf(stderr, "[host] restored runtime is not suspended; "
                    "nothing to join\n");
            return 1;
        }
        /* Q13: the stash is removed on every resume path. */
        delete_stash(ctx);

        /* The join record: {"failedBranch":i,"error":{},
         * "cancelled":[...],"completed":[...]}. */
        rbuf = load_file(argv[3], &rlen);
        record = JS_ParseJSON(ctx, (char *)rbuf, rlen, "<join-record>");
        free(rbuf);
        if (JS_IsException(record)) {
            print_exception(ctx);
            return 1;
        }
        failed = JS_GetPropertyStr(ctx, record, "failedBranch");
        error = JS_GetPropertyStr(ctx, record, "error");
        cancelled = JS_GetPropertyStr(ctx, record, "cancelled");
        completed = JS_GetPropertyStr(ctx, record, "completed");
        if (!JS_IsException(failed))
            JS_ToInt64(ctx, &failed_branch, failed);
        failed_json = json_stringify(ctx, failed);
        error_json = json_stringify(ctx, error);
        cancelled_json = json_stringify(ctx, cancelled);
        completed_json = json_stringify(ctx, completed);

        /* The pending fork is ordinal __fork_count - 1 of this run. */
        run = current_run_id(ctx);
        fork_n = get_global_int(ctx, "__fork_count", 0) - 1;
        sb_init(&b);
        sb_printf(&b, "{\"event\":\"join\",\"runId\":\"%s\",\"forkId\":"
                  "\"%s/fork-%" PRId64 "\",\"failedBranch\":%" PRId64
                  ",\"error\":%s,\"cancelled\":%s,\"completed\":%s}",
                  run, run, fork_n, failed_branch,
                  error_json ? error_json : "null",
                  cancelled_json ? cancelled_json : "null",
                  completed_json ? completed_json : "null");
        durablets_emit_event(b.s);
        sb_free(&b);
        free(run);
        free(failed_json);
        free(error_json);
        free(cancelled_json);
        free(completed_json);

        /* The first branch error, rehydrated, thrown at the all() call
         * site. The parent catches it with ordinary try/catch; its
         * finally blocks run; the run itself is NOT cancelled. */
        err_val = rehydrate_error(ctx, error);
        JS_FreeValue(ctx, failed);
        JS_FreeValue(ctx, error);
        JS_FreeValue(ctx, cancelled);
        JS_FreeValue(ctx, completed);
        JS_FreeValue(ctx, record);
        val = JS_ResumeWith(ctx, err_val, 1);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[2]);
            if (branch) {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
                return 0;
            }
            /* BRA-121: record the failed lifecycle event, like the
             * run/resume/cancel paths do — without it the host
             * classifies the rc=1 slice as a crash and retries the
             * join 3 times, misreporting the workflow's real error
             * as "C host crashed joining". print_exception first: it
             * stashes the "Name: message" the failed event carries. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        rc = finish_slice(rt, ctx, argv[2]);
        if (rc == 0 && branch) {
            JSValue outcome = make_outcome(ctx, 1, val);
            finish_branch(ctx, outcome);
            JS_FreeValue(ctx, outcome);
        }
        if (rc == 0 && !branch) {
            /* The run completed: capture the completion value as the
             * run result (<snap>.result.json) for `agentts result`. */
            write_run_result(ctx, val, argv[2]);
            emit_lifecycle(ctx, "completed", -1);
        } else if (rc == 1 && !branch)
            emit_lifecycle(ctx, "failed", -1);
        if (rc != 2 && rc != 3)
            JS_FreeValue(ctx, val);
        return rc;
    }

    if (argc == 4 && !strcmp(argv[1], "cancel")) {
        JSSnapshotResult res;
        int rc, branch;
        size_t rlen;
        uint8_t *rbuf;
        JSValue record, reason_v, trigger_v, what_v, ordinal_v, fork_v,
                cancelled_v, parent_v, branch_v, err_val;
        char *reason_s = NULL, *trigger_s = NULL, *what_s = NULL,
             *fork_s = NULL, *parent_s = NULL, *cancelled_json = NULL;
        char *run;
        int64_t ordinal = -1, branch_n = -1;
        int has_ordinal = 0, has_fork = 0, has_cancelled = 0,
            has_parent = 0, has_branch = 0;
        struct strbuf b;
        const char *c;
        rt = JS_NewRuntime();
        /* BRA-90: pair-aware load (plain full read when the host
         * names no base -- see read_snapshot). */
        if (read_snapshot(rt, argv[2], &res)) {
            JS_FreeRuntime(rt);
            return 1;
        }
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        /* Resuming inside the workflow entry (the snapshot was taken
         * under it): arm the entry guard for the resumed execution.
         * A branch thunk IS the entry for its child run. The run
         * path does NOT set this — its flag comes from the driver's
         * __agentts_begin() call. */
        g_in_workflow = 1;
        branch = is_branch_run(ctx);
        emit_lifecycle(ctx, "resumed", -1);

        if (!JS_IsSuspended(rt)) {
            fprintf(stderr, "[host] restored runtime is not suspended; "
                    "nothing to cancel\n");
            return 1;
        }
        /* Q13: the stash is removed on every resume path. */
        delete_stash(ctx);

        /* The cancel record: {"reason": "...", "trigger": "...",
         * "what": "trap"|"fork", "ordinal": N, "forkId": "...",
         * "cancelled": [...], "parentForkId": "...", "branch": i}.
         * reason/trigger/what default; the rest are optional and are
         * journalled only when present. */
        rbuf = load_file(argv[3], &rlen);
        record = JS_ParseJSON(ctx, (char *)rbuf, rlen, "<cancel-record>");
        free(rbuf);
        if (JS_IsException(record)) {
            print_exception(ctx);
            return 1;
        }
        reason_v = JS_GetPropertyStr(ctx, record, "reason");
        trigger_v = JS_GetPropertyStr(ctx, record, "trigger");
        what_v = JS_GetPropertyStr(ctx, record, "what");
        ordinal_v = JS_GetPropertyStr(ctx, record, "ordinal");
        fork_v = JS_GetPropertyStr(ctx, record, "forkId");
        cancelled_v = JS_GetPropertyStr(ctx, record, "cancelled");
        parent_v = JS_GetPropertyStr(ctx, record, "parentForkId");
        branch_v = JS_GetPropertyStr(ctx, record, "branch");
        if (!JS_IsException(reason_v) && JS_IsString(reason_v)) {
            c = JS_ToCString(ctx, reason_v);
            if (c) { reason_s = strdup(c); JS_FreeCString(ctx, c); }
        }
        if (!JS_IsException(trigger_v) && JS_IsString(trigger_v)) {
            c = JS_ToCString(ctx, trigger_v);
            if (c) { trigger_s = strdup(c); JS_FreeCString(ctx, c); }
        }
        if (!JS_IsException(what_v) && JS_IsString(what_v)) {
            c = JS_ToCString(ctx, what_v);
            if (c) { what_s = strdup(c); JS_FreeCString(ctx, c); }
        }
        if (!JS_IsException(ordinal_v) && !JS_IsUndefined(ordinal_v)) {
            JS_ToInt64(ctx, &ordinal, ordinal_v);
            has_ordinal = 1;
        }
        if (!JS_IsException(fork_v) && JS_IsString(fork_v)) {
            c = JS_ToCString(ctx, fork_v);
            if (c) { fork_s = strdup(c); JS_FreeCString(ctx, c); }
            has_fork = 1;
        }
        if (!JS_IsException(cancelled_v) &&
            JS_IsArray(ctx, cancelled_v)) {
            cancelled_json = json_stringify(ctx, cancelled_v);
            has_cancelled = 1;
        }
        if (!JS_IsException(parent_v) && JS_IsString(parent_v)) {
            c = JS_ToCString(ctx, parent_v);
            if (c) { parent_s = strdup(c); JS_FreeCString(ctx, c); }
            has_parent = 1;
        }
        if (!JS_IsException(branch_v) && !JS_IsUndefined(branch_v)) {
            JS_ToInt64(ctx, &branch_n, branch_v);
            has_branch = 1;
        }
        if (!reason_s)
            reason_s = strdup("run cancelled");
        if (!trigger_s)
            trigger_s = strdup("user abort");
        if (!what_s)
            what_s = strdup("trap");

        /* The cancellation event: what / when / why / trigger (Q14).
         * The reason is the why and propagates unchanged down a
         * cancelled tree; the trigger is local to this event. The
         * event is emitted before the workflow sees the throw, so
         * the plugin's journal order decides the cancel-versus-
         * complete race. */
        run = current_run_id(ctx);
        sb_init(&b);
        sb_printf(&b, "{\"event\":\"cancel\",\"runId\":\"%s\",\"what\":\"%s\"",
                  run, what_s);
        if (has_ordinal)
            sb_printf(&b, ",\"ordinal\":%" PRId64, ordinal);
        if (has_fork)
            sb_printf(&b, ",\"forkId\":\"%s\"", fork_s);
        sb_printf(&b, ",\"trigger\":\"%s\",\"reason\":\"%s\",\"when\":%lld",
                  trigger_s, reason_s, (long long)time(NULL));
        if (has_cancelled)
            sb_printf(&b, ",\"cancelled\":%s",
                      cancelled_json ? cancelled_json : "[]");
        if (has_parent)
            sb_printf(&b, ",\"parentForkId\":\"%s\"", parent_s);
        if (has_branch)
            sb_printf(&b, ",\"branch\":%" PRId64, branch_n);
        sb_printf(&b, "}");
        durablets_emit_event(b.s);
        sb_free(&b);
        free(run);

        /* Deliver the cancellation token (sticky, snapshotted) and
         * resume the suspended wait by throwing the
         * CancellationError at the call site. JS_ResumeWith frees
         * err_val. */
        set_global_int(ctx, "__cancelled", 1);
        set_global_str(ctx, "__cancel_reason", reason_s);
        err_val = make_cancellation_error(ctx, reason_s);
        JS_FreeValue(ctx, reason_v);
        JS_FreeValue(ctx, trigger_v);
        JS_FreeValue(ctx, what_v);
        JS_FreeValue(ctx, ordinal_v);
        JS_FreeValue(ctx, fork_v);
        JS_FreeValue(ctx, cancelled_v);
        JS_FreeValue(ctx, parent_v);
        JS_FreeValue(ctx, branch_v);
        JS_FreeValue(ctx, record);
        free(reason_s);
        free(trigger_s);
        free(what_s);
        free(fork_s);
        free(parent_s);
        free(cancelled_json);

        val = JS_ResumeWith(ctx, err_val, 1);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[2]);
            /* The resumed execution threw (uncaught). In a branch
             * run that is a failed outcome, not a host error. */
            if (branch) {
                JSValue exc = JS_GetException(ctx);
                finish_branch_error(ctx, exc);
                JS_FreeValue(ctx, exc);
                return 0;
            }
            /* BRA-44: emit the failure lifecycle event, like run and
             * resume do on this path — without it a run that fails on
             * cancel never journals its failure and stays in the
             * host registry forever. BRA-125: print_exception first —
             * it stashes the "Name: message" the failed event carries;
             * emitting first left the event with no error at all. */
            print_exception(ctx);
            emit_lifecycle(ctx, "failed", -1);
            return 1;
        }
        rc = finish_slice(rt, ctx, argv[2]);
        if (rc == 0 && branch) {
            JSValue outcome = make_outcome(ctx, 1, val);
            finish_branch(ctx, outcome);
            JS_FreeValue(ctx, outcome);
        }
        if (rc == 0 && !branch) {
            /* The run completed: capture the completion value as the
             * run result (<snap>.result.json) for `agentts result`. */
            write_run_result(ctx, val, argv[2]);
            emit_lifecycle(ctx, "completed", -1);
        } else if (rc == 1 && !branch)
            emit_lifecycle(ctx, "failed", -1);
        if (rc != 2 && rc != 3)
            JS_FreeValue(ctx, val);
        return rc;
    }

    fprintf(stderr, "usage: durablets run <workflow.ts> <blob>\n"
            "       durablets resume <blob> <result-json>\n"
            "       durablets resume <blob> throw:<json>\n"
            "       durablets cancel <blob> <cancel.json>\n"
            "       durablets branch <blob> <index>\n"
            "       durablets join <blob> <outcome.json>...\n"
            "       durablets join-value <blob> <record.json>\n"
            "       durablets join-throw <blob> <record.json>\n"
            "       durablets join-aggregate <blob> <record.json>\n");
    return 1;
}
