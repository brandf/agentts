# Build the prototype host against a dquickts checkout.
#   make DQUICKTS=/path/to/dquickts
# The checkout must already be built (cd dquickts && make) so that
# libquickjs.a exists.
DQUICKTS ?= $(HOME)/workspace/dquickts-build

CC ?= cc
CFLAGS ?= -g -O2 -Wall

proto: host.c
	$(CC) $(CFLAGS) -I$(DQUICKTS) host.c $(DQUICKTS)/libquickjs.a -lm -lpthread -ldl -o proto

clean:
	rm -f proto

.PHONY: clean
