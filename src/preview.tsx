import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { FIXTURE_NOW, meeting } from "./meeting-fixture";
import "./council.css";

const allMeetings = [
	meeting("weekly-planning", "Weekly planning", "open"),
	// The room is still live for the people inside it, so this card keeps its deadline.
	meeting("recording-lost", "Vendor call", "recording_start_unknown", { deadlineAt: FIXTURE_NOW + 1_200_000 }),
	meeting("customer-review", "Customer review", "processing"),
	meeting("design-critique", "Design critique", "ready", {
		artifacts: [
			{ kind: "track_audio", name: "speaker-a.webm" },
			{ kind: "transcript_markdown", name: "transcript.md" },
			{ kind: "summary_markdown", name: "summary.md" },
			{ kind: "provider_transcript", name: "provider-transcript.json" },
		],
	}),
	// Closing a meeting that never recorded settles it to `ready` with no artifacts at all, so this
	// card must not claim a saved folder.
	meeting("no-recording", "Budget check", "ready"),
	// Copy the sentence word for word from `failure_sentence` in the service's `routes-page.ts`. That
	// function is the only thing that ever fills `failureReason`, and it picks one fixed sentence per
	// status, so this is the whole text a `failed` card can show. It matters here because
	// `.meeting-failure` sets no width and no clamp, so the card is exactly as tall as the real text
	// makes it, and a short stand-in laid it out at a height the product never produces.
	meeting("provider-failure", "Partner interview", "failed", {
		failureReason:
			"Council could not finish saving this meeting's files. It keeps trying on its own for a few days; if the meeting still shows this, ask a workspace admin to look into it.",
	}),
	// The same rule as the card above, for the other sentence `failure_sentence` can return. It is a
	// different length and wraps in the same unclamped paragraph, so both cards have to sit here for
	// either wrap to be reviewable. Pass `closedAt`: the read-only refusal this sentence names needs
	// files in the folder, so the meeting it happens to is one that already finished.
	meeting("delete-blocked", "Hiring sync", "delete_failed", {
		closedAt: FIXTURE_NOW - 1_200_000,
		failureReason:
			"Council could not finish deleting this meeting, so it is still here. Press Delete again to start a new attempt; if a file in the meeting's folder is read-only, clear that first.",
	}),
];

const previewState = new URLSearchParams(window.location.search).get("state") ?? "all";
let meetings =
	previewState === "empty"
		? []
		: previewState === "all" || previewState === "stale"
			? allMeetings
			: [
					// `?state=` picks a fixture by meeting status. A value that matches none used to fall
					// back to a plausible "Project kickoff" card, so the preview looked fine and the reader
					// never learned the value missed. Name the value in the card instead. Say only "no
					// fixture": several real statuses have no fixture here either, so the value is not
					// necessarily wrong.
					allMeetings.find((item) => item.status === previewState) ??
						meeting("no-preview-fixture", `Preview has no fixture for ?state=${previewState}`, "created"),
				];
let listAttempts = 0;

function response(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

window.fetch = async (input, init) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const path = new URL(url).pathname;
	const body = JSON.parse(String(init?.body ?? "{}")) as { meetingId?: string; title?: string };
	if (path === "/api/meetings/list") {
		listAttempts += 1;
		if (previewState === "loading") {
			return await new Promise<Response>(() => {});
		}
		if (previewState === "stale" && listAttempts > 1) {
			return response(503, { message: "Preview refresh unavailable" });
		}
		return previewState === "error"
			? response(503, { message: "Preview service unavailable" })
			: response(200, { meetings });
	}
	if (path === "/api/meetings/create") {
		const created = meeting("new-meeting", body.title ?? "New meeting", "created");
		meetings = [created, ...meetings];
		return response(200, {
			meeting: created,
			joinCode: "council-demo-4821",
			guestUrl: "https://council.example.test/room?m=new-meeting",
		});
	}
	const index = meetings.findIndex((item) => item.id === body.meetingId);
	if (index < 0) {
		return response(404, { message: "Meeting not found" });
	}
	// Open is the one mutation that answers the whole meeting instead of a bare status. Match the
	// real route (`meeting_view` in the Council service), or `open_meeting` refuses the answer and
	// the created -> open -> host room link flow cannot be driven here at all.
	if (path === "/api/meetings/open") {
		meetings[index] = {
			...meetings[index]!,
			status: "open",
			openedAt: FIXTURE_NOW,
			deadlineAt: FIXTURE_NOW + 3_600_000,
		};
		return response(200, { meeting: meetings[index] });
	}
	if (path === "/api/meetings/room-ticket") {
		// The real route answers `/room?m=<meeting id>#ticket=<ticket>`. The room reads the meeting id
		// from the `m` search param and the ticket from the `ticket` fragment key, so a fixture with
		// another shape teaches a link that finds neither.
		const meetingId = encodeURIComponent(meetings[index]!.id);
		return response(200, { roomUrl: `https://council.example.test/room?m=${meetingId}#ticket=single-use` });
	}
	if (path === "/api/meetings/close") {
		meetings[index] = { ...meetings[index]!, status: "processing", closedAt: FIXTURE_NOW };
		return response(200, { status: "processing" });
	}
	// Delete leaves the meeting in the list, the same way close does above. The real route answers
	// `deleting`, and `handle_list` in the service drops only `deleted_tombstone`, so the card stays
	// under Active with the Deleting pill and loses its Delete button. Removing the row here made the
	// card disappear on the press, so the one state a member watches after pressing Delete could not
	// be reviewed in the preview at all.
	if (path === "/api/meetings/delete") {
		meetings[index] = { ...meetings[index]!, status: "deleting" };
		return response(200, { status: "deleting" });
	}
	return response(404, { message: `Unhandled preview route ${path}` });
};

const client = {
	getToken: async () => "plu_preview",
	refreshToken: async () => "plu_preview",
} as unknown as BonoboUiFrontendClient;

createRoot(document.getElementById("root")!).render(<App client={client} />);
