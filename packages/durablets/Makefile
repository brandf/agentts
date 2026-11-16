# DurableTS core library + thin host CLI (Linear BRA-43).
#   make DQUICKTS=/path/to/dquickts
#   make OUT_DIR=/path/to/scratch
# The checkout must already be built so that libquickjs.a exists, and
# must carry the BRA-42 fork patch (JS_AbandonSuspended).
# Default is the patched minimal tree. The engine tree is NOT modified.
#
# Build outputs go to OUT_DIR (default ./out/), never into the package
# tree: run.sh sets OUT_DIR to a fresh mktemp dir, so a full run leaves
# the staged tree sources-only. `make clean` removes the binary plus
# the legacy in-tree outputs (./durablets, ./out, ./test-runs).
DQUICKTS ?= $(HOME)/workspace/dquickts-build-minimal
OUT_DIR ?= out

CC ?= cc
CFLAGS ?= -g -O2 -Wall

durablets: $(OUT_DIR)/durablets

$(OUT_DIR)/durablets: src/durablets.c src/durablets.h
	mkdir -p "$(OUT_DIR)"
	$(CC) $(CFLAGS) -Isrc -I$(DQUICKTS) src/durablets.c $(DQUICKTS)/libquickjs.a -lm -lpthread -ldl -o "$@"

clean:
	rm -f $(OUT_DIR)/durablets durablets
	rm -rf out test-runs

.PHONY: clean durablets
