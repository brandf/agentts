# Build the all-combinator host against a dquickts checkout.
#   make DQUICKTS=/path/to/dquickts
# The checkout must already be built so that libquickjs.a exists, and
# must carry the BRA-42 fork patch (JS_AbandonSuspended).
# Default is the patched minimal tree.
DQUICKTS ?= $(HOME)/workspace/dquickts-build-minimal

CC ?= cc
CFLAGS ?= -g -O2 -Wall

host: host.c
	$(CC) $(CFLAGS) -I$(DQUICKTS) host.c $(DQUICKTS)/libquickjs.a -lm -lpthread -ldl -o host

clean:
	rm -f host

.PHONY: clean
