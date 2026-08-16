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
			return bearer === "Bearer plu_fresh" ? json_response(200, { meetings: [] }) : json_response(401, { message: "Unauthenticated" });
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
					meeting: { id: "m1", title: "Standup", status: "created" },
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
			deadlineAt: null,
			maxParticipants: null,
			failureReason: null,
		});
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

	test("get tolerates missing artifacts and keeps named ones", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meeting: { id: "m1", title: "Standup", status: "ready" },
					artifacts: [{ name: "standup.mp4", fileNodeId: "node1" }, { path: "/Meetings/standup.md" }, 42],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const details = await api.get_meeting("m1");
		expect(details.meeting.failureReason).toBeNull();
		expect(details.artifacts).toEqual([
			{ name: "standup.mp4", fileNodeId: "node1" },
			{ name: "/Meetings/standup.md", fileNodeId: null },
		]);
	});

	test("get keeps a string failureReason on a failed meeting", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				json_response(200, {
					meeting: {
						id: "m1",
						title: "Standup",
						status: "failed",
						failureReason: "Provider session ended without a recording",
					},
					artifacts: [],
				}),
			),
		);
		const api = create_council_api(make_client(["plu_first"]));

		const details = await api.get_meeting("m1");
		expect(details.meeting.failureReason).toBe("Provider session ended without a recording");
	});
});
