import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app";
import { COUNCIL_SERVICE_ORIGIN } from "./council-api";
import { meeting } from "./meeting-fixture";

function make_client(): BonoboClient {
	return {
		getToken: async () => "plu_test",
		refreshToken: async () => "plu_test",
	} as unknown as BonoboClient;
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

/**
 * The page-level live region. Every card that can still admit guests carries a copy row, and a copy
 * row has its own `role="status"` node, so a bare `getByRole("status")` matches several elements as
 * soon as such a card is on screen.
 */
function announcer() {
	return document.querySelector(".council-announcer")!;
}

/**
 * The selectors of the scripted-focus outline rule in `council.css`, with `:focus` removed.
 *
 * A script moves focus in several places on this page, and a browser draws no ring of its own on a
 * `tabindex="-1"` element. So the member sees where focus went only if `council.css` lists that
 * element in its focus-ring rule. Read the rule's own selectors out of the stylesheet instead of
 * repeating them here, so dropping an element from the list fails the test that checks it. Reading
 * the outline back off the element would prove nothing: this environment never loads the
 * stylesheet, and happy-dom reports the same fallback for a listed and an unlisted element alike.
 *
 * Read the file off disk. `import "./council.css?raw"` returns an empty string here, because
 * vitest stubs out every `.css` import, and `import.meta.url` is not a `file:` URL under
 * happy-dom. `process.cwd()` is the package root, which is also the vitest root.
 *
 * Drop `:focus` before matching. The element is already the focused one, and happy-dom does not
 * resolve that pseudo-class inside `matches`.
 */
function focus_ring_selectors() {
	const css = readFileSync(join(process.cwd(), "src", "council.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const focusRule = /([^{}]+)\{[^{}]*outline:\s*2px solid #8fb4ff[^{}]*\}/.exec(css);
	expect(focusRule, "council.css no longer has the scripted-focus outline rule").not.toBeNull();
	return focusRule![1].replace(/:focus\b/g, "").trim();
}

/**
 * The selectors of every rule in `council.css` that paints a button as pressable, with the
 * pseudo-classes this environment cannot resolve removed.
 *
 * A button that is waiting for an answer on this page stays enabled, so that it keeps the focus of
 * the member who pressed it. That leaves the browser still offering it the hover fill and the press
 * dip, which are the two things that say a press will do something. It has to lose both while it
 * waits, or a member who presses it again sees the button answer every press and act on none of
 * them.
 *
 * Pick the rules by what they declare, not only by the pseudo-class in their selector. The
 * reduced-motion block also names `:active`, and it only cancels the dip, so it paints nothing
 * pressable.
 *
 * Read the rules out of the stylesheet instead of repeating their selectors here, so a guard
 * dropped from any one of them fails the test that checks it. Read the file off disk and drop the
 * pseudo-classes before matching, for the reasons `focus_ring_selectors` gives.
 */
function pressable_button_selectors() {
	const css = readFileSync(join(process.cwd(), "src", "council.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const selectors: string[] = [];
	for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const repaintsOnHover = selector.includes(":hover") && /\bbackground:/.test(body);
		const movesOnPress = selector.includes(":active") && /\btransform:\s*translate/.test(body);
		if (selector.includes(".button") && (repaintsOnHover || movesOnPress)) {
			selectors.push(selector.replace(/:hover\b|:active\b/g, "").trim());
		}
	}
	expect(selectors.length, "council.css no longer paints any button as pressable").toBeGreaterThan(0);
	return selectors;
}

/**
 * The selectors of every rule in `council.css` that dims a button a member cannot press right now.
 *
 * A disabled button and a busy button are dimmed by different means, on purpose, so this returns a
 * list rather than one selector. A disabled button is an inactive control, so WCAG 1.4.3 asks
 * nothing of its label and `opacity` may fade the whole box. A busy button is not inactive: it
 * stays enabled and swaps its label to `Creating…` or `Deleting…`, which is the sentence that tells
 * the member what the page is doing. `opacity` fades a label and a fill by the same factor, and on
 * a card here that took those two labels to 3.14:1 and 3.74:1, under the 4.5:1 a 14px label needs.
 * So a busy rule dims its own fill and leaves `color` alone, and this helper refuses any `opacity`
 * on a busy rule, because that is the exact regression.
 *
 * Skip the hover and press rules. They name `:disabled` and `[aria-busy="true"]` too, inside their
 * `:not(...)` guards, and this environment cannot resolve `:hover`, so matching against one of them
 * would answer for the wrong reason. Read the file off disk for the reasons `focus_ring_selectors`
 * gives.
 */
function dimmed_button_selectors() {
	const css = readFileSync(join(process.cwd(), "src", "council.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const selectors: string[] = [];
	for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const marksUnpressable =
			!selector.includes(":hover") &&
			!selector.includes(":active") &&
			(selector.includes(":disabled") || selector.includes('[aria-busy="true"]'));
		if (!marksUnpressable) {
			continue;
		}

		if (selector.includes('[aria-busy="true"]')) {
			expect(body, "a busy button rule fades its own label with opacity").not.toMatch(/\bopacity\s*:/);
		}

		if (/\bopacity\s*:|\bbackground\s*:/.test(body)) {
			selectors.push(selector.trim());
		}
	}
	expect(selectors.length, "council.css no longer dims a button that cannot be pressed").toBeGreaterThan(0);
	return selectors;
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	// happy-dom ships a real `navigator.clipboard`, as a getter on the Navigator prototype. It ships no
	// `document.execCommand` at all. The clipboard test needs a clipboard that rejects, so it defines
	// both as own properties on the instance, which shadows the real getter. Delete them again: that
	// uncovers happy-dom's own clipboard and leaves `execCommand` undefined, and without the delete the
	// next test inherits a clipboard that refuses every call.
	Reflect.deleteProperty(navigator, "clipboard");
	Reflect.deleteProperty(document, "execCommand");
});

test("lists meetings with their status", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", "open"), meeting("m2", "Retro", "ready")] },
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
					meeting("m1", "Meeting m1", "create_unknown"),
					meeting("m2", "Meeting m2", "recording_start_unknown"),
					meeting("m3", "Meeting m3", "deleting"),
					meeting("m4", "Meeting m4", "delete_failed"),
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("Create incomplete")).toBeTruthy();
	expect(screen.getByText("Recording failed")).toBeTruthy();
	expect(screen.getByText("Deleting")).toBeTruthy();
	expect(screen.getByText("Delete failed")).toBeTruthy();
	expect(screen.queryByText("create_unknown")).toBeNull();
	expect(screen.getByRole("button", { name: "Close meeting Meeting m2" })).toBeTruthy();
});

test("a create that lost the provider answer explains itself instead of showing a bare red chip", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Board sync", "create_unknown")] } }),
	});
	render(<App client={make_client()} />);
	const row = (await screen.findByRole("heading", { level: 4, name: "Board sync" })).closest("li")!;

	// The service moves a meeting here when the provider answer to create was lost, and it writes no
	// `failureReason` for it. Without its own sentence the card is a red chip and a Delete button, and
	// the member cannot tell whether waiting helps. Its sibling lost-answer status gets a paragraph.
	expect(within(row).getByText("Create incomplete")).toBeTruthy();
	expect(within(row).getByText(/did not get an answer when it created the room/)).toBeTruthy();
	expect(within(row).getByText(/Delete it and create a new meeting/)).toBeTruthy();
});

test("the page offers no in-page jump link, because the create form is already the entry point", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	// The header used to carry a primary-styled "New meeting" link to the compose column. That column
	// is sticky, so on a wide screen it is already on screen: measured at 1440x900 with the form fully
	// in the viewport, the press scrolled the page 224px, took the h1 and the tagline off the top, and
	// left focus on <body>, because a fragment target that is not focusable takes no focus. Below
	// 820px the column is the first thing under the header, so the link led to its own neighbour.
	expect(document.querySelectorAll('a[href^="#"]')).toHaveLength(0);
	expect(screen.getByRole("heading", { level: 2, name: "New meeting" })).toBeTruthy();
	expect(screen.getByLabelText("Meeting title")).toBeTruthy();
});

test("the create card promises read-only files, never a read-only folder", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	// The service upload locks only the file it creates: it points that file's own read-only scope at
	// itself, and it cannot lock the folder around it. The card used to promise a "read-only meeting
	// folder", so a member could drop their own notes in there and believe the folder was protecting
	// them. Pin the sentence here, because the guarantee lives in the upload code and this copy is the
	// only place a member ever reads about it.
	expect(
		screen.getByText(
			"When recording is started, Council saves its tracks, transcript, summary, and provider transcript as read-only files in the meeting folder.",
		),
	).toBeTruthy();
	expect(screen.queryByText(/read-only meeting folder/)).toBeNull();
});

test("a processing meeting refreshes by itself until it settles", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return attempts === 1
				? { body: { meetings: [meeting("m1", "Meeting m1", "processing")] } }
				: { body: { meetings: [meeting("m1", "Meeting m1", "ready")] } };
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
				? { body: { meetings: [meeting("m1", "Weekly sync", "processing")] } }
				: { body: { meetings: [meeting("m1", "Weekly sync", "ready")] } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Processing");

	// The new label alone is silent: a screen reader reads a status change only from a live
	// region, so the assertion is on the region, not on the row text.
	await waitFor(
		() => {
			expect(announcer().textContent).toContain("Meeting Weekly sync is now Ready");
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
				: { body: { meetings: [meeting("m2", "Other tab meeting", "created")] } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	expect(await screen.findByRole("heading", { level: 4, name: "Other tab meeting" }, { timeout: 10000 })).toBeTruthy();
	await waitFor(
		() => {
			expect(announcer().textContent).toContain("Meeting Other tab meeting was added");
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
			return { body: { meetings: [meeting("m9", "Queued meeting", "created")] } };
		},
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Queued meeting", "created"),
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
				: { body: { meetings: [meeting("m1", "Recovered", "created")] } };
		},
	});
	render(<App client={make_client()} />);

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Council is unavailable");
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByText("Recovered")).toBeTruthy();
});

test("the first-load Retry stays focusable while it runs, then success moves focus to Meetings", async () => {
	let attempts = 0;
	// Build the gate before the render, so `releaseRetry` is assigned no matter when the retry reaches
	// the stub. Assigning it inside the handler would leave it undefined if the release ran first.
	let releaseRetry = () => {};
	const retryGate = new Promise<void>((resolve) => {
		releaseRetry = resolve;
	});
	stub_council({
		"/api/meetings/list": async () => {
			attempts += 1;
			if (attempts === 1) {
				return { status: 500, body: { message: "Council is unavailable" } };
			}
			await retryGate;
			return { body: { meetings: [meeting("m1", "Recovered", "created")] } };
		},
	});
	render(<App client={make_client()} />);

	const retry = await screen.findByRole("button", { name: "Retry" });
	retry.focus();
	fireEvent.click(retry);

	// A real browser blurs a focused control the moment it turns disabled, and nothing puts that focus
	// back. happy-dom does not reproduce the blur, so assert the attribute that causes it here. The
	// browser run asserts the focus itself.
	expect(retry.hasAttribute("disabled")).toBe(false);
	expect(retry.getAttribute("aria-busy")).toBe("true");

	// The alert and the button the member pressed both unmount on success, so focus has to be sent
	// somewhere on purpose. Wait for it: the cards render one microtask before the refresh settles.
	releaseRetry();
	expect(await screen.findByText("Recovered")).toBeTruthy();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Meetings" }));
	});
});

test("the first-load Retry says the wait in words, because nothing else on that screen does", async () => {
	let attempts = 0;
	let releaseRetry = () => {};
	const retryGate = new Promise<void>((resolve) => {
		releaseRetry = resolve;
	});
	stub_council({
		"/api/meetings/list": async () => {
			attempts += 1;
			if (attempts === 1) {
				return { status: 500, body: { message: "Council is unavailable" } };
			}
			await retryGate;
			return { body: { meetings: [meeting("m1", "Recovered", "created")] } };
		},
	});
	render(<App client={make_client()} />);

	const retry = await screen.findByRole("button", { name: "Retry" });
	fireEvent.click(retry);

	// The first load failed, so there is no list for the "Refreshing…" line to stand beside and the
	// page never renders it. This button's own label is the only thing on screen that can tell the
	// member the press landed, for the whole round-trip. Without it a member who sees nothing change
	// presses again, and again.
	expect(document.querySelector(".refreshing-label")).toBeNull();
	expect(retry.textContent, "the busy first-load Retry still reads as an untaken press").toBe("Retrying…");

	releaseRetry();
	expect(await screen.findByText("Recovered")).toBeTruthy();
});

test("the refresh-error Retry stays focusable while it runs, then success moves focus to Meetings", async () => {
	let attempts = 0;
	let releaseRetry = () => {};
	const retryGate = new Promise<void>((resolve) => {
		releaseRetry = resolve;
	});
	stub_council({
		"/api/meetings/list": async () => {
			attempts += 1;
			if (attempts === 1) {
				return { body: { meetings: [meeting("m1", "Weekly sync", "open")] } };
			}
			if (attempts === 2) {
				return { status: 503, body: { message: "Refresh unavailable" } };
			}
			await retryGate;
			return { body: { meetings: [meeting("m1", "Weekly sync", "processing")] } };
		},
		"/api/meetings/close": () => ({ body: { status: "processing" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	// Close runs its own refresh, so the refresh error appears without waiting out a 5 second poll.
	fireEvent.click(screen.getByRole("button", { name: "Close meeting Weekly sync" }));
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Could not refresh: Refresh unavailable");

	const retry = within(alert).getByRole("button", { name: "Retry" });
	retry.focus();
	fireEvent.click(retry);
	expect(retry.hasAttribute("disabled")).toBe(false);
	expect(retry.getAttribute("aria-busy")).toBe("true");
	// This refresh is the member's own, so the status line does appear for it.
	await waitFor(() => {
		expect(document.querySelector(".refreshing-label")).not.toBeNull();
	});

	// This alert leaves the old cards on screen, but it still takes its own button away with it.
	releaseRetry();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Meetings" }));
	});
});

test("a refresh the member never asked for leaves focus where it was", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return { body: { meetings: [meeting("m1", "Weekly sync", attempts === 1 ? "open" : "processing")] } };
		},
		"/api/meetings/close": () => ({ body: { status: "processing" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	// Every 5 seconds, and after every action, the page runs the same `refresh` a Retry press runs.
	// Only the press may move focus. Here the member is typing a title while a close elsewhere starts
	// its own refresh, and that refresh must leave the caret in the field.
	const title = screen.getByLabelText("Meeting title");
	title.focus();
	fireEvent.click(screen.getByRole("button", { name: "Close meeting Weekly sync" }));

	expect(await screen.findByText("Processing")).toBeTruthy();
	// Wait for the refresh the close started to reach the stub and settle, so the focus effect has had
	// its chance to run before this reads `document.activeElement`.
	await waitFor(() => expect(attempts).toBeGreaterThan(1));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(document.activeElement).toBe(title);
});

test("the 5-second poll never shows the refreshing status line", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return { body: { meetings: [meeting("m1", "Weekly sync", "open")] } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	// The label lives exactly as long as one refresh, so reading the DOM before and after a poll would
	// miss it. Watch the whole window instead, the way it was found: a `role="status"` node inserted
	// and removed every 5 seconds, for as long as the tab stays open, with no control to stop it.
	const mounted: string[] = [];
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node instanceof HTMLElement && node.classList.contains("refreshing-label")) {
					mounted.push(node.textContent ?? "");
				}
			}
		}
	});
	observer.observe(document.body, { childList: true, subtree: true });
	const pollsBefore = attempts;
	await new Promise((resolve) => setTimeout(resolve, 6_500));
	observer.disconnect();

	// A window with no poll in it would make the assertion below unfailable.
	expect(attempts).toBeGreaterThan(pollsBefore);
	expect(mounted).toEqual([]);
}, 15000);

test("a failed poll keeps stale cards, then a later success reconciles and clears the error", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			if (attempts === 1) {
				return { body: { meetings: [meeting("m1", "First meeting", "ready")] } };
			}
			if (attempts === 2) {
				return { status: 503, body: { message: "Refresh unavailable" } };
			}
			return { body: { meetings: [meeting("m2", "Reconciled meeting", "ready")] } };
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
				? { body: { meetings: [meeting("m1", "Weekly sync", "open")] } }
				: { status: 503, body: { message: "Refresh unavailable" } };
		},
		"/api/meetings/close": () => ({ body: { status: "processing" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Close meeting Weekly sync" }));

	expect(await screen.findByText("Processing")).toBeTruthy();
	expect((await screen.findByRole("alert")).textContent).toContain("Could not refresh: Refresh unavailable");
	expect(screen.queryByRole("button", { name: "Close meeting Weekly sync" })).toBeNull();
});

test("creating a meeting shows the one-time join code with the cannot-retrieve warning", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
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
			body: { meetings: [meeting("m9", "Planning", opened ? "open" : "created")] },
		}),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
		"/api/meetings/open": () => {
			opened = true;
			return { body: { meeting: meeting("m9", "Planning", "open") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Planning");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;
	fireEvent.click(within(invitePanel).getByRole("button", { name: "Open meeting Planning" }));

	await waitFor(() => {
		expect(calls.some((call) => call.path === "/api/meetings/open")).toBe(true);
	});
	expect(await screen.findByRole("button", { name: "Get host room link Planning" })).toBeTruthy();

	// Opening leaves the invite panel up, so focus stays inside it on the line that says what
	// happened. The only button left dismisses the panel, and a held Enter there would throw the
	// join code away.
	expect(screen.getByDisplayValue("code-shown-once")).toBeTruthy();
	await waitFor(() => {
		expect(invitePanel.contains(document.activeElement)).toBe(true);
	});
	expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Done, I saved the invite" }));
});

test("opening the meeting keeps the one-time invite until the member dismisses it", async () => {
	let releaseOpen!: () => void;
	const openGate = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	let created = false;
	let opened = false;
	stub_council({
		// Answer the list the way the service does: the new meeting is in it from the moment it is
		// created. A stub that always answered `[]` would take the card away again, and with it the
		// status the invite panel reads.
		"/api/meetings/list": () => ({
			body: { meetings: created ? [meeting("m9", "Planning", opened ? "open" : "created")] : [] },
		}),
		"/api/meetings/create": () => {
			created = true;
			return {
				body: {
					meeting: meeting("m9", "Planning", "created"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
		"/api/meetings/open": async () => {
			await openGate;
			opened = true;
			return { body: { meeting: meeting("m9", "Planning", "open") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;
	const openButton = within(invitePanel).getByRole("button", { name: "Open meeting Planning" });
	fireEvent.click(openButton);

	// Hold the answer, then release it, so the assertions below run on a settled panel. The button
	// keeps its accessible name while it waits, so its own text is the barrier: it reads "Opening…"
	// while the answer is in the air and the button itself is gone once the meeting is open — and
	// also if the whole panel were torn down, so this barrier holds either way.
	await waitFor(() => {
		expect(openButton.textContent).toBe("Opening…");
	});
	releaseOpen();
	await waitFor(() => {
		expect(within(invitePanel).queryByRole("button", { name: "Open meeting Planning" })).toBeNull();
	});

	// The service never stores the plaintext join code, so this panel is its only copy. Opening the
	// meeting must not take it away: the host would have no invite left and no way to get one.
	expect(screen.getByDisplayValue("code-shown-once")).toBeTruthy();
	expect(screen.getByDisplayValue("https://council.example.com/room?m=m9")).toBeTruthy();
	expect(screen.getByText("The meeting is open. Guests can join it with the code above.")).toBeTruthy();

	fireEvent.click(screen.getByRole("button", { name: "Done, I saved the invite" }));

	expect(screen.queryByDisplayValue("code-shown-once")).toBeNull();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "New meeting" }));
	});
});

test("opening the meeting from its card takes the invite panel's second button away, not the panel", async () => {
	let created = false;
	let opened = false;
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: created ? [meeting("m9", "Planning", opened ? "open" : "created")] : [] },
		}),
		"/api/meetings/create": () => {
			created = true;
			return {
				body: {
					meeting: meeting("m9", "Planning", "created"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
		"/api/meetings/open": () => {
			opened = true;
			return { body: { meeting: meeting("m9", "Planning", "open") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;

	// The new meeting also gets a card, and the card offers the same Open action. Press that one.
	const row = (await screen.findByRole("heading", { level: 4, name: "Planning" })).closest("li")!;
	const rowOpenButton = within(row).getByRole("button", { name: "Open meeting Planning" });
	rowOpenButton.focus();
	fireEvent.click(rowOpenButton);

	// The service allows one open per meeting and answers the second with 409 "Meeting is not in a
	// state that can be opened". So the panel's copy of the button has to follow the meeting, not its
	// own memory of which button was pressed.
	await waitFor(() => {
		expect([...invitePanel.querySelectorAll("button")].map((button) => button.textContent)).not.toContain(
			"Open meeting",
		);
	});

	// Only the button. The service stores no plaintext join code, so this panel is its only copy, and
	// a member who has not written it down yet cannot invite anybody afterwards.
	expect(invitePanel.isConnected).toBe(true);
	expect(screen.getByDisplayValue("code-shown-once")).toBeTruthy();
	expect(screen.getByRole("button", { name: "Done, I saved the invite" })).toBeTruthy();
	const openedNotice = screen.getByText("The meeting is open. Guests can join it with the code above.");

	// The panel sends focus to that line when its own button is the one that disappears. This press
	// happened in the list, where the member is reading, so their focus must not be pulled over here.
	//
	// Name where the focus really went. `not.toBe(openedNotice)` on its own passes while the focus
	// sits on `document.body`, which is the failure this test is meant to catch, so it cannot fail
	// for the reason it gives.
	expect(document.activeElement).toBe(within(row).getByRole("heading", { level: 4, name: "Planning" }));
	expect(document.activeElement).not.toBe(openedNotice);
});

test("deleting the meeting never leaves the invite panel calling it open or offering to open it", async () => {
	let created = false;
	let deleting = false;
	let purged = false;
	stub_council({
		// The service's own delete sequence: the row moves to `deleting`, and only the purge behind it
		// takes the meeting out of the list.
		"/api/meetings/list": () => ({
			body: {
				meetings: !created || purged ? [] : [meeting("m9", "Planning", deleting ? "deleting" : "created")],
			},
		}),
		"/api/meetings/create": () => {
			created = true;
			return {
				body: {
					meeting: meeting("m9", "Planning", "created"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
		"/api/meetings/delete": () => {
			deleting = true;
			return { body: { status: "deleting" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;

	// The new meeting also gets a card, and the card offers Delete. Press that one.
	const row = (await screen.findByRole("heading", { level: 4, name: "Planning" })).closest("li")!;
	fireEvent.click(within(row).getByRole("button", { name: "Delete Planning" }));
	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

	// The card's chip is the delete's own status line, so once it reads Deleting the panel is reading
	// the same status from the same list. `deleting` is not open, and the panel is the member's only
	// reading of the meeting while it is up: it must not tell them guests can still join.
	await screen.findByText("Deleting");
	expect(within(invitePanel).queryByText("The meeting is open. Guests can join it with the code above.")).toBeNull();

	// The purge finishes and the meeting leaves the list. An Open button here would point the member at
	// a meeting the service has already destroyed, and pressing it only produces a service error.
	purged = true;
	await waitFor(
		() => {
			expect(screen.queryByRole("heading", { level: 4, name: "Planning" })).toBeNull();
		},
		{ timeout: 10000 },
	);
	expect(within(invitePanel).queryByRole("button", { name: "Open meeting Planning" })).toBeNull();

	// Still only the two status sentences move. The panel holds the only copy of the join code.
	expect(invitePanel.isConnected).toBe(true);
	expect(screen.getByDisplayValue("code-shown-once")).toBeTruthy();
}, 15000);

test("the invite panel stays usable while the open runs and refuses a second press", async () => {
	let releaseOpen!: () => void;
	const openGate = new Promise<void>((resolve) => {
		releaseOpen = resolve;
	});
	let created = false;
	let opened = false;
	const calls = stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: created ? [meeting("m9", "Planning", opened ? "open" : "created")] : [] },
		}),
		"/api/meetings/create": () => {
			created = true;
			return {
				body: {
					meeting: meeting("m9", "Planning", "created"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
		"/api/meetings/open": async () => {
			await openGate;
			opened = true;
			return { body: { meeting: meeting("m9", "Planning", "open") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const invitePanel = (await screen.findByDisplayValue("code-shown-once")).closest("section")!;
	const pending = within(invitePanel).getByRole("button", { name: "Open meeting Planning" });
	fireEvent.click(pending);

	// A real browser blurs a focused control the moment it becomes disabled, and nothing puts that
	// focus back. happy-dom does not reproduce the blur, so assert the attributes that cause it: for
	// the whole round-trip both controls must stay usable, or the member is stranded on the page body
	// holding the only copy of the join code.
	await waitFor(() => {
		expect(pending.textContent).toBe("Opening…");
	});
	const dismiss = screen.getByRole("button", { name: "Done, I saved the invite" });
	expect(pending.hasAttribute("disabled")).toBe(false);
	expect(pending.getAttribute("aria-busy")).toBe("true");
	expect(dismiss.hasAttribute("disabled")).toBe(false);

	// The button stays pressable, so the guard in `handle_open` is the only thing left to stop a
	// second open. Give the press a macrotask to reach the stub, or this could never fail.
	fireEvent.click(pending);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls.filter((call) => call.path === "/api/meetings/open")).toHaveLength(1);

	releaseOpen();
	expect(await screen.findByText("The meeting is open. Guests can join it with the code above.")).toBeTruthy();
});

test("dismissing the one-time invite returns focus to New meeting, and that landing is visible", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
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

	// A script moved that focus, so the member sees the landing only if council.css lists this
	// heading in its focus-ring rule. Dropping the heading from that list fails this assertion.
	expect((document.activeElement as HTMLElement).matches(focus_ring_selectors())).toBe(true);
});

test("create uses native form submission and required-field validity", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
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
					meeting: meeting("m9", "Planning", "created"),
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

test("the create button stays focusable while the create runs and refuses a second press", async () => {
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
					meeting: meeting("m9", "Planning", "created"),
					joinCode: "code-shown-once",
					guestUrl: "https://council.example.com/room?m=m9",
				},
			};
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.click(screen.getByRole("button", { name: "Create meeting" }));

	// A real browser blurs a focused control the moment it becomes disabled, and nothing puts that
	// focus back. happy-dom does not reproduce the blur, so assert the attribute that causes it.
	const pending = await screen.findByRole("button", { name: "Creating…" });
	expect(pending.hasAttribute("disabled")).toBe(false);
	expect(pending.getAttribute("aria-busy")).toBe("true");

	// The button stays pressable, so the guard in `handle_submit` is the only thing left to stop a
	// second create. Give the press a macrotask to reach the stub, or this could never fail.
	fireEvent.click(pending);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls.filter((call) => call.path === "/api/meetings/create")).toHaveLength(1);

	release();
	expect(await screen.findByDisplayValue("code-shown-once")).toBeTruthy();
});

test("an empty title never reaches the service", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	// Reach the form the way the browser does, with `requestSubmit`. Dispatching a bare `submit` event
	// runs no constraint validation at all, so `handle_submit` ran and refused the title itself — a
	// branch no browser ever reaches, because the browser refuses the invalid field first and never
	// fires `submit`. `requestSubmit` runs that same check: the field's `invalid` event fires, and no
	// `submit` event follows it.
	const form = document.querySelector("form.create-form") as HTMLFormElement;
	form.requestSubmit();

	const titleInput = screen.getByLabelText("Meeting title") as HTMLInputElement;
	// The refusal has to reach a screen reader, not only the eye. The `onInvalid` handler cancels the
	// browser's own bubble, and the help text below the field is only an `aria-describedby` target,
	// which is read when the member enters the field and not when its text changes. So assert the live
	// region, and assert the help text through the field's own `aria-describedby` pointer.
	expect((await screen.findByRole("alert")).textContent).toBe("Enter a meeting title.");
	expect(document.getElementById(titleInput.getAttribute("aria-describedby")!)!.textContent).toBe(
		"Enter a meeting title.",
	);
	expect(titleInput.getAttribute("aria-invalid")).toBe("true");
	expect(titleInput.validity.valid).toBe(false);
	expect(document.activeElement).toBe(titleInput);
	expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(false);
});

test("a title the service would refuse by byte count is refused in the field instead", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	// 70 Chinese characters are 70 UTF-16 units and 210 UTF-8 bytes. `maxLength` counts the units, so
	// a 180-unit cap called this title valid, the create went out, and the service answered "title is
	// longer than 200 bytes" — a unit the member cannot see or count.
	const titleInput = screen.getByLabelText("Meeting title") as HTMLInputElement;
	// Submit through `requestSubmit`, for the reason spelled out in the empty-title test above: a bare
	// `submit` event skips constraint validation, and the byte cap is enforced through the field's own
	// validity, so a bare event would test a branch no browser reaches.
	const form = document.querySelector("form.create-form") as HTMLFormElement;
	fireEvent.input(titleInput, { target: { value: "会".repeat(70) } });
	form.requestSubmit();

	// A create reaches the stub through two resolved awaits, so give the submit a macrotask first, or
	// this assertion could never fail.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(false);
	// A refusal the member never hears is the same as no refusal, so assert the live region, not only
	// the help text under the field.
	expect((await screen.findByRole("alert")).textContent).toBe("This title is too long. Shorten it and try again.");
	expect(document.getElementById(titleInput.getAttribute("aria-describedby")!)!.textContent).toBe(
		"This title is too long. Shorten it and try again.",
	);
	expect(titleInput.getAttribute("aria-invalid")).toBe("true");
	expect(titleInput.validity.valid).toBe(false);

	// Guard the boundary itself: 66 Chinese characters are 198 bytes, so 67 is 201 and one over, while
	// 66 plus two ASCII letters is exactly the 200 bytes the service allows.
	fireEvent.input(titleInput, { target: { value: "会".repeat(67) } });
	form.requestSubmit();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(false);

	fireEvent.input(titleInput, { target: { value: `${"会".repeat(66)}ab` } });
	// Fixing the title clears the refusal: the alert unmounts and the field stops reporting itself
	// invalid. Assert it here, while the form is still on screen — a successful create replaces the
	// whole form with the invite panel, so after that there is nothing left to read this off.
	await waitFor(() => {
		expect(screen.queryByRole("alert")).toBeNull();
	});
	expect(titleInput.getAttribute("aria-invalid")).toBe("false");

	form.requestSubmit();
	await waitFor(() => {
		expect(calls.some((call) => call.path === "/api/meetings/create")).toBe(true);
	});
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
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "closed")] } }),
		"/api/meetings/delete": () => ({ body: { status: "deleting" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);
	expect(
		screen.getByText(/^Delete Meeting m1\? Any files Council saved for it move to the Files archive/),
	).toBeTruthy();

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
			body: { meetings: deleted ? [] : [meeting("m1", "Weekly sync", "closed")] },
		}),
		"/api/meetings/delete": () => {
			deleted = true;
			return { body: { status: "deleting" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Delete Weekly sync" }));
	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

	// A row taken out of the page announces nothing on its way out, so the page says it instead.
	await waitFor(() => {
		expect(announcer().textContent).toContain("Meeting Weekly sync was deleted");
	});
});

test("opening the delete confirmation moves focus into it, never onto Confirm delete", async () => {
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "closed")] } }),
		"/api/meetings/delete": () => ({ body: { status: "deleting" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));

	// Focus must reach the confirmation, or a screen reader never hears the warning.
	const panel = document.querySelector(".meeting-confirm")!;
	await waitFor(() => {
		expect(panel.contains(document.activeElement)).toBe(true);
	});

	// But it must not land on Confirm delete. A <button> activates on Enter keydown and the keyboard
	// repeats keydown while the key is held, so one resting finger would open this confirmation and
	// then confirm it. happy-dom does not activate a button from a keydown, so activate whatever
	// holds focus directly: whatever it is, it must not delete the meeting.
	expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Confirm delete" }));
	fireEvent.click(document.activeElement!);

	// A press starts its request through two resolved awaits, so it reaches the stub within the same
	// macrotask. Wait for one before reading `calls`, or this assertion could never fail.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);
});

test("the delete warning the confirmation focuses is visible as the focused element", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "closed")] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));

	const warning = await screen.findByText(/^Delete Meeting m1\?/);
	await waitFor(() => {
		expect(document.activeElement).toBe(warning);
	});

	// The warning carries no class of its own, so council.css can only reach it through the panel
	// around it. From here the next Tab reaches Confirm delete, the only press on this page that
	// destroys a meeting, so a member who cannot see this landing approaches that button blind.
	expect((document.activeElement as HTMLElement).matches(focus_ring_selectors())).toBe(true);
});

test("delete confirmation cannot race another meeting action", async () => {
	let releaseClose!: () => void;
	const closeGate = new Promise<void>((resolve) => {
		releaseClose = resolve;
	});
	const calls = stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "open")] } }),
		"/api/meetings/close": async () => {
			await closeGate;
			return { body: { status: "processing" } };
		},
		"/api/meetings/delete": () => ({ body: { status: "deleting" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));
	fireEvent.click(screen.getByRole("button", { name: "Close meeting Meeting m1" }));

	// The row's single-action guard is what refuses the press, not a disabled attribute. A disabled
	// button would be blurred by the browser and strand a keyboard member outside the confirmation.
	const confirm = screen.getByRole("button", { name: "Confirm delete" });
	expect(confirm.hasAttribute("disabled")).toBe(false);
	fireEvent.click(confirm);
	expect(calls.some((call) => call.path === "/api/meetings/delete")).toBe(false);

	releaseClose();
	await waitFor(() => {
		expect(calls.filter((call) => call.path === "/api/meetings/close")).toHaveLength(1);
	});
});

test("cancelling the delete confirmation returns focus to Delete", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "closed")] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	const deleteButton = screen.getByRole("button", { name: "Delete Meeting m1" });
	fireEvent.click(deleteButton);
	await screen.findByRole("button", { name: "Confirm delete" });

	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

	expect(document.activeElement).toBe(deleteButton);
});

test("a pending delete leaves the confirmation usable, then moves focus to the Meetings heading", async () => {
	let releaseDelete!: () => void;
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve;
	});
	let deleted = false;
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: deleted ? [] : [meeting("m1", "Meeting m1", "closed")] } }),
		"/api/meetings/delete": async () => {
			await deleteGate;
			deleted = true;
			return { body: { status: "deleting" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));
	const panel = document.querySelector(".meeting-confirm")!;
	await waitFor(() => {
		expect(panel.contains(document.activeElement)).toBe(true);
	});
	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

	// happy-dom does not blur a focused element when it turns disabled, so "focus is still on the
	// confirm button" would pass here while a real browser drops focus to the body. Assert the shape
	// that cannot pass on a stale focus instead: no control in the confirmation is disabled, so no
	// browser takes focus out of it while the delete runs.
	const pendingConfirm = screen.getByRole("button", { name: "Deleting…" });
	const cancel = screen.getByRole("button", { name: "Cancel" });
	expect(pendingConfirm.hasAttribute("disabled")).toBe(false);
	expect(pendingConfirm.getAttribute("aria-busy")).toBe("true");
	expect(cancel.hasAttribute("disabled")).toBe(false);
	expect(panel.contains(document.activeElement)).toBe(true);

	// Cancel is the way out while the answer is still in the air, so it must still dismiss.
	fireEvent.click(cancel);
	expect(document.querySelector(".meeting-confirm")).toBeNull();

	releaseDelete();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Meetings" }));
	});
});

test("a delete that settles after the member walked away leaves focus where it is", async () => {
	let releaseDelete!: () => void;
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve;
	});
	let deleted = false;
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: deleted ? [] : [meeting("m1", "Weekly sync", "closed")] } }),
		"/api/meetings/delete": async () => {
			await deleteGate;
			deleted = true;
			return { body: { status: "deleting" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Delete Weekly sync" }));
	const warning = await screen.findByText(/^Delete Weekly sync\?/);
	await waitFor(() => {
		expect(document.activeElement).toBe(warning);
	});
	fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));

	// The member walks away while the answer is in the air, into the create form. The settle takes
	// nothing the member is on, so it may not move their focus, the same way an unasked refresh
	// may not.
	const title = screen.getByLabelText("Meeting title");
	title.focus();

	releaseDelete();
	await waitFor(() => {
		expect(announcer().textContent).toContain("Meeting Weekly sync was deleted");
	});
	expect(document.activeElement).toBe(title);
});

test("an open meeting offers the single-use host room link as a copyable value", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "open")] } }),
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Get host room link Meeting m1" }));

	// The room finds the meeting through the `m` search param and the ticket through the `ticket`
	// fragment key. A link that misses either one opens a room that finds neither, so pin the parts
	// the host actually copies, not just the whole string.
	const roomLink = (await screen.findByDisplayValue(
		"https://council.example.com/room?m=m1#ticket=abc",
	)) as HTMLInputElement;
	const parsed = new URL(roomLink.value);
	expect(parsed.searchParams.get("m")).toBe("m1");
	expect(new URLSearchParams(parsed.hash.slice(1)).get("ticket")).toBe("abc");
	expect(screen.getByRole("button", { name: "Copy host room link for Meeting m1" })).toBeTruthy();
	expect(screen.getByText(/single-use/)).toBeTruthy();
});

test("each open meeting names its own host room link", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", "open"), meeting("m2", "Retro", "open")] },
		}),
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	fireEvent.click(screen.getByRole("button", { name: "Get host room link Weekly sync" }));
	fireEvent.click(screen.getByRole("button", { name: "Get host room link Retro" }));

	// Both open cards now show a host-room-link row with the same visible words. Only the meeting
	// title in the accessible name tells a screen-reader member which meeting a copied link joins
	// as host.
	const copyButtons = await screen.findAllByRole("button", { name: /^Copy host room link for / });
	expect(copyButtons.map((button) => button.getAttribute("aria-label")).sort()).toEqual([
		"Copy host room link for Retro",
		"Copy host room link for Weekly sync",
	]);
	expect(screen.getAllByRole("textbox", { name: "Host room link for Weekly sync" })).toHaveLength(1);
	expect(screen.getAllByRole("textbox", { name: "Host room link for Retro" })).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "Copy host room link" })).toBeNull();
});

test("the host room link announces itself, takes focus, and comes after the notice that names it", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "open")] } }),
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	const button = screen.getByRole("button", { name: "Get host room link Meeting m1" });
	button.focus();
	fireEvent.click(button);

	// The button keeps its own words, so it cannot report that the link arrived. The notice does both
	// jobs: it is the live region that says so and the element focus lands on.
	const notice = await screen.findByText("Copy this single-use link and open it in a new browser tab.");
	expect(notice.getAttribute("role")).toBe("status");
	await waitFor(() => {
		expect(document.activeElement).toBe(notice);
	});

	// The notice comes first so the next Tab reaches the link. Behind it the member would have to walk
	// backwards to the value they just asked for.
	const roomLink = screen.getByDisplayValue("https://council.example.com/room?m=m1#ticket=abc");
	expect(notice.compareDocumentPosition(roomLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a host room link that arrives during a delete confirmation leaves that warning focused", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "open")] } }),
		"/api/meetings/room-ticket": async () => {
			await gate;
			return { body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	// Delete is not gated by the row's busy guard, so a member really can open the confirmation while
	// the ticket request is still in the air.
	fireEvent.click(screen.getByRole("button", { name: "Get host room link Meeting m1" }));
	fireEvent.click(screen.getByRole("button", { name: "Delete Meeting m1" }));
	const warning = await screen.findByText(/^Delete Meeting m1\?/);
	await waitFor(() => {
		expect(document.activeElement).toBe(warning);
	});

	release();
	expect(await screen.findByDisplayValue("https://council.example.com/room?m=m1#ticket=abc")).toBeTruthy();

	// Pulling focus out of a delete warning is how a delete gets confirmed unread, so the link only
	// announces itself here.
	expect(document.activeElement).toBe(warning);

	// Cancelling puts focus back on Delete, and the answered link must not take it again.
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete Meeting m1" }));
	});
});

test("a card that guests can still join carries the guest link and says the code cannot come back", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", "open"), meeting("m2", "Retro", "ready")] },
		}),
	});
	render(<App client={make_client()} />);
	const openRow = (await screen.findByRole("heading", { level: 4, name: "Weekly sync" })).closest("li")!;

	// The guest link is only the meeting id, so the card can rebuild it at any time. The join code
	// cannot be rebuilt: the service stores only its hash and has no route that issues a new one. So
	// once the one-time invite panel is dismissed, this card is the only thing that can say so.
	expect(within(openRow).getByDisplayValue(`${COUNCIL_SERVICE_ORIGIN}/room?m=m1`)).toBeTruthy();
	expect(within(openRow).getByText(/cannot show it again\. Create a new meeting to get a new code\./)).toBeTruthy();

	// A finished meeting admits nobody, so it offers no invite.
	const readyRow = screen.getByRole("heading", { level: 4, name: "Retro" }).closest("li")!;
	expect(within(readyRow).queryByDisplayValue(`${COUNCIL_SERVICE_ORIGIN}/room?m=m2`)).toBeNull();
});

test("a polled close removes a stale host room link", async () => {
	let attempts = 0;
	stub_council({
		"/api/meetings/list": () => {
			attempts += 1;
			return {
				body: { meetings: [meeting("m1", "Meeting m1", attempts === 1 ? "open" : "processing")] },
			};
		},
		"/api/meetings/room-ticket": () => ({ body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Meeting m1");

	fireEvent.click(screen.getByRole("button", { name: "Get host room link Meeting m1" }));
	expect(await screen.findByDisplayValue("https://council.example.com/room?m=m1#ticket=abc")).toBeTruthy();

	expect(await screen.findByText("Processing", {}, { timeout: 7000 })).toBeTruthy();
	expect(screen.queryByDisplayValue("https://council.example.com/room?m=m1#ticket=abc")).toBeNull();
}, 10000);

test("meeting cards show timestamps, participants, destination, and friendly artifact labels", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "Meeting m1", "ready"),
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
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Meeting m1", "processing")] } }),
	});
	render(<App client={make_client()} />);

	const deleteButton = await screen.findByRole("button", { name: "Delete after processing Meeting m1" });
	expect(deleteButton.hasAttribute("disabled")).toBe(true);
	expect(screen.queryByRole("button", { name: "Delete Meeting m1" })).toBeNull();
});

test("a ready meeting with a lost video shows the recording warning and keeps the other badges", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "Meeting m1", "ready"),
						recordingWarning:
							"Council could not store the video recording. The file was larger than the workspace can accept. The audio file was still saved.",
						artifacts: [
							{ kind: "track_audio", name: "recording-audio.m4a" },
							{ kind: "transcript_markdown", name: "transcript.md" },
							{ kind: "summary_markdown", name: "summary.md" },
						],
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("Ready")).toBeTruthy();
	expect(
		screen.getByText(
			"Council could not store the video recording. The file was larger than the workspace can accept. The audio file was still saved.",
		),
	).toBeTruthy();
	expect(screen.getByText("Recording")).toBeTruthy();
	expect(screen.getByText("Transcript")).toBeTruthy();
	expect(screen.getByText("Summary")).toBeTruthy();
});

test("a failed meeting shows the failure reason on the row", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "Meeting m1", "failed"),
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
						...meeting("m1", "Meeting m1", "delete_failed"),
						failureReason: "This item is read-only.",
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	expect(await screen.findByText("This item is read-only.")).toBeTruthy();
});

test("a lost recording is named honestly and keeps the deadline the room still runs on", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: {
				meetings: [
					{
						...meeting("m1", "Vendor call", "recording_start_unknown"),
						openedAt: 1_700_000_100_000,
						deadlineAt: 1_700_003_600_000,
					},
				],
			},
		}),
	});
	render(<App client={make_client()} />);

	// The service never retries the lost provider call, so the recording really failed. The meeting
	// is still counted down by the deadline cron, so the card must keep showing when it closes.
	expect(await screen.findByText("Recording failed")).toBeTruthy();
	expect(screen.queryByText("Recording unknown")).toBeNull();
	expect(screen.getByText("Open until")).toBeTruthy();
	expect(screen.getByText(/could not start the recording/)).toBeTruthy();
});

test("a finished meeting with no files says so instead of naming a folder", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("no-recording", "Budget check", "ready")] } }),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Budget check");

	// The service sends a destinationPath for every meeting, but closing one that stored no recording
	// id settles it to `ready` with no files and no folder. Naming the path here sends the member
	// looking for a folder Files does not have.
	expect(screen.queryByText("/meetings/no-recording")).toBeNull();
	expect(screen.queryByText("Saved to")).toBeNull();
	expect(screen.getByText("Council saved no files for this meeting.")).toBeTruthy();

	// A `ready` meeting with no artifacts is also what a lost Start recording answer settles to, and
	// there the provider may really have recorded. So the card may not claim nobody pressed record.
	expect(screen.queryByText(/No recording was started/)).toBeNull();
});

test("each row action names its own meeting", async () => {
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", "open"), meeting("m2", "Retro", "created")] },
		}),
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	// Two rows offer the same words, so only the row-scoped name can tell a screen-reader member
	// which meeting a press destroys.
	expect(screen.getAllByRole("button", { name: "Delete Weekly sync" })).toHaveLength(1);
	expect(screen.getAllByRole("button", { name: "Delete Retro" })).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

	// Both cards can still admit guests, so both carry a guest-link copy row with the same visible
	// words. The accessible names carry the meeting title, or a screen-reader member cannot tell
	// whose link a copy would take.
	expect(screen.getAllByRole("button", { name: "Copy guest link for Weekly sync" })).toHaveLength(1);
	expect(screen.getAllByRole("button", { name: "Copy guest link for Retro" })).toHaveLength(1);
	expect(screen.getAllByRole("textbox", { name: "Guest link for Weekly sync" })).toHaveLength(1);
	expect(screen.getAllByRole("textbox", { name: "Guest link for Retro" })).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "Copy guest link" })).toBeNull();

	fireEvent.click(screen.getByRole("button", { name: "Delete Weekly sync" }));
	expect(screen.getByText(/^Delete Weekly sync\?/)).toBeTruthy();
});

test("a row action stays focusable while it runs and never drops focus on the page body", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [meeting("m1", "Weekly sync", "open")] } }),
		"/api/meetings/room-ticket": async () => {
			await gate;
			return { body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	const button = screen.getByRole("button", { name: "Get host room link Weekly sync" });
	button.focus();
	fireEvent.click(button);

	// A real browser blurs a focused control the moment it becomes disabled, and nothing puts that
	// focus back. happy-dom does not reproduce the blur, so assert the attribute that causes it.
	expect(button.hasAttribute("disabled")).toBe(false);
	expect(button.getAttribute("aria-busy")).toBe("true");

	release();
	expect(await screen.findByDisplayValue("https://council.example.com/room?m=m1#ticket=abc")).toBeTruthy();

	// The action moves focus to the notice it just revealed, so the check here is that focus went
	// somewhere real. Landing on `document.body` is the failure this test exists to catch: that is
	// what a button disabled mid-action leaves behind.
	expect(document.activeElement).not.toBe(document.body);
	expect(document.activeElement).toBe(screen.getByText("Copy this single-use link and open it in a new browser tab."));
	expect(button.getAttribute("aria-busy")).toBe("false");
});

test("a busy button stops looking pressable, so a second press is not invited", async () => {
	let releaseTicket = () => {};
	const ticketGate = new Promise<void>((resolve) => {
		releaseTicket = resolve;
	});
	let releaseDelete = () => {};
	const deleteGate = new Promise<void>((resolve) => {
		releaseDelete = resolve;
	});
	let deleted = false;
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: deleted ? [] : [meeting("m1", "Weekly sync", "open")] } }),
		"/api/meetings/room-ticket": async () => {
			await ticketGate;
			return { body: { roomUrl: "https://council.example.com/room?m=m1#ticket=abc" } };
		},
		"/api/meetings/delete": async () => {
			await deleteGate;
			deleted = true;
			return { body: { status: "deleting" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	const pressable = pressable_button_selectors();
	const dimmed = dimmed_button_selectors();

	// `button button-primary`. Both `.button:hover` and `.button-primary:hover` reach it, and that
	// pair is the reason the guard cannot sit on the variant rule alone: a busy primary button that
	// lost only its own hover rule would fall back to the grey `.button:hover` fill and change to
	// the wrong colour instead of not changing at all.
	const link = screen.getByRole("button", { name: "Get host room link Weekly sync" });
	const linkLive = pressable.filter((selector) => link.matches(selector));
	expect(
		linkLive.length,
		"council.css no longer reaches an idle primary row action with both a base and a variant rule",
	).toBeGreaterThan(1);

	fireEvent.click(link);
	expect(link.getAttribute("aria-busy")).toBe("true");
	expect(linkLive.filter((selector) => link.matches(selector)), "a busy primary button still reads as pressable").toEqual(
		[],
	);
	expect(
		dimmed.some((selector) => link.matches(selector)),
		"a busy primary button is not dimmed",
	).toBe(true);

	releaseTicket();
	await screen.findByDisplayValue("https://council.example.com/room?m=m1#ticket=abc");

	// `button button-danger` is the third family that goes busy, and it carries its own hover rule
	// like the primary one does.
	fireEvent.click(screen.getByRole("button", { name: "Delete Weekly sync" }));
	const confirm = await screen.findByRole("button", { name: "Confirm delete" });
	const confirmLive = pressable.filter((selector) => confirm.matches(selector));
	expect(
		confirmLive.length,
		"council.css no longer reaches the idle confirm-delete button with both a base and a variant rule",
	).toBeGreaterThan(1);

	fireEvent.click(confirm);
	expect(confirm.getAttribute("aria-busy")).toBe("true");
	expect(
		confirmLive.filter((selector) => confirm.matches(selector)),
		"a busy danger button still reads as pressable",
	).toEqual([]);
	expect(
		dimmed.some((selector) => confirm.matches(selector)),
		"a busy danger button is not dimmed",
	).toBe(true);

	// The two presses above prove the guard works on a real button of two of the three families that
	// go busy. `button button-quiet` is the third, and it owns no hover rule, so the same
	// `.button:hover` and `.button:active` rules reach it. This last line is what keeps a rule added
	// for a new family later from being written without the guard.
	expect(pressable.filter((selector) => !selector.includes('[aria-busy="true"]'))).toEqual([]);
	// The dim is per family, unlike the guard above, so `button button-quiet` needs a rule of its own
	// and no press in this test reaches one. `Closing…` and `Retrying…` are its two busy labels, and
	// without this line dropping its rule would leave both looking pressable with nothing failing.
	expect(
		dimmed.some((selector) => selector.includes(".button-quiet")),
		"council.css no longer dims a busy quiet button",
	).toBe(true);

	releaseDelete();
	await waitFor(() => {
		expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Meetings" }));
	});
});

test("closing a meeting lands focus on its title, because the press takes the button away", async () => {
	let closed = false;
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", closed ? "processing" : "open")] },
		}),
		"/api/meetings/close": () => {
			closed = true;
			return { body: { status: "processing" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	// Put focus where a keyboard press leaves it. happy-dom does not move focus on `click`, so
	// without this the test would start from `document.body` and prove nothing.
	const button = screen.getByRole("button", { name: "Close meeting Weekly sync" });
	button.focus();
	fireEvent.click(button);

	// A closed meeting cannot be closed again, so this button is gone for good.
	await waitFor(() => {
		expect(screen.queryByRole("button", { name: "Close meeting Weekly sync" })).toBeNull();
	});

	// The card stays, so the member stays in it. Nothing else here takes the focus the button held,
	// and it would otherwise fall to the page body.
	const heading = screen.getByRole("heading", { level: 4, name: "Weekly sync" });
	await waitFor(() => {
		expect(document.activeElement).toBe(heading);
	});

	// A script moved that focus, so the member sees the landing only if council.css lists the title
	// in its focus-ring rule. Dropping the title from that list fails this assertion.
	expect((document.activeElement as HTMLElement).matches(focus_ring_selectors())).toBe(true);
});

test("opening a meeting from its card lands focus on its title, because the press takes the button away", async () => {
	let opened = false;
	stub_council({
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", opened ? "open" : "created")] },
		}),
		"/api/meetings/open": () => {
			opened = true;
			return { body: { meeting: meeting("m1", "Weekly sync", "open") } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	const button = screen.getByRole("button", { name: "Open meeting Weekly sync" });
	button.focus();
	fireEvent.click(button);

	// The service allows one open per meeting, so this button never comes back either.
	await waitFor(() => {
		expect(screen.queryByRole("button", { name: "Open meeting Weekly sync" })).toBeNull();
	});

	const heading = screen.getByRole("heading", { level: 4, name: "Weekly sync" });
	await waitFor(() => {
		expect(document.activeElement).toBe(heading);
	});
	expect((document.activeElement as HTMLElement).matches(focus_ring_selectors())).toBe(true);
});

test("a close that settles straight to ready still lands focus on the title it moved", async () => {
	let closed = false;
	stub_council({
		// The no-recording settle: closing a meeting that started no recording has nothing to process,
		// so the service answers `ready` instead of `processing`.
		"/api/meetings/list": () => ({
			body: { meetings: [meeting("m1", "Weekly sync", closed ? "ready" : "open")] },
		}),
		"/api/meetings/close": () => {
			closed = true;
			return { body: { status: "ready" } };
		},
	});
	render(<App client={make_client()} />);
	await screen.findByText("Weekly sync");

	const button = screen.getByRole("button", { name: "Close meeting Weekly sync" });
	button.focus();
	fireEvent.click(button);

	await waitFor(() => {
		expect(screen.queryByRole("button", { name: "Close meeting Weekly sync" })).toBeNull();
	});

	// `ready` is not an Active status, so this press moves the card out of Active and into Recent.
	// That builds a whole new card, which is why the page and not the card remembers where the focus
	// has to land: a ref inside the card would be thrown away with the card.
	const heading = screen.getByRole("heading", { level: 4, name: "Weekly sync" });
	expect(heading.closest("section")!.querySelector("h3")!.textContent).toBe("Recent");
	await waitFor(() => {
		expect(document.activeElement).toBe(heading);
	});
	expect((document.activeElement as HTMLElement).matches(focus_ring_selectors())).toBe(true);
});

test("a refused clipboard still copies through the old command", async () => {
	stub_council({
		"/api/meetings/list": () => ({ body: { meetings: [] } }),
		"/api/meetings/create": () => ({
			body: {
				meeting: meeting("m9", "Planning", "created"),
				joinCode: "code-shown-once",
				guestUrl: "https://council.example.com/room?m=m9",
			},
		}),
	});
	// A host frame without the `clipboard-write` grant rejects every async clipboard call. The join
	// code cannot be shown again, so the row must still copy it.
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: () => Promise.reject(new Error("NotAllowedError")) },
	});
	Object.defineProperty(document, "execCommand", { configurable: true, value: () => true });
	render(<App client={make_client()} />);
	await screen.findByText("No meetings yet. Create one to get a guest invite.");

	fireEvent.input(screen.getByLabelText("Meeting title"), { target: { value: "Planning" } });
	fireEvent.submit(document.querySelector("form.create-form")!);
	const input = (await screen.findByDisplayValue("code-shown-once")) as HTMLInputElement;

	fireEvent.click(screen.getByRole("button", { name: "Copy join code" }));

	const status = document.getElementById(input.getAttribute("aria-describedby")!)!;
	await waitFor(() => {
		expect(status.textContent).toBe("Copied.");
	});
	expect(input.selectionStart).toBe(0);
	expect(input.selectionEnd).toBe("code-shown-once".length);
});

test("the stylesheet declares a dark color scheme", () => {
	// Read the file off disk and drop its comments, for the reasons `focus_ring_selectors` gives.
	const css = readFileSync(join(process.cwd(), "src", "council.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

	// The plugin renders in a sandboxed iframe with its own document, so it inherits no color scheme
	// from the host app. Without this declaration a browser in light mode paints a near-white
	// scrollbar down the near-black page, and light form controls and text caret with it. Reading the
	// value back off an element would prove nothing: this environment never loads the stylesheet.
	expect(
		/:root\s*\{[^{}]*color-scheme:\s*dark\b/u.test(css),
		"council.css no longer declares color-scheme: dark on :root",
	).toBe(true);
});
