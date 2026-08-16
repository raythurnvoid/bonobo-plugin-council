/**
 * The page's client for the Council service API.
 *
 * Every call is a POST with `Authorization: Bearer <plu_ page token>` against the Council Worker
 * origin — the only origin the manifest's `uiOutboundOrigins` allows, so the browser's CSP stops
 * any other destination. The token is fetched from the host bridge per call and never stored; a
 * `401` asks the host for a fresh token exactly once and retries.
 *
 * Response shapes: only `create` (`{meeting, joinCode, guestUrl}`) and `room-ticket`
 * (`{roomUrl}`) are pinned by the room/page contract. The `list` (`{meetings}`) and `get`
 * (`{meeting, artifacts}`) shapes are this page's assumption and get reconciled against the
 * service implementation. Error bodies are `{message}`.
 */

export const COUNCIL_SERVICE_ORIGIN = "https://bonobo-council-service.ray-thurne-void.workers.dev";

export type CouncilMeeting = {
	id: string;
	title: string;
	status: string;
	createdAt: number | null;
	deadlineAt: number | null;
	maxParticipants: number | null;
	failureReason: string | null;
};

export type CouncilArtifact = {
	name: string;
	fileNodeId: string | null;
};

export type CouncilCreatedMeeting = {
	meeting: CouncilMeeting;
	joinCode: string;
	guestUrl: string;
};

export type CouncilMeetingDetails = {
	meeting: CouncilMeeting;
	artifacts: CouncilArtifact[];
};

function as_record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function as_optional_number(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parse_meeting(value: unknown): CouncilMeeting | null {
	const record = as_record(value);
	if (!record || typeof record.id !== "string" || typeof record.title !== "string" || typeof record.status !== "string") {
		return null;
	}
	return {
		id: record.id,
		title: record.title,
		status: record.status,
		createdAt: as_optional_number(record.createdAt),
		deadlineAt: as_optional_number(record.deadlineAt),
		maxParticipants: as_optional_number(record.maxParticipants),
		failureReason: typeof record.failureReason === "string" ? record.failureReason : null,
	};
}

// Artifact rows are display-only, so unknown extra fields are fine; a row without a name is not.
function parse_artifact(value: unknown): CouncilArtifact | null {
	const record = as_record(value);
	if (!record) {
		return null;
	}
	const name = typeof record.name === "string" ? record.name : typeof record.path === "string" ? record.path : null;
	if (name === null) {
		return null;
	}
	return {
		name,
		fileNodeId: typeof record.fileNodeId === "string" ? record.fileNodeId : null,
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

		async get_meeting(meetingId: string): Promise<CouncilMeetingDetails> {
			const data = as_record(await post("/api/meetings/get", { meetingId }));
			const meeting = data ? parse_meeting(data.meeting) : null;
			if (!data || !meeting) {
				throw unexpected_response("get");
			}
			const artifacts: CouncilArtifact[] = [];
			if (Array.isArray(data.artifacts)) {
				for (const value of data.artifacts) {
					const artifact = parse_artifact(value);
					if (artifact) {
						artifacts.push(artifact);
					}
				}
			}
			return { meeting, artifacts };
		},

		async open_meeting(meetingId: string): Promise<void> {
			await post("/api/meetings/open", { meetingId });
		},

		async room_ticket(meetingId: string): Promise<string> {
			const data = as_record(await post("/api/meetings/room-ticket", { meetingId }));
			if (!data || typeof data.roomUrl !== "string") {
				throw unexpected_response("room-ticket");
			}
			return data.roomUrl;
		},

		async close_meeting(meetingId: string): Promise<void> {
			await post("/api/meetings/close", { meetingId });
		},

		async delete_meeting(meetingId: string): Promise<void> {
			await post("/api/meetings/delete", { meetingId });
		},
	};
}

export type CouncilApi = ReturnType<typeof create_council_api>;

export function get_error_message(error: unknown): string {
	return error instanceof Error && error.message !== "" ? error.message : "Something went wrong";
}
