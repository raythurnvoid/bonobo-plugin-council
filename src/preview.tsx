import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import type { CouncilMeeting } from "./council-api";
import "./council.css";

const NOW = Date.UTC(2026, 7, 22, 10, 30);

function meeting(id: string, title: string, status: string, overrides: Partial<CouncilMeeting> = {}): CouncilMeeting {
	return {
		id,
		title,
		status,
		createdAt: NOW - 3_600_000,
		openedAt: status === "created" ? null : NOW - 3_000_000,
		closedAt: ["ready", "failed", "processing", "closed"].includes(status) ? NOW - 1_200_000 : null,
		deadlineAt: status === "open" ? NOW + 2_400_000 : null,
		participantCount: status === "created" ? 0 : 4,
		maxParticipants: 25,
		destinationPath: `/meetings/${id}`,
		failureReason: null,
		artifacts: [],
		...overrides,
	};
}

const allMeetings = [
	meeting("weekly-planning", "Weekly planning", "open"),
	meeting("customer-review", "Customer review", "processing"),
	meeting("design-critique", "Design critique", "ready", {
		artifacts: [
			{ kind: "track_audio", name: "speaker-a.webm" },
			{ kind: "transcript_markdown", name: "transcript.md" },
			{ kind: "summary_markdown", name: "summary.md" },
			{ kind: "provider_transcript", name: "provider-transcript.json" },
		],
	}),
	meeting("provider-failure", "Partner interview", "failed", {
		failureReason: "The recording provider did not return a finished recording.",
	}),
];

const previewState = new URLSearchParams(window.location.search).get("state") ?? "all";
let meetings =
	previewState === "empty"
		? []
		: previewState === "all" || previewState === "stale"
			? allMeetings
			: [
					allMeetings.find((item) => item.status === previewState) ??
						meeting("created-meeting", "Project kickoff", "created"),
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
	if (path === "/api/meetings/open") {
		meetings[index] = { ...meetings[index]!, status: "open", openedAt: NOW, deadlineAt: NOW + 3_600_000 };
		return response(200, { status: "open" });
	}
	if (path === "/api/meetings/room-ticket") {
		return response(200, { roomUrl: "https://council.example.test/room#host-ticket=single-use" });
	}
	if (path === "/api/meetings/close") {
		meetings[index] = { ...meetings[index]!, status: "processing", closedAt: NOW };
		return response(200, { status: "processing" });
	}
	if (path === "/api/meetings/delete") {
		meetings = meetings.filter((item) => item.id !== body.meetingId);
		return response(200, { status: "deleting" });
	}
	return response(404, { message: `Unhandled preview route ${path}` });
};

const client = {
	getToken: async () => "plu_preview",
	refreshToken: async () => "plu_preview",
} as unknown as BonoboUiFrontendClient;

createRoot(document.getElementById("root")!).render(<App client={client} />);
