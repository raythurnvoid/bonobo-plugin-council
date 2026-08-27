import { afterEach, describe, expect, test, vi } from "vitest";
import { COUNCIL_SERVICE_ORIGIN, create_council_api } from "./council-api";

function json_response(status: number, body: unknown) {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function make_client(tokens: string[]) {
	let index = 0;
	return {
		getToken: vi.fn(async () => tokens[0]!),
		refreshToken: vi.fn(async () => tokens[Math.min((index += 1), tokens.length - 1)]!),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("create_council_api", () => {
	test("POSTs JSON to the Council origin with the page token as bearer", async () => {
		const fetchMock = vi.fn(async () => json_response(200, { meetings: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const api = create_council_api(make_client(["plu_first"]));

		await api.list_meetings();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${COUNCIL_SERVICE_ORIGIN}/api/meetings/list`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer plu_first");
		expect(init.body).toBe("{}");
	});

	test("a 401 refreshes the token once and retries", async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const bearer = (init.headers as Record<string, string>).Authorization;
			return bearer === "Bearer plu_fresh"
				? json_response(200, { meetings: [] })
				: json_response(401, { message: "Unauthenticated" });
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = make_client(["plu_stale", "plu_fresh"]);
		const api = create_council_api(client);

		await expect(api.list_meetings()).resolves.toEqual([]);
		expect(client.refreshToken).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("a second 401 surfaces as the error instead of looping", async () => {
		const fetchMock = vi.fn(async () => json_response(401, { message: "Unauthenticated" }));
		vi.stubGlobal("fetch", fetchMock);
		const client = make_client(["plu_stale", "plu_still_stale"]);
		const api = create_council_api(client);

		await expect(api.list_meetings()).rejects.toThrow("Unauthenticated");
		expect(client.refreshToken).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("a non-ok response throws the service's {message} with the status attached", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json_response(429, { message: "Too many meetings. Try again later." })),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const failure = await api.create_meeting("Standup").catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("Too many meetings. Try again later.");
		expect((failure as Error & { status: number }).status).toBe(429);
	});

	test("create returns the one-time join code and guest link", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meeting: { id: "m1", title: "Standup", status: "created", artifacts: [] },
					joinCode: "one-time-code",
					guestUrl: "https://council.example.com/room?m=m1",
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const created = await api.create_meeting("Standup");
		expect(created.joinCode).toBe("one-time-code");
		expect(created.guestUrl).toBe("https://council.example.com/room?m=m1");
		expect(created.meeting).toEqual({
			id: "m1",
			title: "Standup",
			status: "created",
			createdAt: null,
			openedAt: null,
			closedAt: null,
			deadlineAt: null,
			participantCount: null,
			maxParticipants: null,
			destinationPath: null,
			failureReason: null,
			recordingWarning: null,
			artifacts: [],
		});
	});

	test("list keeps meeting history fields and finalized artifact summaries", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "ready",
							createdAt: 100,
							openedAt: 200,
							closedAt: 300,
							participantCount: 4,
							destinationPath: "/meetings/m1",
							artifacts: [
								{ kind: "track_audio", name: "speaker-a.webm", fileNodeId: "node-private" },
								{ kind: "transcript_markdown", name: "transcript.md", fileNodeId: "node-private-2" },
								{ kind: "summary_markdown", name: "summary.md" },
								{ kind: "provider_transcript", name: "provider-transcript.json" },
							],
						},
					],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const [listed] = await api.list_meetings();
		expect(listed).toMatchObject({
			openedAt: 200,
			closedAt: 300,
			participantCount: 4,
			destinationPath: "/meetings/m1",
		});
		expect(listed?.artifacts).toEqual([
			{ kind: "track_audio", name: "speaker-a.webm" },
			{ kind: "transcript_markdown", name: "transcript.md" },
			{ kind: "summary_markdown", name: "summary.md" },
			{ kind: "provider_transcript", name: "provider-transcript.json" },
		]);
	});

	test("a list response without the expected shape is refused, not rendered", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json_response(200, { meetings: [{ id: "m1" }] })),
		);
		const api = create_council_api(make_client(["plu_first"]));

		await expect(api.list_meetings()).rejects.toThrow("Unexpected response from the Council service");
	});

	test("room-ticket returns the single-use room URL", async () => {
		const fetchMock = vi.fn(async () => json_response(200, { roomUrl: "https://council.example.com/room#ticket=x" }));
		vi.stubGlobal("fetch", fetchMock);
		const api = create_council_api(make_client(["plu_first"]));

		await expect(api.room_ticket("m1")).resolves.toBe("https://council.example.com/room#ticket=x");
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.body).toBe(JSON.stringify({ meetingId: "m1" }));
	});

	test("mutation responses are validated and returned for immediate UI updates", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/open")) {
					return json_response(200, { meeting: { id: "m1", title: "Standup", status: "open", artifacts: [] } });
				}
				return json_response(200, { status: url.endsWith("/close") ? "processing" : "deleting" });
			}),
		);
		const api = create_council_api(make_client(["plu_first"]));

		await expect(api.open_meeting("m1")).resolves.toMatchObject({ id: "m1", status: "open" });
		await expect(api.close_meeting("m1")).resolves.toBe("processing");
		await expect(api.delete_meeting("m1")).resolves.toBe("deleting");
	});

	test("a malformed mutation response is refused", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json_response(200, {})),
		);
		const api = create_council_api(make_client(["plu_first"]));

		await expect(api.open_meeting("m1")).rejects.toThrow("Unexpected response from the Council service");
		await expect(api.close_meeting("m1")).rejects.toThrow("Unexpected response from the Council service");
		await expect(api.delete_meeting("m1")).rejects.toThrow("Unexpected response from the Council service");
	});

	test("open refuses the bare status body that close and delete answer with", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json_response(200, { status: "open" })),
		);

		// Open is the only mutation that answers a whole meeting. A caller or a test double that
		// copies close's `{status}` body must fail here instead of leaving the page with no meeting.
		await expect(create_council_api(make_client(["plu_first"])).open_meeting("m1")).rejects.toThrow(
			"Unexpected response from the Council service (open)",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json_response(200, { meeting: { id: "m1", title: "Standup", status: "open", artifacts: [] } })),
		);
		await expect(create_council_api(make_client(["plu_first"])).open_meeting("m1")).resolves.toMatchObject({
			id: "m1",
			status: "open",
		});
	});

	test("an unknown artifact kind drops its own row and keeps the meeting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "ready",
							artifacts: [
								{ kind: "track_audio", name: "standup.webm", fileNodeId: "node1" },
								{ kind: "chapter_markers", name: "chapters.json" },
								{ kind: "transcript_markdown", name: "standup.md" },
							],
						},
					],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		// A fifth artifact kind added service-side must cost that one badge, not the whole dashboard.
		await expect(api.list_meetings()).resolves.toMatchObject([
			{
				title: "Standup",
				artifacts: [
					{ kind: "track_audio", name: "standup.webm" },
					{ kind: "transcript_markdown", name: "standup.md" },
				],
			},
		]);
	});

	test("an artifact row with no name is still refused", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "ready",
							artifacts: [{ kind: "summary_markdown", fileNodeId: "node1" }],
						},
					],
				}),
			),
		);

		// `artifacts_view` in the service always sends `name`, so a row without one is a broken
		// response, not a newer one.
		await expect(create_council_api(make_client(["plu_first"])).list_meetings()).rejects.toThrow(
			"Unexpected response from the Council service",
		);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "ready",
							artifacts: [{ kind: "transcript_markdown", path: "/Meetings/standup.md" }],
						},
					],
				}),
			),
		);

		// `path` is not a field the service has ever sent. Reading it as a name would let a broken
		// response through and show the member a file name nobody wrote.
		await expect(create_council_api(make_client(["plu_first"])).list_meetings()).rejects.toThrow(
			"Unexpected response from the Council service",
		);
	});

	test("list keeps a string failureReason on a failed meeting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "failed",
							failureReason: "Provider session ended without a recording",
							artifacts: [],
						},
					],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const [listed] = await api.list_meetings();
		expect(listed?.failureReason).toBe("Provider session ended without a recording");
		expect(listed?.recordingWarning).toBeNull();
	});

	test("list keeps a string recordingWarning on a ready meeting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meetings: [
						{
							id: "m1",
							title: "Standup",
							status: "ready",
							recordingWarning:
								"Council could not store the video recording. The file was larger than the workspace can accept. Audio, transcript, and summary were still saved.",
							artifacts: [{ kind: "track_audio", name: "recording-audio.m4a" }],
						},
					],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const [listed] = await api.list_meetings();
		expect(listed?.recordingWarning).toBe(
			"Council could not store the video recording. The file was larger than the workspace can accept. Audio, transcript, and summary were still saved.",
		);
	});
});
