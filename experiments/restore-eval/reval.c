/*
 * AgentTS restore+eval experiment host (Linear BRA-23).
 *
 * The one unverified step of the parallel-steps design (plan doc Q13):
 * can a runtime restored from a dquickts snapshot accept a fresh eval
 * while a suspended execution sits in it?
 *
 * The combinator builtin `all` stashes its branch thunks in a hidden
 * spot in the heap — a non-enumerable Symbol-keyed property on the
 * global object, exactly as Q13 specifies — and suspends. The parent
 * process snapshots and exits. A child process loads a COPY of the
 * snapshot and, instead of resuming the suspended `all` call, evals a
 * tiny driver that pulls one thunk from the stash and calls it as a
 * top-level execution. The thunk's steps suspend/resume normally.
 *
 *   reval run <workflow.ts> <snap>       evaluate; suspend at the first
 *                                         step/all call, save snapshot,
 *                                         exit 2
 *   reval resume <snap> <result-json>    restore; complete the pending
 *                                         step call with the result; run
 *                                         on until the next step (exit 2)
 *                                         or completion (exit 0)
 *   reval resume <snap> throw:<json>     same, but the step call throws
 *   reval branch <snap> <index>          restore a snapshot suspended
 *                                         at all(); find the stash by
 *                                         enumerating the global's
 *                                         symbol-keyed properties; eval
 *                                         the driver __stash[<index>]();
 *                                         on suspension save and exit 2,
 *                                         on completion print
 *                                         "branch <index> result: <json>"
 *                                         and exit 0
 *
 * Exit codes: 0 = done, 1 = error, 2 = suspended, snapshot saved.
 * Workflow output (print) goes to stdout; host diagnostics to stderr.
 *
 * Ownership notes (QuickJS traps): JS_SetProperty* consumes its value
 * argument; JS_SetPropertyValue frees both prop and val, so the stashed
 * thunks array is dup'd first; JS_ResumeWith frees its result argument.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <inttypes.h>

#include "quickjs.h"

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

/* step(input): the engine's sync builtin, as in the dquickts prototype. */
static JSValue js_step(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    JSValue json = JS_JSONStringify(ctx, argc > 0 ? argv[0] : JS_UNDEFINED,
                                    JS_UNDEFINED, JS_UNDEFINED);
    const char *str = JS_ToCString(ctx, json);
    fprintf(stderr, "[host] step(%s) — suspending\n", str ? str : "?");
    JS_FreeCString(ctx, str);
    JS_FreeValue(ctx, json);
    return JS_SuspendCall(ctx);
}

/* all(thunks): the combinator builtin, minimal form. Stashes the thunks
 * array under a fresh Symbol key on the global object (the hidden spot
 * from Q13), then suspends. The host is expected to snapshot and exit;
 * a child process later finds the stash by enumerating the global's
 * symbol-keyed properties. */
static JSValue js_all(JSContext *ctx, JSValueConst this_val,
                      int argc, JSValueConst *argv)
{
    JSValue global, sym, len_v;
    int64_t n = -1;
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "all() needs an array of thunks");
    len_v = JS_GetPropertyStr(ctx, argv[0], "length");
    if (!JS_IsException(len_v))
        JS_ToInt64(ctx, &n, len_v);
    JS_FreeValue(ctx, len_v);
    fprintf(stderr, "[host] all(%" PRId64 " branches) — stashing thunks, "
            "suspending\n", n);
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
    return JS_SuspendCall(ctx);
}

static const void * const host_natives[] = {
    (const void *)js_print,
    (const void *)js_step,
    (const void *)js_all,
};

static const JSSnapshotHost host = {
    .natives = host_natives,
    .native_count = 3,
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

static int save_snapshot(JSContext *ctx, const char *filename)
{
    size_t size;
    uint8_t *buf = JS_WriteSnapshot(ctx, &size, &host, NULL, 0, 0);
    FILE *f;
    if (!buf) {
        print_exception(ctx);
        return 1;
    }
    f = fopen(filename, "wb");
    if (!f || fwrite(buf, 1, size, f) != size || fclose(f)) {
        perror(filename);
        js_free(ctx, buf);
        return 1;
    }
    fprintf(stderr, "[host] snapshot saved: %s (%zu bytes)\n", filename, size);
    js_free(ctx, buf);
    return 0;
}

/* Save the state and free the runtime. Exit code 2 = more work to do. */
static int save(JSRuntime *rt, JSContext *ctx, const char *snap)
{
    if (save_snapshot(ctx, snap))
        return 1;
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return 2;
}

/* Drain pending jobs. Returns 0 done, 1 error, 2 suspended (saved).
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

/* If the run is a branch (global __branch_index is a number), print the
 * branch's result on stdout: "branch <i> result: <json>". Used by both
 * the branch mode (driver completed without suspending) and the resume
 * mode (driver completed after its steps resolved). */
static void maybe_print_branch_result(JSContext *ctx, JSValue val)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue idx = JS_GetPropertyStr(ctx, global, "__branch_index");
    int64_t i;
    if (!JS_IsException(idx) && !JS_IsUndefined(idx) &&
        JS_ToInt64(ctx, &i, idx) == 0) {
        JSValue json = JS_JSONStringify(ctx, val, JS_UNDEFINED,
                                        JS_UNDEFINED);
        const char *str = JS_ToCString(ctx, json);
        printf("branch %" PRId64 " result: %s\n", i, str ? str : "?");
        JS_FreeCString(ctx, str);
        JS_FreeValue(ctx, json);
    }
    JS_FreeValue(ctx, idx);
    JS_FreeValue(ctx, global);
}

/* Find the stashed thunks array: the first array-valued property under
 * a symbol key on the global object. Returns an owned value, or
 * JS_UNDEFINED if there is none. */
static JSValue find_stash(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JSPropertyEnum *tab = NULL;
    uint32_t len = 0, i;
    JSValue stash = JS_UNDEFINED;
    if (JS_GetOwnPropertyNames(ctx, &tab, &len, global,
                               JS_GPN_SYMBOL_MASK)) {
        JS_FreeValue(ctx, global);
        return JS_UNDEFINED;
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
            stash = v;
            break;
        }
        JS_FreeValue(ctx, v);
    }
    JS_FreePropertyEnum(ctx, tab, len);
    JS_FreeValue(ctx, global);
    return stash;
}

static void register_builtins(JSContext *ctx)
{
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "step",
                      JS_NewCFunction(ctx, js_step, "step", 1));
    JS_SetPropertyStr(ctx, global, "all",
                      JS_NewCFunction(ctx, js_all, "all", 1));
    JS_FreeValue(ctx, global);
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
        register_builtins(ctx);

        val = JS_Eval(ctx, (char *)buf, len, argv[2],
                      JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_TYPESCRIPT);
        free(buf);
        if (JS_IsException(val)) {
            if (JS_IsSuspended(rt))
                return save(rt, ctx, argv[3]);
            print_exception(ctx);
            return 1;
        }
        JS_FreeValue(ctx, val);
        return finish_slice(rt, ctx, argv[3]);
    }

    if (argc == 4 && !strcmp(argv[1], "resume")) {
        JSSnapshotResult res;
        char err[256];
        int throw_flag = 0, rc;
        const char *result_json = argv[3];
        buf = load_file(argv[2], &len);
        rt = JS_NewRuntime();
        if (JS_ReadSnapshot(rt, buf, len, NULL, 0, &host, &res,
                            err, sizeof(err))) {
            fprintf(stderr, "%s: %s\n", argv[2], err);
            JS_FreeRuntime(rt);
            return 1;
        }
        free(buf);
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);

        if (!strncmp(result_json, "throw:", 6)) {
            throw_flag = 1;
            result_json += 6;
        }
        val = parse_result(ctx, result_json);
        if (JS_IsException(val))
            return 1;
        if (JS_IsSuspended(rt)) {
            /* The pending step() call completes with the result — or
             * throws it, if throw_flag is set. */
            val = JS_ResumeWith(ctx, val, throw_flag);
            if (JS_IsException(val)) {
                if (JS_IsSuspended(rt))
                    return save(rt, ctx, argv[2]);
                print_exception(ctx);
                return 1;
            }
            rc = finish_slice(rt, ctx, argv[2]);
            if (rc == 0)
                maybe_print_branch_result(ctx, val);
            if (rc != 2)
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
        char err[256];
        char driver[64];
        int index = atoi(argv[3]);
        JSValue stash;
        buf = load_file(argv[2], &len);
        rt = JS_NewRuntime();
        if (JS_ReadSnapshot(rt, buf, len, NULL, 0, &host, &res,
                            err, sizeof(err))) {
            fprintf(stderr, "%s: %s\n", argv[2], err);
            JS_FreeRuntime(rt);
            return 1;
        }
        free(buf);
        ctx = res.contexts[0];
        JS_FreeSnapshotResult(rt, &res);
        fprintf(stderr, "[host] restored runtime suspended=%d before "
                "driver eval\n", JS_IsSuspended(rt) ? 1 : 0);

        /* ABANDON (workaround under test — see README): the restored
         * runtime still holds the parent's suspended all() call, and
         * the engine allows only one suspended execution at a time
         * (js_can_suspend_from: rt->suspended != NULL -> the thunk's
         * step() throws "this call cannot be suspended"). The child
         * never resumes the parent's call — its job is the branch —
         * so complete it with a throw and let the parent workflow
         * unwind in this scratch copy. The parent's own snapshot file
         * is untouched; the host resumes it at join time. Caveat: any
         * catch/finally around all() in the parent would run here, in
         * the child. A sound engine needs a real abandon API in the
         * fork (drop rt->suspended without running parent code);
         * resume-with-throw is the observable stand-in. */
        if (JS_IsSuspended(rt)) {
            JSValue abandon = JS_ResumeWith(
                ctx,
                JS_NewString(ctx, "abandoned: parent call discarded in "
                                   "branch child"),
                1);
            if (JS_IsException(abandon)) {
                if (JS_IsSuspended(rt)) {
                    fprintf(stderr, "[host] abandon re-suspended; "
                            "giving up\n");
                    return save(rt, ctx, argv[2]);
                }
                /* The parent workflow unwound with the thrown value
                 * (it has no catch/finally around all()). The
                 * suspension slot is free now. Consume the pending
                 * exception quietly — the throw was intentional. */
                {
                    JSValue e = JS_GetException(ctx);
                    const char *s = JS_ToCString(ctx, e);
                    fprintf(stderr, "[host] parent call abandoned "
                            "(unwound with: %s); suspended=0\n",
                            s ? s : "?");
                    if (s)
                        JS_FreeCString(ctx, s);
                    JS_FreeValue(ctx, e);
                }
            } else {
                /* The parent workflow caught the abandon-throw and
                 * finished in this scratch copy. */
                fprintf(stderr, "[host] parent call abandoned "
                        "(workflow caught it and finished); "
                        "suspended=0\n");
                JS_FreeValue(ctx, abandon);
            }
        }

        stash = find_stash(ctx);
        if (!JS_IsArray(ctx, stash)) {
            fprintf(stderr, "[host] no stash array found on the global "
                    "object\n");
            JS_FreeValue(ctx, stash);
            return 1;
        }
        global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "__stash", stash);
        JS_SetPropertyStr(ctx, global, "__branch_index",
                          JS_NewInt32(ctx, index));
        JS_FreeValue(ctx, global);

        snprintf(driver, sizeof(driver), "__stash[%d]()", index);
        fprintf(stderr, "[host] evaluating driver: %s\n", driver);
        val = JS_Eval(ctx, driver, strlen(driver), "<driver>",
                      JS_EVAL_TYPE_GLOBAL);
        if (JS_IsException(val)) {
            /* JS_IsSuspendException distinguishes the driver suspending
             * at a step() (the suspension marker) from the eval itself
             * failing: the restored runtime is already suspended from
             * the parent's all() call, so JS_IsSuspended() alone would
             * be true either way. */
            if (JS_IsSuspendException(ctx))
                return save(rt, ctx, argv[2]);
            print_exception(ctx);
            return 1;
        }
        maybe_print_branch_result(ctx, val);
        JS_FreeValue(ctx, val);
        return finish_slice(rt, ctx, argv[2]);
    }

    fprintf(stderr, "usage: reval run <workflow.ts> <snap>\n"
            "       reval resume <snap> <result-json>\n"
            "       reval resume <snap> throw:<json>\n"
            "       reval branch <snap> <index>\n");
    return 1;
}
