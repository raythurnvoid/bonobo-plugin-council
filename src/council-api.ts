/**
 * The page's client for the Council service API.
 *
 * Every call is a POST with `Authorization: Bearer <plu_ page token>` against the Council Worker
 * origin — the only origin the manifest's `uiOutboundOrigins` allows, so the browser's CSP stops
 * any other destination. The token is fetched from the host bridge per call and never stored; a
 * `401` asks the host for a fresh token exactly once and retries.
 *
 * This token handoff uses `plugin.service.connect`. The Council exchange requires
 * `plugin.data.read`, and `plugin.data.write` lets the Worker reserve and update meeting state. It
 * uses `workspace.files.write` and
 * `workspace.files.create-read-only` to save recordings, transcripts, summaries, and provider
 * transcripts as locked workspace artifacts. The page reaches that Worker through
 * `ui.outbound.fetch` and declares no other page outbound origin.
 *
 * Response shapes are validated at this boundary. The list keeps the meeting history and its
 * bounded finalized artifact summaries. Raw workspace node ids are not part of the page model.
 * Error bodies are `{message}`.
 */

export const COUNCIL_SERVICE_ORIGIN = "https://council.bonobo-senate.com";

export type CouncilMeeting = {
	id: string;
	title: string;
	status: string;
	createdAt: number | null;
	openedAt: number | null;
	closedAt: number | null;
	deadlineAt: number | null;
	participantCount: number | null;
	maxParticipants: number | null;
	destinationPath: string | null;
	failureReason: string | null;
	recordingWarning: string | null;
	artifacts: CouncilArtifact[];
};

export type CouncilArtifactKind = "track_audio" | "transcript_markdown" | "summary_markdown" | "provider_transcript";

export type CouncilArtifact = {
	kind: CouncilArtifactKind;
	name: string;
};

export type CouncilCreatedMeeting = {
	meeting: CouncilMeeting;
	joinCode: string;
	guestUrl: string;
};

function as_record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function as_optional_number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const ARTIFACT_KINDS = new Set<CouncilArtifactKind>([
	"track_audio",
	"transcript_markdown",
	"summary_markdown",
	"provider_transcript",
]);

/**
 * Read the artifact rows the dashboard renders, and skip a row it has no label for.
 *
 * The service can add a fifth artifact kind at any time, and an installed copy of this page keeps
 * running against the new service. If one unknown kind refused the whole list, the meeting would
 * stop parsing and the dashboard would go empty for EVERY meeting until every member upgrades. So
 * an unknown kind loses only its own row. A row without a name is a different case: `artifacts_view`
 * in the service always sends `name`, so a row without one is a broken response, not an older one.
 */
function parse_artifacts(value: unknown): CouncilArtifact[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const artifacts: CouncilArtifact[] = [];
	for (const item of value) {
		const record = as_record(item);
		if (!record) {
			return null;
		}

		// Drop a kind this build cannot label instead of refusing the meeting.
		if (typeof record.kind !== "string" || !ARTIFACT_KINDS.has(record.kind as CouncilArtifactKind)) {
			continue;
		}

		if (typeof record.name !== "string") {
			return null;
		}
		artifacts.push({ kind: record.kind as CouncilArtifactKind, name: record.name });
	}
	return artifacts;
}

function parse_meeting(value: unknown): CouncilMeeting | null {
	const record = as_record(value);
	if (
		!record ||
		typeof record.id !== "string" ||
		typeof record.title !== "string" ||
		typeof record.status !== "string"
	) {
		return null;
	}

	// Every meeting the service sends comes from its `meeting_view`, which always emits `artifacts`.
	// A meeting without that list is a broken response, not an older one.
	const artifacts = parse_artifacts(record.artifacts);
	if (artifacts === null) {
		return null;
	}
	return {
		id: record.id,
		title: record.title,
		status: record.status,
		createdAt: as_optional_number(record.createdAt),
		openedAt: as_optional_number(record.openedAt),
		closedAt: as_optional_number(record.closedAt),
		deadlineAt: as_optional_number(record.deadlineAt),
		participantCount: as_optional_number(record.participantCount),
		maxParticipants: as_optional_number(record.maxParticipants),
		destinationPath: typeof record.destinationPath === "string" ? record.destinationPath : null,
		failureReason: typeof record.failureReason === "string" ? record.failureReason : null,
		recordingWarning: typeof record.recordingWarning === "string" ? record.recordingWarning : null,
		artifacts,
	};
}

function unexpected_response(path: string): Error {
	return new Error(`Unexpected response from the Council service (${path})`);
}

export function create_council_api(client: { getToken(): Promise<string>; refreshToken(): Promise<string> }) {
	async function post(path: string, body: unknown): Promise<unknown> {
		const send = (bearer: string) =>
			fetch(COUNCIL_SERVICE_ORIGIN + path, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${bearer}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

		let response = await send(await client.getToken());
		if (response.status === 401) {
			// The page token expired mid-flight. Ask the host bridge for a fresh one exactly once;
			// a second 401 means the session itself is gone and surfaces as the thrown error below.
			response = await send(await client.refreshToken());
		}
		if (!response.ok) {
			const data = as_record(await response.json().catch(() => null));
			const message =
				data && typeof data.message === "string" && data.message !== ""
					? data.message
					: `Council request failed (${response.status})`;
			throw Object.assign(new Error(message), { status: response.status });
		}
		return response.json();
	}

	return {
		async list_meetings(): Promise<CouncilMeeting[]> {
			const data = as_record(await post("/api/meetings/list", {}));
			if (!data || !Array.isArray(data.meetings)) {
				throw unexpected_response("list");
			}
			const meetings: CouncilMeeting[] = [];
			for (const value of data.meetings) {
				const meeting = parse_meeting(value);
				if (!meeting) {
					throw unexpected_response("list");
				}
				meetings.push(meeting);
			}
			return meetings;
		},

		async create_meeting(title: string): Promise<CouncilCreatedMeeting> {
			const data = as_record(await post("/api/meetings/create", { title }));
			const meeting = data ? parse_meeting(data.meeting) : null;
			if (!data || !meeting || typeof data.joinCode !== "string" || typeof data.guestUrl !== "string") {
				throw unexpected_response("create");
			}
			return { meeting, joinCode: data.joinCode, guestUrl: data.guestUrl };
		},

		// Open answers the updated meeting, not a bare status: the dashboard needs the new deadline
		// and opened time to redraw the card without waiting for the next poll.
		async open_meeting(meetingId: string): Promise<CouncilMeeting> {
			const data = as_record(await post("/api/meetings/open", { meetingId }));
			const meeting = data ? parse_meeting(data.meeting) : null;
			if (!meeting) {
				throw unexpected_response("open");
			}
			return meeting;
		},

		async room_ticket(meetingId: string): Promise<string> {
			const data = as_record(await post("/api/meetings/room-ticket", { meetingId }));
			if (!data || typeof data.roomUrl !== "string") {
				throw unexpected_response("room-ticket");
			}
			return data.roomUrl;
		},

		async close_meeting(meetingId: string): Promise<string> {
			const data = as_record(await post("/api/meetings/close", { meetingId }));
			if (!data || typeof data.status !== "string") {
				throw unexpected_response("close");
			}
			return data.status;
		},

		async delete_meeting(meetingId: string): Promise<string> {
			const data = as_record(await post("/api/meetings/delete", { meetingId }));
			if (!data || typeof data.status !== "string") {
				throw unexpected_response("delete");
			}
			return data.status;
		},
	};
}

export type CouncilApi = ReturnType<typeof create_council_api>;

export function get_error_message(error: unknown): string {
	return error instanceof Error && error.message !== "" ? error.message : "Something went wrong";
}
