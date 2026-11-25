/* compile-helper.c — BRA-134 (production snapshot converter).
 *
 * Compile a JS source file with the (new) engine and dump the resulting
 * function tree via JS_WriteObject2 (JS_WRITE_OBJ_BYTECODE) for the
 * converter (apps/agentts/src/snapshot-convert.ts) to parse.
 *
 * Usage: compile-helper <source.js> <filename-as-recorded> <out.bc>
 *
 * <filename-as-recorded> is the debug.filename the old snapshot
 * carries (the bundle path as passed to JS_Eval by durablets `run`).
 * It must match EXACTLY: the converter matches old/new functions by
 * the identity key (file, name, definition line).
 *
 * The eval flags mirror durablets.c `run`: GLOBAL | TYPESCRIPT, plus
 * COMPILE_ONLY (no execution — the helper only compiles).
 *
 * Build (against the target engine tree):
 *   cc -g -O2 -I<target-dquickts> compile-helper.c <target-dquickts>/libquickjs.a \
 *      -lm -lpthread -ldl -o compile-helper
 *
 * Provenance: adapted from the BRA-115 prototype
 * (~/workspace/bra115/compile-helper.c), unchanged in behavior.
 */
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint8_t *load_file(const char *filename, size_t *plen)
{
    FILE *f = fopen(filename, "rb");
    if (!f) {
        fprintf(stderr, "compile-helper: cannot open %s\n", filename);
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc(len ? len : 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (len && fread(buf, 1, len, f) != (size_t)len) {
        fprintf(stderr, "compile-helper: short read on %s\n", filename);
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *plen = (size_t)len;
    return buf;
}

int main(int argc, char **argv)
{
    if (argc != 4) {
        fprintf(stderr, "usage: compile-helper <source.js> <filename-as-recorded> <out.bc>\n");
        return 2;
    }
    size_t len;
    uint8_t *buf = load_file(argv[1], &len);
    if (!buf)
        return 1;
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        fprintf(stderr, "compile-helper: JS_NewRuntime failed\n");
        return 1;
    }
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) {
        fprintf(stderr, "compile-helper: JS_NewContext failed\n");
        return 1;
    }
    JSValue val = JS_Eval(ctx, (char *)buf, len, argv[2],
                          JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_TYPESCRIPT |
                          JS_EVAL_FLAG_COMPILE_ONLY);
    free(buf);
    if (JS_IsException(val)) {
        JSValue exc = JS_GetException(ctx);
        const char *msg = JS_ToCString(ctx, exc);
        fprintf(stderr, "compile-helper: compile failed: %s\n", msg ? msg : "?");
        if (msg)
            JS_FreeCString(ctx, msg);
        JS_FreeValue(ctx, exc);
        return 1;
    }
    size_t out_len = 0;
    uint8_t *out = JS_WriteObject2(ctx, &out_len, val, JS_WRITE_OBJ_BYTECODE, NULL, NULL);
    if (!out) {
        fprintf(stderr, "compile-helper: JS_WriteObject2 failed\n");
        return 1;
    }
    FILE *f = fopen(argv[3], "wb");
    if (!f) {
        fprintf(stderr, "compile-helper: cannot open %s for writing\n", argv[3]);
        return 1;
    }
    if (out_len && fwrite(out, 1, out_len, f) != out_len) {
        fprintf(stderr, "compile-helper: short write on %s\n", argv[3]);
        fclose(f);
        return 1;
    }
    fclose(f);
    fprintf(stderr, "compile-helper: wrote %zu bytes to %s\n", out_len, argv[3]);
    return 0;
}
