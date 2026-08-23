# Bonobo Plugin Council

Council is the members-only dashboard for the Council meeting service. A workspace member creates a meeting, saves the one-time guest invite, opens the meeting, copies a single-use host room link, and follows processing from the same page.

The room is not part of this plugin. The Council Worker in `packages/council-service` serves it on its own origin, so a guest never reaches the app origin or this members-only page.

## Dashboard flow

1. Create a meeting with a required title.
2. Save the join code and guest link. The service stores only the code hash, so the dashboard cannot show the invite again.
3. Select **Open meeting**. The meeting moves from `created` to `open`.
4. Select **Get host room link**, copy the single-use link, and open it in a new browser tab.
5. Close the meeting when the call ends. Council shows processing without hiding the last useful meeting list if a later refresh fails.
6. Find finished artifacts under `/meetings/<meeting-id>/` on the host Files page.

Cards show timestamps, participant count, destination, status, and friendly artifact labels. They never show raw workspace node ids. The current SDK has no host-navigation bridge, so this secure iframe explains where files are instead of trying to open a host page.

## Saved artifacts

These files are created only when the host starts recording. An unrecorded meeting closes without an artifact pipeline.

- Participant recording tracks
- Attributed transcript Markdown
- AI summary Markdown
- Raw provider transcript JSON

Council asks the service upload API to create every artifact as read-only. Transcript, summary, and provider transcript files are also non-collaborative text files. Recording tracks stay stored binary files.

## Service connection and capabilities

- `plugin.service.connect` lets the Council service exchange the page token for an installation-bound service grant.
- `plugin.data.read` and `plugin.data.write` cover the service's meeting documents.
- `workspace.files.write` lets the sealed processing grant create meeting artifacts under its destination prefix.
- `workspace.files.create-read-only` lets that same narrow upload request lock only the file it creates. It cannot lock an existing member file.
- `ui.outbound.fetch` plus `uiOutboundOrigins` lets the page call only the Council Worker origin.

Every page call gets a current `plu_` token from `bonobo-plugin-sdk/frontend`. A `401` refreshes it once. Join codes and room links use copy actions because the iframe has no popup permission.

## Development

Run Node-backed commands through Vite Plus. Keep `--ignore-workspace` because this plugin is a standalone git submodule.

```powershell
vp env exec pnpm --ignore-workspace install
vp env exec pnpm --ignore-workspace run test:once
vp env exec pnpm --ignore-workspace run typecheck
vp env exec pnpm --ignore-workspace run build
vp env exec pnpm --ignore-workspace run build:verify
```

`pnpm build` creates `dist/frontend/`, formats the readable JS and CSS, discovers every emitted frontend file, and rebuilds the manifest inventory. The manifest command refuses unknown extensions, MIME mismatches, invalid UTF-8 review text, more than 64 files, files over 900,000 bytes, artifacts over 16 MiB, and combined review text over 900,000 bytes. A line over 1,000 characters prints non-blocking review advice.

Commit `dist/`. The publisher reads these exact bytes from the Council repository.

For local visual checks, run the Vite development command and open `preview.html?state=all`. The preview uses fixed data and never calls a deployed service. Supported focused states are `open`, `recording_start_unknown`, `processing`, `ready`, `failed`, `delete_failed`, `loading`, `empty`, `error`, and `stale`. A focused state other than `loading`, `empty`, `error`, and `stale` is matched against a meeting **status**, so it works only when a fixture carries that status. `created` is not one of them, despite what this line used to say: `?state=created` renders a card titled `Preview has no fixture for ?state=created`. Use the create form for a real `created` card, as the next sentence describes. The stale state shows cards first, then keeps them under a refresh error after the next poll. Create a meeting in any normal state to inspect the one-time invite and its real `created → open` interaction.

## Release checklist

Do not deploy or publish as part of a normal source change. A release needs separate approval.

1. Turn on the meeting maintenance bridge. Audit and drain every old artifact row and matching host target.
2. Apply Council D1 migrations `0006`, `0007`, and `0008`. `0008` drops the two `meeting_tracks` columns nothing ever wrote, `participant_id` and `start_offset_ms`.
3. Deploy the strict core upload contract and the new read-only capability.
4. Deploy the final Council Worker.
5. Confirm the SDK commit pinned in `package.json` resolves to `0.9.2` in `pnpm-lock.yaml`. The mirror is already pushed.
6. Update Council source and set the same unused version in `bonobo.plugin.json` and `package.json`.
7. Run the focused tests and typecheck.
8. Run `build:verify`. It fingerprints the release files on disk, then runs the full build twice. It fails when the second build changes a release byte, and when the files that were on disk no longer match a fresh build. It never reads git, so it cannot tell you whether those files are also committed.
9. Commit and push the Council submodule repository, then verify the remote default-branch `HEAD` is the exact local commit SHA.
10. Run `git status --porcelain` and confirm it prints nothing at all. Checking only `bonobo.plugin.json`, `package.json`, and `dist/` is not enough: an untracked file under `src/` passes that check, and step 7 then passes here only because the file is on your disk. From a fresh clone of the published commit, the same tests and typecheck cannot resolve it. The publisher reads these files from GitHub at the pinned commit, so a commit that carries new `src/` without the rebuilt `dist/` publishes a `dist` that its own source did not produce. The manifest `sha256` entries still match that stale `dist`, so nothing later in the pipeline notices, and the review verdict then describes an artifact its source never built.
11. Update the root repository's Council gitlink to that SHA.
12. Publish immediately from that exact commit and verify the stored `sourceCommitSha`.
13. Accept the new capability on the installation and run the create, join, close, and artifact smoke test.
14. Reopen meeting creation.

After an approved `0.2.0` publish, the installation must review and accept the new read-only-file capability. Until it does, the service-grant exchange refuses every page call with 403, and the dashboard cannot get a grant at all, because the exchange is the only thing that creates one. So the member cannot list, create, open, close, or delete a meeting. The whole page is dead, not only the artifact writing.
