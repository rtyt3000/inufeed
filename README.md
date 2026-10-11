# frinufeed

Inugram plugin (`rtyt300.frinufeed`) that turns a chat folder into a single feed of its channels and hides the folder from the folder tabs.

## Development

```sh
bun install
bun run check        # validate manifest/grants and typecheck
bun run build        # build dist/frinufeed.inu.js
bun run dev:feed     # build, push to a connected device and reload on changes
```

Device work requires a running Inugram app with plugin developer mode enabled.
Use `--app desu.inugram.beta` for the debug app and `-s <serial>` to select a device.

## Layout

- `inu.config.ts`: plugin entry, manifest and grants
- `src/feed/`: plugin source
- `src/shared/`: reusable helpers
- `dist/frinufeed.inu.js`: generated output
