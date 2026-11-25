# DurableTS core library + thin host CLI (Linear BRA-43).
#   make DQUICKTS=/path/to/dquickts
#   make OUT_DIR=/path/to/scratch
# The checkout must already be built so that libquickjs.a exists, and
# must carry the BRA-42 fork patch (JS_AbandonSuspended).
# Default is the patched minimal tree vendored inside this package
# (vendor/dquickts), installed by ./re-vendor.sh — see BUILDING.md at
# the repo root. The engine tree is NOT modified.
#
# Build outputs go to OUT_DIR (default ./out/), never into the package
# tree: run.sh sets OUT_DIR to a fresh mktemp dir, so a full run leaves
# the staged tree sources-only. `make clean` removes the binary plus
# the legacy in-tree outputs (./durablets, ./out, ./test-runs).
PKGDIR := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
DQUICKTS ?= $(PKGDIR)/vendor/dquickts
OUT_DIR ?= out

CC ?= cc
CFLAGS ?= -g -O2 -Wall

# BRA-214: the engine source hash baked into the binary
# (`durablets version` prints it). The TS host verifies it before
# delivering a file-backed trap result, so a binary built from
# different (older) source fails loudly instead of crashing on
# resume. Hash of the C host's own sources, in a fixed order.
ENGINE_SOURCE_HASH := $(shell cat src/durablets.c src/durablets.h | sha256sum | cut -d' ' -f1)

durablets: check-engine $(OUT_DIR)/durablets

# Fail fast with instructions when the vendored engine tree is absent
# (e.g. a fresh clone where re-vendor.sh has not been run yet),
# instead of dying later on a cryptic missing-libquickjs.a error.
check-engine:
	@if [ ! -f "$(DQUICKTS)/libquickjs.a" ]; then \
		echo "error: no patched dquickts tree at $(DQUICKTS) (libquickjs.a missing)" >&2; \
		echo "  Build it with: ./re-vendor.sh <pinned-commit>   (from packages/durablets; the pin is in UPKEEP.md)" >&2; \
		echo "  Or point at an existing tree: make DQUICKTS=/path/to/dquickts durablets" >&2; \
		echo "  See BUILDING.md at the repo root." >&2; \
		exit 1; \
	fi

$(OUT_DIR)/durablets: src/durablets.c src/durablets.h
	mkdir -p "$(OUT_DIR)"
	$(CC) $(CFLAGS) -DENGINE_SOURCE_HASH='"$(ENGINE_SOURCE_HASH)"' -Isrc -I$(DQUICKTS) src/durablets.c $(DQUICKTS)/libquickjs.a -lm -lpthread -ldl -o "$@"

clean:
	rm -f $(OUT_DIR)/durablets durablets
	rm -rf out test-runs

.PHONY: clean durablets check-engine
