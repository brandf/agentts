# Direct adapter plugin (BRA-68)

The direct/coordinator environment adapter (Layer 3). Real
execution: one worker process per job trap, real `exec`, held
gates, local decision model for `decide`.

## Layout

```
src/
  direct-adapter.ts  THE implementation (DirectAdapter class)
  adapter.ts         the loadable seam (createAdapter / default)
                     — Host.loadAdapter("direct") imports this file
```

One folder per environment; see `../README.md` (the Layer 3 home)
for the adapters-vs-plugins explanation and the import lint.
