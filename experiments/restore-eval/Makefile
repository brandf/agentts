# Build the restore+eval experiment host against a dquickts checkout.
#   make DQUICKTS=/path/to/dquickts
# The checkout must already be built so that libquickjs.a exists.
# Default is the minimal tree (pinned commit 96a9a79).
DQUICKTS ?= $(HOME)/workspace/dquickts-build-minimal

CC ?= cc
CFLAGS ?= -g -O2 -Wall

reval: reval.c
	$(CC) $(CFLAGS) -I$(DQUICKTS) reval.c $(DQUICKTS)/libquickjs.a -lm -lpthread -ldl -o reval

clean:
	rm -f reval

.PHONY: clean
