# Bonobo Plugin Council

Council is the members-only dashboard for the Council meeting service. A workspace member creates a meeting, chooses guest access, shares the invite, opens the meeting, copies a single-use host room link, and follows processing from the same page.

The room is not part of this plugin. The Council Worker in `packages/council` serves it on its own origin, so a guest never reaches the app origin or this members-only page.

## Dashboard flow

1. Create a meeting with a required title. Choose **Token required** (the default), **Host approval**, or **Anyone with the link** under **Guest access**.
2. Share the guest link. Token rooms also need the join code. Approval rooms let guests ask to join; a host approves each guest in the room. Link rooms admit anyone who has the link.
3. Select **Open meeting**. The meeting moves from `created` to `open`.
4. Select **Get host room link**, copy the single-use link, and open it in a new browser tab.
5. Close the meeting when the call ends. Council shows processing without hiding the last useful meeting list if a later refresh fails.
6. Find finished artifacts under `/meetings/<meeting-id>/` on the host Files page.

Cards show timestamps, participant count, destination, status, and friendly artifact labels. They never show raw workspace node ids. The current SDK has no host-navigation bridge, so this secure iframe explains where files are instead of trying to open a host page.

Created and open cards offer **Show invite**, including after a reload. The page fetches the invite only when asked. **Hide invite** clears it from the card. Codes stay in page memory and never enter the meeting list, logs, or localStorage. The service encrypts new token codes so members can retrieve them again. Older token rooms may have only a code hash: their invite still shows the guest link, but explains that the original saved code is needed.

The dashboard sends `POST /api/meetings/create` with `{title, admissionMode}`. The service defaults omitted modes to `token` for older callers. Each meeting has `admissionMode: "token" | "approval" | "link"`. Create returns `{meeting, joinCode, guestUrl}`; `POST /api/meetings/invite` accepts `{meetingId}` and returns `{joinCode, guestUrl}`. `joinCode` is a string for recoverable token rooms and `null` for other modes or older unrecoverable codes. Both routes require the current member page token.

## Saved artifacts

These files are created only when the host starts recording. An unrecorded meeting closes without an artifact pipeline.

- Participant recording tracks
- Attributed transcript Markdown
- AI summary Markdown
- Raw provider transcript JSON

Council asks the service upload API to create every artifact as read-only. Transcript, summary, and provider transcript files are also non-collaborative text files. Recording tracks stay stored binary files.

## Service connection and capabilities

- `plugin.service.connect` lets the Council service exchange the page token for an installation-bound service grant. The Worker keeps every meeting in its own D1 database and uses no plugin data, so the manifest declares neither `plugin.data` capability.
- `workspace.files.write` lets the sealed processing grant create meeting artifacts and the meeting note under its destination prefix.
- `workspace.files.manage-read-only` lets the Worker set the Read-only flag and use `force: true` for its file writes, uploads, and meeting-folder archive. Force skips the flag; it never skips file permissions.
- `ui.outbound.fetch` plus `uiOutboundOrigins` lets the page call only the Council Worker origin.

The installation must accept the new capability. The actor and Council service account still need **Can edit** for the affected files. The old `workspace.files.create-read-only` consent grants none of the new authority. Read-only is a local flag: it has no selected writer or folder default. A member with Can edit can clear it in Properties.

Deleting a meeting moves permitted files to Trash. If some files are blocked, the meeting stays in `delete_failed`, keeps its grants and artifact records, and reports how many items moved. A later delete continues against the same folder receipt. It cannot switch to a new folder that reused the path. Only a complete archive clears the meeting and its private data.

Every page call gets a current `plu_` token from `bonobo-plugin-sdk/frontend`. A `401` refreshes it once. Join codes and room links use copy actions because the iframe has no popup permission.

## Development

Run Node-backed commands through Vite Plus. Do not add `--ignore-workspace`: this repo has its own `pnpm-workspace.yaml`, and pnpm 12 skips it with that flag.

```powershell
vp env exec pnpm install
vp env exec pnpm run test:once
vp env exec pnpm run typecheck
vp env exec pnpm run build
vp env exec pnpm run build:verify
```

`pnpm build` creates `dist/frontend/`, formats the readable JS and CSS, discovers every emitted frontend file, and rebuilds the manifest inventory. The manifest command refuses unknown extensions, MIME mismatches, invalid UTF-8 review text, more than 64 files, files over 900,000 bytes, artifacts over 16 MiB, and combined review text over 900,000 bytes. A line over 1,000 characters prints non-blocking review advice.

Commit `dist/`. The publisher reads these exact bytes from the Council repository.

For local visual checks, run the Vite development command and open `preview.html?state=all`. The preview uses fixed data and never calls a deployed service. Supported focused states are `created`, `open`, `recording_start_unknown`, `processing`, `ready`, `failed`, `delete_failed`, `loading`, `empty`, `error`, and `stale`. Guest access fixtures also support `?state=token`, `?state=approval`, and `?state=link`. Other focused values show a card naming the missing fixture. The stale state shows cards first, then keeps them under a refresh error after the next poll. The all state includes an older token room with an unrecoverable code. Use **Show invite** on a listed card, reload and show it again, or create a meeting in each mode to inspect its `created → open` flow.

## Release checklist

Do not deploy or publish as part of a normal source change. A release needs separate approval.

1. Pause new meeting creation. Finish active processing and old deletion workflows before the capability upgrade. Keep completed meetings and artifacts.
2. Read the applied D1 migration list. Do not repeat completed migrations or erase artifact rows. The last checked deployment had `0001` through `0011`.
3. Deploy the reviewed host API through its approved data migration. Apply Council D1 migration `0012_delete_archive_receipt.sql` before the Worker that uses archive receipts. This source change does not apply it.
4. Deploy the final Council Worker.
5. Confirm `package.json` and `pnpm-lock.yaml` pin SDK `0.24.0` at mirror commit `00fb32707c6c8e48be2cfb9e1074f64c4011a6ff`. The mirror is pushed; this source preparation does not deploy or publish Council.
6. Update Council source and set the same unused version in `bonobo.plugin.json` and `package.json`.
7. Run the focused tests and typecheck.
8. Run `build:verify`. It fingerprints the release files on disk, then runs the full build twice. It fails when the second build changes a release byte, and when the files that were on disk no longer match a fresh build. It never reads git, so it cannot tell you whether those files are also committed.
9. Commit and push the Council submodule repository, then verify the remote default-branch `HEAD` is the exact local commit SHA.
10. Run `git status --porcelain` and confirm it prints nothing at all. Checking only `bonobo.plugin.json`, `package.json`, and `dist/` is not enough: an untracked file under `src/` passes that check, and step 7 then passes here only because the file is on your disk. From a fresh clone of the published commit, the same tests and typecheck cannot resolve it. The publisher reads these files from GitHub at the pinned commit, so a commit that carries new `src/` without the rebuilt `dist/` publishes a `dist` that its own source did not produce. The manifest `sha256` entries still match that stale `dist`, so nothing later in the pipeline notices, and the review verdict then describes an artifact its source never built.
11. Publish from that exact commit and verify the stored `sourceCommitSha`.
12. Update the root repository's Council gitlink to the published SHA.
13. Accept `workspace.files.manage-read-only` on the installation and run the create, join, close, artifact, and partial-delete smoke tests.
14. Reopen meeting creation.

After an approved `0.2.0` publish, the installation must review and accept the new read-only-file capability. Until it does, the service-grant exchange refuses every page call with 403, and the dashboard cannot get a grant at all, because the exchange is the only thing that creates one. So the member cannot list, create, open, close, or delete a meeting. The whole page is dead, not only the artifact writing.

`0.2.14` drops `plugin.data.read` and `plugin.data.write`. Publish it only after the Council Worker that no longer calls the plugin-data routes is deployed and the service registration's scopes are `files:write` alone. Upgrading an installation kills every service grant it holds. The page exchanges again on its next call, but a meeting that is still `processing` loses its sealed grant and its run fails on the next host call. So upgrade only when no meeting is `processing` or `deleting`. The order and the checks are in `packages/council/README.md` under the release gate, step 5a.
