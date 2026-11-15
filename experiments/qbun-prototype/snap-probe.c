#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

static JSValue js_step(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    fprintf(stderr, "[probe] step() - suspending\n");
    return JS_SuspendCall(ctx);
}
static JSValue js_print(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        printf("%s%s", i ? " " : "", s ? s : "?");
        JS_FreeCString(ctx, s);
    }
    printf("\n");
    return JS_UNDEFINED;
}
static void print_exc(JSContext *ctx) {
    JSValue e = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, e);
    fprintf(stderr, "exception: %s\n", s ? s : "?");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, e);
}
static int try_snapshot(JSContext *ctx, const char *label) {
    static const void *natives[] = { (const void *)js_step, (const void *)js_print };
    static const JSSnapshotHost host = { .natives = natives, .native_count = 2 };
    size_t size = 0;
    uint8_t *buf = JS_WriteSnapshot(ctx, &size, &host, NULL, 0, 0);
    if (!buf) { fprintf(stderr, "[%s] snapshot FAILED: ", label); print_exc(ctx); return 1; }
    fprintf(stderr, "[%s] snapshot OK: %zu bytes\n", label, size);
    js_free(ctx, buf);
    return 0;
}
int main(int argc, char **argv) {
    int mode = argc > 1 ? atoi(argv[1]) : 0;
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print", JS_NewCFunction(ctx, js_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "step", JS_NewCFunction(ctx, js_step, "step", 1));
    JS_FreeValue(ctx, global);
    const char *src = "print('hello');";
    if (mode >= 1) { JS_AddIntrinsicTemporal(ctx); JS_AddIntrinsicIntl(ctx); }
    if (mode == 3) src = "let f = new Intl.DateTimeFormat('en'); print(f.format(new Date(0)));";
    if (mode == 4) src = "let d = Temporal.PlainDate.from('2026-11-15'); print(d.toString());";
    if (mode == 5) src = "let p = new Promise((r) => r(1)); print('promise made');";
    JSValue v = JS_Eval(ctx, src, strlen(src), "<probe>", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(v)) { print_exc(ctx); return 1; }
    JS_FreeValue(ctx, v);
    int r = try_snapshot(ctx, mode == 0 ? "plain" : mode == 1 ? "intrinsics added" : mode == 3 ? "intl instance" : mode == 4 ? "temporal instance" : "promise");
    if (mode == 2) {
        const char *wf = "const a = step({op:'score',value:7}); print('got', JSON.stringify(a));";
        v = JS_Eval(ctx, wf, strlen(wf), "<wf>", JS_EVAL_TYPE_GLOBAL);
        fprintf(stderr, "eval exc=%d suspended=%d\n", (int)JS_IsException(v), (int)JS_IsSuspended(rt));
        if (JS_IsException(v) && JS_IsSuspended(rt)) {
            r = try_snapshot(ctx, "suspended+intrinsics");
            JSValue res = JS_ParseJSON(ctx, "{\"score\":0.92}", 15, "<r>");
            JSValue rv = JS_ResumeWith(ctx, res, 0);
            fprintf(stderr, "resume exc=%d\n", (int)JS_IsException(rv));
            if (JS_IsException(rv)) print_exc(ctx);
            else JS_FreeValue(ctx, rv);
        } else if (JS_IsException(v)) print_exc(ctx);
    }
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return r;
}
