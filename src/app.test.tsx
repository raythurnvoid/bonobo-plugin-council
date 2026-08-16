import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app";
import { COUNCIL_SERVICE_ORIGIN } from "./council-api";

function make_client(): BonoboUiFrontendClient {
	return {
		getToken: async () => "plu_test",
		refreshToken: async () => "plu_test",
	} as unknown as BonoboUiFrontendClient;
}

type RouteHandler = (body: unknown) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/**
 * Stub global fetch with per-path handlers, so each test declares only the Council routes it
 * exercises. Unhandled paths fail loudly instead of resolving to a fake success.
 */
function stub_council(routes: Record<string, RouteHandler>) {
	const calls: { path: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			const path = url.replace(COUNCIL_SERVICE_ORIGIN, "");
			const body = JSON.parse(init.body as string) as unknown;
			calls.push({ path, body });
			const handler = routes[path];
			if (!handler) {
				return new Response(JSON.stringify({ message: `Unhandled test route ${path}` }), { status: 500 });
			}
			const result = await handler(body);
			return new Response(JSON.stringify(result.body), { status: result.status ?? 200 });
		}),
	);
	return calls;
}

function meeting(id: string, status: string, title = `Meeting ${id}`) {
	return { id, title, status };
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test("lists meetings with their status", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "open", "Weekly sync"), meeting("m2", "ready", "Retro")] },
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("Weekly sync")).toBeTruthy();
	expect(await screen.findByText("Retro")).toBeTruthy();
	expect(screen.getByText("Open")).toBeTruthy();
	expect(screen.getByText("Ready")).toBeTruthy();
});

test("repair and delete states show human labels, never raw machine words", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					meeting("m1", "create_unknown"),
					meeting("m2", "recording_start_unknown"),
					meeting("m3", "deleting"),
					meeting("m4", "delete_failed"),
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("Create incomplete")).toBeTruthy();
	expect(screen.getByText("Recording unknown")).toBeTruthy();
	expect(screen.getByText("Deleting")).toBeTruthy();
	expect(screen.getByText("Delete failed")).toBeTruthy();
	expect(screen.queryByText("create_unknown")).toBeNull();
});

test("a processing meeting refreshes by itself until it settles", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return attempts === 1
				? { body: { meetings: [meeting("m1", "processing")] } }
				: { body: { meetings: [meeting("m1", "ready")] } };
		},
	});
	render(<App client={make_client()} />);
	expect(await screen.findByText("Processing")).toBeTruthy();

	// No reload and no click: the page polls transitional meetings on its own.
	expect(await screen.findByText("Ready", {}, { timeout: 10000 })).toBeTruthy();
}, 15000);

test("a status change is announced to screen readers", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return attempts === 1
				? { body: { meetings: [meeting("m1", "processing", "Weekly sync")] } }
				: { body: { meetings: [meeting("m1", "ready", "Weekly sync")] } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Processing");

	// The new label alone is silent: a screen reader reads a status change only from a live
	// region, so the assertion is on the region, not on the row text.
	await waitFor(
		() => {
			expect(screen.getByRole("status").textContent).toContain("Meeting Weekly sync is now Ready");
		},
		{ timeout: 10000 },
	);
}, 15000);

test("a meeting created elsewhere appears and is announced after the list settles", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return attempts === 1
				? { body: { meetings: [] } }
				: { body: { meetings: [meeting("m2", "created", "Other tab meeting")] } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one above.");

	expect(await screen.findByRole("heading", { level: 3, name: "Other tab meeting" }, { timeout: 10000 })).toBeTruthy();
	await waitFor(
		() => {
			expect(screen.getByRole("status").textContent).toContain("Meeting Other tab meeting was added");
		},
		{ timeout: 10000 },
	);
}, 15000);

test("an action refresh queued behind an in-flight list refresh is not lost", async () => {
	let releaseFirstList!: () => void;
	const firstListGate = new Promise<void>((resolve) => {
		releaseFirstList = resolve;
	});
	let listAttempts = 0;
	stub_council({
		"/api/meetings/list": async () => {
			listAttempts += 1;
			if (listAttempts === 1) {
				await firstListGate;
				return { body: { meetings: [] } };
			}
			return { body: { meetings: [meeting("m9", "created", "Queued meeting")] } };
		},
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "created", "Queued meeting"),
				joinCode: "queued-code",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
	});
	render(<App client={make_client()} />);

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Queued meeting" } });
	fireEvent.click(screen.getByRole("button", { name: "Create meeting" }));
	await screen.findByDisplayValue("queued-code");
	releaseFirstList();

	expect(await screen.findByRole("heading", { level: 3, name: "Queued meeting" })).toBeTruthy();
	expect(listAttempts).toBe(2);
});

test("a failed list shows an alert whose Retry reloads", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return attempts === 1
				? { status: 500, body: { message: "Council is unavailable" } }
				: { body: { meetings: [meeting("m1", "created", "Recovered")] } };
		},
	});
	render(<App client={make_client()} />);

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Council is unavailable");
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByText("Recovered")).toBeTruthy();
});

test("creating a meeting shows the one-time join code with the cannot-retrieve warning", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "created", "Planning"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one above.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);

	expect(await screen.findByDisplayValue("code-shown-once")).toBeTruthy();
	expect(screen.getByDisplayValue("https://council.example.com/room?m=m9")).toBeTruthy();
	expect(screen.getByText(/shown only this once and cannot be retrieved again/)).toBeTruthy();
	expect(
		calls.some((call) => call.path === "/api/meetings/create" && JSON.stringify(call.body) === '{"title":"Planning"}'),
	).toBe(true);
});

test("create works without native form submission (sandbox has no allow-forms)", async () => {
	// The host iframe sandbox blocks native form submission, so a submit-type button and implicit
	// Enter submission never fire in production. The button must be type="button" with a click
	// handler, and Enter must go through the page's own key handler.
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "created", "Planning"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one above.");

	expect(screen.getByRole("button", { name: "Create meeting" }).getAttribute("type")).toBe("button");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.keyDown(screen.getByLabelText("Meeting title"), { key: "Enter" });
	await waitFor(() => {
		expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(true);
	});
});

test("a second Enter while create is pending does not fire a second create", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": async () => {
			await gate;
			return {
				body: {
					meeting: meeting("m9", "created", "Planning"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one above.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.keyDown(screen.getByLabelText("Meeting title"), { key: "Enter" });
	await screen.findByRole("button", { name: "Creating…" });
	fireEvent.keyDown(screen.getByLabelText("Meeting title"), { key: "Enter" });

	release();
	expect(await screen.findByDisplayValue("code-shown-once")).toBeTruthy();
	expect(calls.filter((call) => call.path === "/api/meetings/create")).toHaveLength(1);
});

test("an empty title never reaches the service", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one above.");

	fireEvent.submit(document.querySelector("form.create-form")!);

	expect(await screen.findByText("Enter a meeting title.")).toBeTruthy();
	expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(false);
});

test("delete fires only after the inline confirmation", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "closed")] } }),
		"/api/meetings/delete": () => ({ body: {} }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);
	expect(screen.getByText(/move to the archive/)).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
	await waitFor(() => {
		expect(
			calls.some((call) => call.path === "/api/meetings/delete" && JSON.stringify(call.body) === '{"meetingId":"m1"}'),
		).toBe(true);
	});
});

test("a deleted meeting is announced after its row disappears", async () => {
	let deleted = false;
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: deleted ? [] : [meeting("m1", "closed", "Weekly sync")] },
		}),
		"/api/meetings/delete": () => {
			deleted = true;
			return { body: {} };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

	// A row taken out of the page announces nothing on its way out, so the page says it instead.
	await waitFor(() => {
		expect(screen.getByRole("status").textContent).toContain("Meeting Weekly sync was deleted");
	});
});

test("opening the delete confirmation moves focus to Confirm delete", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "closed")] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));

	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Confirm delete" }));
	});
});

test("cancelling the delete confirmation returns focus to Delete", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "closed")] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	const deleteButton = screen.getByRole("button", { name: "Delete" });
	fireEvent.click(deleteButton);
	await screen.findByRole("button", { name: "Confirm delete" });

	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

	expect(document.activeElement).toBe(deleteButton);
});

test("a confirmed delete keeps focus stable, then moves it to the Meetings heading", async () => {
	let releaseDelete!: () => void;
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve;
	});
	let deleted = false;
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: deleted ? [] : [meeting("m1", "closed")] } }),
		"/api/meetings/delete": async () => {
			await deleteGate;
			deleted = true;
			return { body: {} };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	const confirm = await screen.findByRole("button", { name: "Confirm delete" });
	fireEvent.click(confirm);
	expect(document.activeElement).toBe(confirm);
	expect(screen.getByRole("button", { name: "Deleting…" })).toBe(confirm);
	expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);

	releaseDelete();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Meetings" }));
	});
});

test("an open meeting offers the single-use host room link as a copyable value", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "open")] } }),
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Get room link" }));

	expect(await screen.findByDisplayValue("https://council.example.com/room#ticket=abc")).toBeTruthy();
	expect(screen.getByText(/single-use/)).toBeTruthy();
});

test("details of a ready meeting list the produced files", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "ready")] } }),
		"/api/meetings/get": () => ({
			body: {
				meeting: meeting("m1", "ready"),
				artifacts: [{ name: "recording.mp4", fileNodeId: "node1" }, { name: "transcript.md" }],
			},
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Details" }));

	expect(await screen.findByText("recording.mp4")).toBeTruthy();
	expect(screen.getByText("transcript.md")).toBeTruthy();
});

test("details refetch after hide so later artifacts appear", async () => {
	let getCount = 0;
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "processing")] } }),
		"/api/meetings/get": () => {
			getCount += 1;
			return {
				body: {
					meeting: meeting("m1", getCount === 1 ? "processing" : "ready"),
					artifacts: getCount === 1 ? [] : [{ name: "recording.mp4" }],
				},
			};
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Details" }));
	expect(await screen.findByText("Recording and transcript files appear here once the meeting is processed.")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
	fireEvent.click(screen.getByRole("button", { name: "Details" }));

	expect(await screen.findByText("recording.mp4")).toBeTruthy();
});

test("details hide the provider transcript dump", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "ready")] } }),
		"/api/meetings/get": () => ({
			body: {
				meeting: meeting("m1", "ready"),
				artifacts: [{ name: "transcript.md" }, { name: "provider-transcript.json" }],
			},
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Details" }));

	expect(await screen.findByText("transcript.md")).toBeTruthy();
	expect(screen.queryByText("provider-transcript.json")).toBeNull();
});

test("a failed meeting shows the failure reason on the row", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						id: "m1",
						title: "Meeting m1",
						status: "failed",
						failureReason: "Provider session ended without a recording",
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("Provider session ended without a recording")).toBeTruthy();
});

test("a delete_failed meeting shows the failure reason on the row", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						id: "m1",
						title: "Meeting m1",
						status: "delete_failed",
						failureReason: "This item is read-only.",
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("This item is read-only.")).toBeTruthy();
});
