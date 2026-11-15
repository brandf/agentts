/*
 * AgentTS dquickts prototype host — the whole engine side, KISS version.
 *
 * There is no ctx object. `step` is a builtin global function the engine
 * itself provides: the workflow calls step(input) and the engine suspends
 * the run until the result arrives. Suspending uses the durable host-call
 * API: step() returns JS_SuspendCall(), the host snapshots the runtime to
 * disk and exits, and a fresh process restores the snapshot and completes
 * the call with JS_ResumeWith().
 *
 * Sync-looking is the only style. `await step()` throws "TypeError: this
 * call cannot be suspended" (an async frame is not suspendable) — that is
 * a documented constraint, not a supported path: there is no async
 * variant of the builtin.
 *
 * A step can also deliver an exception instead of a value: the resume
 * driver takes a result of the form throw:<json> and completes the call
 * with JS_ResumeWith(result, throw_flag=1), so the exception is raised
 * at the step call site and the workflow's try/catch sees it.
 *
 *   proto run <workflow.ts> <snap>      evaluate; suspend at the first
 *                                        step call, save snapshot, exit 2
 *   proto resume <snap> <result-json>   restore; complete the pending
 *                                        step call with the result; run on
 *                                        until the next step (exit 2) or
 *                                        completion (exit 0)
 *   proto resume <snap> throw:<json>    same, but the step call throws
 *                                        the JSON value instead
 *
 * Exit codes: 0 = workflow done, 1 = error, 2 = suspended, snapshot saved.
 * Workflow output (print) goes to stdout; host diagnostics to stderr.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

/* step(input): the engine's sync builtin. Suspends the calling workflow
 * until the host completes the call with the step's result.
 *
 * Limitation, found by testing: this only works from a plain synchronous
 * call stack. `await step(input)` throws "TypeError: this call cannot be
 * suspended" — an async frame is not suspendable (quickjs.h: every frame
 * must be a normal non-generator, non-async function). */
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

static const void * const host_natives[] = {
    (const void *)js_print,
    (const void *)js_step,
};

static const JSSnapshotHost host = {
    .natives = host_natives,
    .native_count = 2,
};

static void print_exception(JSContext *ctx)
{
    JSValue exc = JS_GetException(ctx);
    const char *str = JS_ToCString(ctx, exc);
    fprintf(stderr, "exception: %s\n", str ? str : "?");
    JS_FreeCString(ctx, str);
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

/* Full snapshot (flags 0). Deltas/bases are an optimization, not needed
 * to prove the mechanism. */
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
        global = JS_GetGlobalObject(ctx);
        JS_SetPropertyStr(ctx, global, "print",
                          JS_NewCFunction(ctx, js_print, "print", 1));
        JS_SetPropertyStr(ctx, global, "step",
                          JS_NewCFunction(ctx, js_step, "step", 1));
        JS_FreeValue(ctx, global);

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
        int throw_flag = 0;
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

        /* throw:<json> delivers the JSON value as an exception from the
         * pending step call instead of a normal result. */
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
            JS_FreeValue(ctx, val);
            return finish_slice(rt, ctx, argv[2]);
        }
        fprintf(stderr, "[host] restored runtime is not suspended; "
                "nothing to resume\n");
        JS_FreeValue(ctx, val);
        return 1;
    }

    fprintf(stderr, "usage: proto run <workflow.ts> <snap>\n"
            "       proto resume <snap> <result-json>\n"
            "       proto resume <snap> throw:<json>\n");
    return 1;
}
