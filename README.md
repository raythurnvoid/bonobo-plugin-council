# Bonobo Plugin Council

Members-only dashboard for the Council meeting platform. From this page a workspace member creates a recorded meeting, shares the guest link and one-time join code, opens the meeting, gets their single-use host room link, and later sees the recording and transcript files the service wrote into the workspace.

The meeting room itself is **not** part of this plugin. It is served by the Council Worker (`packages/council-service` in the app monorepo) on its own origin, so strangers with a join link never touch the app origin or this page.

## How the page talks to the service

- The page connects to the host app with `bonobo_ui_connect` from `bonobo-plugin-sdk/frontend` and receives a short-lived `plu_` page token.
- Every Council call is a `POST` to the Council Worker origin with that token as the bearer. The manifest's `uiOutboundOrigins` lists exactly that origin, so the page's CSP refuses any other destination.
- The token is fetched per call and never stored; a `401` asks the host bridge for a fresh token once and retries.
- The one-time join code and the single-use host room link are shown with copy affordances. The host iframe sandbox has no `allow-popups`, so the page cannot open the room in a new tab itself — the member copies the link and opens it in a browser tab.

## Capabilities

- `plugin.service.connect` — lets the Council service exchange this page's token for an installation-bound service grant.
- `plugin.data.read` / `plugin.data.write` — the service's meeting documents.
- `workspace.files.write` — the service writes recordings and transcripts into workspace files.
- `ui.outbound.fetch` + `uiOutboundOrigins` — the page may call the Council Worker origin.

## Development

```
pnpm install
pnpm test:once
pnpm typecheck
pnpm build
```

`pnpm build` writes `dist/frontend/` and syncs `bonobo.plugin.json` file hashes plus the `dist/bonobo.plugin.json` copy the app fetches at publish time. Commit `dist/` — the publisher reads it from the repository.
