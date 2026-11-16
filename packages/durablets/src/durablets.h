/* DurableTS core library (Linear BRA-43) — public C interface.
 *
 * The core is the trap dispatch point + suspend/resume + the
 * all/any/race builtins + trapId identity, on the patched minimal
 * dquickts tree (BRA-42 JS_AbandonSuspended). It knows nothing about
 * scheduling, journaling, workers, or what a trap type means — the
 * host plugin owns all of that. Embedders register the builtins with
 * durablets_register() and pass durablets_host to
 * JS_WriteSnapshot / JS_ReadSnapshot. Events for the plugin go to
 * stderr as "[durablets] {json}" lines via durablets_emit_event().
 */
#ifndef DURABLETS_H
#define DURABLETS_H

#include "quickjs.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Snapshot host descriptor: the native registry (print, trap, all,
 * any, race — in this order; append after race). */
extern const JSSnapshotHost durablets_host;

/* Register the core builtins (trap, all, any, race, print) as globals
 * on ctx. */
void durablets_register(JSContext *ctx);

/* Emit one plugin event: a JSON object on stderr, prefixed
 * "[durablets] ". The plugin records these (its journal) and
 * maintains its run registry from the lifecycle events. */
void durablets_emit_event(const char *json);

#ifdef __cplusplus
}
#endif

#endif /* DURABLETS_H */
