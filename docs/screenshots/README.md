# Screenshots

Captured from a throwaway bb instance with invented projects and threads, not
from anyone's real workspace. To reproduce, run a second bb server against a
scratch data dir and port:

```sh
BB_DATA_DIR=/tmp/bb-shot/data BB_SERVER_PORT=38999 BB_HOST_DAEMON_PORT=38998 \
  node <bb-app>/dist/bb-server.js
```

The bundled `better-sqlite3` is built for Electron's ABI, so a plain Node
process needs its own build of that one module. Everything else runs as is.

The bb sidebar is collapsed in all three (⌘\\), since it lists threads too and
two thread lists side by side reads as a bug rather than a feature.

| File | Shows |
| --- | --- |
| `deck.png` | The list, all four states, with a thread selected. |
| `keyboard.png` | The `?` sheet, rendered from the live bindings. |
| `settings.png` | Project marks, saved views, and the binding editor. |
