import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
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
	return {
		id,
		title,
		status,
		createdAt: 1_700_000_000_000,
		openedAt: null,
		closedAt: null,
		deadlineAt: null,
		participantCount: 0,
		maxParticipants: 25,
		destinationPath: `/meetings/${id}`,
		failureReason: null,
		artifacts: [],
	};
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
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
	expect([...document.querySelectorAll(".meeting-group > h3")].map((heading) => heading.textContent)).toEqual([
		"Active",
		"Recent",
	]);
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
	expect(screen.getByRole("button", { name: "Close meeting" })).toBeTruthy();
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
			expect(document.querySelector("[data-announcement-sequence]")?.getAttribute("aria-hidden")).toBe("true");
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
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	expect(await screen.findByRole("heading", { level: 4, name: "Other tab meeting" }, { timeout: 10000 })).toBeTruthy();
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

	expect(await screen.findByRole("heading", { level: 4, name: "Queued meeting" })).toBeTruthy();
	await waitFor(() => expect(listAttempts).toBe(2));
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

test("a failed poll keeps stale cards, then a later success reconciles and clears the error", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			if (attempts === 1) {
				return { body: { meetings: [meeting("m1", "ready", "First meeting")] } };
			}
			if (attempts === 2) {
				return { status: 503, body: { message: "Refresh unavailable" } };
			}
			return { body: { meetings: [meeting("m2", "ready", "Reconciled meeting")] } };
		},
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("First meeting")).toBeTruthy();
	const refreshAlert = await screen.findByRole("alert", {}, { timeout: 7000 });
	expect(refreshAlert.textContent).toContain("Could not refresh: Refresh unavailable");
	expect(screen.getByText("First meeting")).toBeTruthy();

	expect(await screen.findByText("Reconciled meeting", {}, { timeout: 7000 })).toBeTruthy();
	expect(screen.queryByText("First meeting")).toBeNull();
	expect(screen.queryByRole("alert")).toBeNull();
}, 15000);

test("a successful close updates the card even when its refresh fails", async () => {
	let listAttempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			listAttempts += 1;
			return listAttempts === 1
				? { body: { meetings: [meeting("m1", "open", "Weekly sync")] } }
				: { status: 503, body: { message: "Refresh unavailable" } };
		},
		"/api/meetings/close": () => ({ body: { status: "processing" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Close meeting" }));

	expect(await screen.findByText("Processing")).toBeTruthy();
	expect((await screen.findByRole("alert")).textContent).toContain("Could not refresh: Refresh unavailable");
	expect(screen.queryByRole("button", { name: "Close meeting" })).toBeNull();
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
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);

	expect(await screen.findByDisplayValue("code-shown-once")).toBeTruthy();
	expect(screen.getByDisplayValue("https://council.example.com/room?m=m9")).toBeTruthy();
	expect(screen.getByText(/cannot show it again/)).toBeTruthy();
	expect(
		calls.some((call) => call.path === "/api/meetings/create" && JSON.stringify(call.body) === '{"title":"Planning"}'),
	).toBe(true);
});

test("the one-time invite follows created to open before offering the host link", async () => {
	let opened = false;
	const calls = stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m9", opened ? "open" : "created", "Planning")] },
		}),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "created", "Planning"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
		"/api/meetings/open": () => {
			opened = true;
			return { body: { meeting: meeting("m9", "open", "Planning") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Planning");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;
	fireEvent.click(within(invitePanel).getByRole("button", { name: "Open meeting" }));

	await waitFor(() => {
		expect(calls.some((call) => call.path === "/api/meetings/open")).toBe(true);
	});
	expect(await screen.findByRole("button", { name: "Get host room link" })).toBeTruthy();
	expect(screen.queryByDisplayValue("code-shown-once")).toBeNull();
	expect(document.activeElement).toBe(screen.getByRole("heading", { level: 4, name: "Planning" }));
});

test("dismissing the one-time invite returns focus to New meeting", async () => {
	stub_council({
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
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const dismiss = await screen.findByRole("button", { name: "Done, I saved the invite" });
	fireEvent.click(dismiss);

	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "New meeting" }));
	});
});

test("create uses native form submission and required-field validity", async () => {
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
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	expect(screen.getByRole("button", { name: "Create meeting" }).getAttribute("type")).toBe("submit");
	expect(screen.getByLabelText("Meeting title").hasAttribute("required")).toBe(true);

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
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
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	await screen.findByRole("button", { name: "Creating…" });
	fireEvent.submit(document.querySelector("form.create-form")!);

	release();
	expect(await screen.findByDisplayValue("code-shown-once")).toBeTruthy();
	expect(calls.filter((call) => call.path === "/api/meetings/create")).toHaveLength(1);
});

test("an empty title never reaches the service", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.submit(document.querySelector("form.create-form")!);

	const titleInput = screen.getByLabelText("Meeting title") as HTMLInputElement;
	expect(await screen.findByText("Enter a meeting title.")).toBeTruthy();
	expect(titleInput.validity.valid).toBe(false);
	expect(document.activeElement).toBe(titleInput);
	expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(false);
});

test("a create API error is announced and receives focus", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({ status: 503, body: { message: "Meeting service unavailable" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Meeting service unavailable");
	await waitFor(() => {
		expect(document.activeElement).toBe(alert);
	});
});

test("delete fires only after the inline confirmation", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "closed")] } }),
		"/api/meetings/delete": () => ({ body: { status: "deleting" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);
	expect(screen.getByText(/moves to the Files archive/)).toBeTruthy();

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
			return { body: { status: "deleting" } };
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

test("delete confirmation cannot race another meeting action", async () => {
	let releaseClose!: () => void;
	const closeGate = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "open")] } }),
		"/api/meetings/close": async () => {
			await closeGate;
			return { body: { status: "processing" } };
		},
		"/api/meetings/delete": () => ({ body: { status: "deleting" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete" }));
	fireEvent.click(screen.getByRole("button", { name: "Close meeting" }));
	const confirm = screen.getByRole("button", { name: "Confirm delete" });
	expect(confirm.hasAttribute("disabled")).toBe(true);
	fireEvent.click(confirm);
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);

	releaseClose();
	await waitFor(() => {
		expect(calls.filter((call) => call.path === "/api/meetings/close")).toHaveLength(1);
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
			return { body: { status: "deleting" } };
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

	fireEvent.click(screen.getByRole("button", { name: "Get host room link" }));

	expect(await screen.findByDisplayValue("https://council.example.com/room#ticket=abc")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Copy host room link" })).toBeTruthy();
	expect(screen.getByText(/single-use/)).toBeTruthy();
});

test("a polled close removes a stale host room link", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return {
				body: { meetings: [meeting("m1", attempts === 1 ? "open" : "processing")] },
			};
		},
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Get host room link" }));
	expect(await screen.findByDisplayValue("https://council.example.com/room#ticket=abc")).toBeTruthy();

	expect(await screen.findByText("Processing", {}, { timeout: 7000 })).toBeTruthy();
	expect(screen.queryByDisplayValue("https://council.example.com/room#ticket=abc")).toBeNull();
}, 10000);

test("meeting cards show timestamps, participants, destination, and friendly artifact labels", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "ready"),
						openedAt: 1_700_000_100_000,
						closedAt: 1_700_000_200_000,
						participantCount: 3,
						artifacts: [
							{ kind: "track_audio", name: "speaker-a.webm", fileNodeId: "raw-node-id" },
							{ kind: "track_audio", name: "speaker-b.webm", fileNodeId: "raw-node-id-2" },
							{ kind: "transcript_markdown", name: "transcript.md" },
							{ kind: "summary_markdown", name: "summary.md" },
							{ kind: "provider_transcript", name: "provider-transcript.json" },
						],
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);
	expect(await screen.findByText("Recording")).toBeTruthy();
	expect(screen.getAllByText("Recording")).toHaveLength(1);
	expect(screen.getByText("Transcript")).toBeTruthy();
	expect(screen.getByText("Summary")).toBeTruthy();
	expect(screen.getByText("Provider transcript")).toBeTruthy();
	expect(screen.getByText("3")).toBeTruthy();
	expect(screen.getByText("/meetings/m1")).toBeTruthy();
	expect(screen.queryByText("raw-node-id")).toBeNull();
	expect(screen.queryByText("raw-node-id-2")).toBeNull();
});

test("processing keeps delete disabled until the service allows it", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "processing")] } }),
	});
	render(<App client={make_client()} />);

	const deleteButton = await screen.findByRole("button", { name: "Delete after processing" });
	expect(deleteButton.hasAttribute("disabled")).toBe(true);
	expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("a failed meeting shows the failure reason on the row", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "failed"),
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
						...meeting("m1", "delete_failed"),
						failureReason: "This item is read-only.",
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("This item is read-only.")).toBeTruthy();
});
