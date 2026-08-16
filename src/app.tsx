import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
	create_council_api,
	get_error_message,
	type CouncilApi,
	type CouncilCreatedMeeting,
	type CouncilMeeting,
	type CouncilMeetingDetails,
} from "./council-api";

const STATUS_LABELS: Record<string, string> = {
	created: "Created",
	create_unknown: "Create incomplete",
	open: "Open",
	recording_start_unknown: "Recording unknown",
	closed: "Closed",
	processing: "Processing",
	ready: "Ready",
	failed: "Failed",
	expired: "Expired",
	deleting: "Deleting",
	delete_failed: "Delete failed",
};

function status_label(status: string) {
	return STATUS_LABELS[status] ?? status;
}

const TRANSITIONAL_STATUSES = ["closed", "processing", "deleting"];

/**
 * Describe what changed between two list refreshes, for the screen-reader announcer.
 *
 * The list refreshes itself every few seconds, so a member using a screen reader is never told
 * that a meeting finished processing or that a delete completed. A row cannot announce its own
 * removal, because a node taken out of a live region says nothing. So both lists are compared
 * here, where the old one and the new one are visible at the same time.
 */
function describe_meeting_changes(previous: CouncilMeeting[], next: CouncilMeeting[]) {
	const nextById = new Map(next.map((meeting) => [meeting.id, meeting]));
	const changes: string[] = [];

	for (const before of previous) {
		const after = nextById.get(before.id);
		// A meeting leaves the list only when its delete finished and the row was tombstoned.
		if (!after) {
			changes.push(`Meeting ${before.title} was deleted`);
			continue;
		}

		if (after.status !== before.status) {
			changes.push(`Meeting ${after.title} is now ${status_label(after.status)}`);
		}
	}

	return changes.join(". ");
}

function format_time(epochMs: number | null) {
	return epochMs === null ? null : new Date(epochMs).toLocaleString();
}

/**
 * A value the member has to carry somewhere else (join code, guest link, room link). The plugin
 * iframe's sandbox has no `allow-popups`, so the page cannot open a new tab itself — copying the
 * value is the supported flow.
 */
export function CopyRow(props: { label: string; value: string }) {
	const id = useId();
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

	const handle_copy = () => {
		navigator.clipboard.writeText(props.value).then(
			() => setCopyState("copied"),
			() => {
				// Clipboard access can be blocked inside the sandboxed frame; select the text so a
				// manual Ctrl+C still works.
				inputRef.current?.select();
				setCopyState("failed");
			},
		);
	};

	return (
		<div className="copy-row">
			<label className="copy-row-label" htmlFor={id}>
				{props.label}
			</label>
			<div className="copy-row-controls">
				<input
					ref={inputRef}
					id={id}
					className="copy-row-input"
					type="text"
					readOnly
					value={props.value}
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button type="button" className="button" onClick={handle_copy}>
					Copy
				</button>
			</div>
			<span className="copy-row-status" role="status">
				{copyState === "copied" ? "Copied." : copyState === "failed" ? "Copy failed — select the text and copy it manually." : ""}
			</span>
		</div>
	);
}

export function CreateMeetingForm(props: { api: CouncilApi; onCreated: (created: CouncilCreatedMeeting) => void }) {
	const titleId = useId();
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handle_submit = (event: { preventDefault: () => void }) => {
		event.preventDefault();
		// The Enter key calls this directly, so the button's disabled state alone cannot stop a
		// second submit while the first create is still in flight.
		if (busy) {
			return;
		}
		const trimmed = title.trim();
		if (trimmed === "") {
			setError("Enter a meeting title.");
			return;
		}
		setBusy(true);
		setError(null);
		props.api.create_meeting(trimmed).then(
			(created) => {
				setBusy(false);
				setTitle("");
				props.onCreated(created);
			},
			(createError: unknown) => {
				setBusy(false);
				setError(get_error_message(createError));
			},
		);
	};

	// The host iframe sandbox has no `allow-forms`, so native form submission is silently blocked:
	// a submit-type button and implicit Enter submission never fire. The button and the Enter key
	// call the handler directly; the form's onSubmit stays as a harmless safety net.
	return (
		<form className="create-form" onSubmit={handle_submit} noValidate>
			<div className="field">
				<label htmlFor={titleId}>Meeting title</label>
				<input
					id={titleId}
					type="text"
					value={title}
					maxLength={180}
					onInput={(event) => setTitle(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							handle_submit(event);
						}
					}}
				/>
			</div>
			{error !== null ? (
				<p className="form-error" role="alert">
					{error}
				</p>
			) : null}
			<button type="button" className="button button-primary" disabled={busy} onClick={handle_submit}>
				{busy ? "Creating…" : "Create meeting"}
			</button>
		</form>
	);
}

/**
 * Shown exactly once, right after a create. The join code cannot be retrieved again — the service
 * stores only its hash — so this panel is the member's one chance to save it.
 */
export function CreatedMeetingPanel(props: { created: CouncilCreatedMeeting; onDismiss: () => void }) {
	const headingRef = useRef<HTMLHeadingElement | null>(null);

	// Move focus to the panel when it appears so keyboard users land on the one-time code.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	return (
		<section className="created-panel" aria-labelledby="created-panel-heading">
			<h2 id="created-panel-heading" tabIndex={-1} ref={headingRef}>
				Meeting created: {props.created.meeting.title}
			</h2>
			<p className="created-panel-warning">
				Save the join code now. It is shown only this once and cannot be retrieved again.
			</p>
			<CopyRow label="Join code" value={props.created.joinCode} />
			<CopyRow label="Guest link" value={props.created.guestUrl} />
			<p className="panel-hint">
				Share the guest link and the join code with participants. Guests open the link in their browser and type the
				code plus a display name.
			</p>
			<button type="button" className="button" onClick={props.onDismiss}>
				Done, I saved the code
			</button>
		</section>
	);
}

type MeetingRow_Props = {
	api: CouncilApi;
	meeting: CouncilMeeting;
	onChanged: () => void;
};

export function MeetingRow(props: MeetingRow_Props) {
	const { api, meeting } = props;
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [roomUrl, setRoomUrl] = useState<string | null>(null);
	const [details, setDetails] = useState<CouncilMeetingDetails | null>(null);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const confirmDeleteId = useId();
	const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
	const confirmDeleteButtonRef = useRef<HTMLButtonElement | null>(null);

	// Move focus into the confirmation when it opens. Without this the panel appears somewhere the
	// keyboard is not, and a screen reader never reaches the warning before the member acts.
	useEffect(() => {
		if (confirmingDelete) {
			confirmDeleteButtonRef.current?.focus();
		}
	}, [confirmingDelete]);

	const handle_cancel_delete = () => {
		setConfirmingDelete(false);
		// Send focus back where it came from, so cancelling does not drop the member at the page top.
		deleteButtonRef.current?.focus();
	};

	const run = (action: string, work: () => Promise<void>) => {
		setBusy(action);
		setError(null);
		work().then(
			() => setBusy(null),
			(actionError: unknown) => {
				setBusy(null);
				setError(get_error_message(actionError));
			},
		);
	};

	const handle_open = () => {
		run("open", async () => {
			await api.open_meeting(meeting.id);
			props.onChanged();
		});
	};

	const handle_room_link = () => {
		run("room-link", async () => {
			setRoomUrl(await api.room_ticket(meeting.id));
		});
	};

	const handle_close = () => {
		run("close", async () => {
			await api.close_meeting(meeting.id);
			setRoomUrl(null);
			props.onChanged();
		});
	};

	const handle_delete = () => {
		setConfirmingDelete(false);
		run("delete", async () => {
			await api.delete_meeting(meeting.id);
			props.onChanged();
		});
	};

	const handle_toggle_details = () => {
		if (detailsOpen) {
			setDetailsOpen(false);
			return;
		}
		setDetailsOpen(true);
		if (details === null) {
			run("details", async () => {
				setDetails(await api.get_meeting(meeting.id));
			});
		}
	};

	const deadline = format_time(meeting.deadlineAt);

	return (
		<li className="meeting">
			<div className="meeting-head">
				<h3 className="meeting-title">{meeting.title}</h3>
				<span className={`meeting-status meeting-status-${meeting.status}`}>{status_label(meeting.status)}</span>
			</div>
			{deadline !== null && meeting.status === "open" ? <p className="meeting-meta">Closes at {deadline}</p> : null}
			<div className="meeting-actions">
				{meeting.status === "created" ? (
					<button type="button" className="button" disabled={busy !== null} onClick={handle_open}>
						{busy === "open" ? "Opening…" : "Open meeting"}
					</button>
				) : null}
				{meeting.status === "open" ? (
					<button type="button" className="button" disabled={busy !== null} onClick={handle_room_link}>
						{busy === "room-link" ? "Getting link…" : "Get room link"}
					</button>
				) : null}
				{meeting.status === "open" ? (
					<button type="button" className="button" disabled={busy !== null} onClick={handle_close}>
						{busy === "close" ? "Closing…" : "Close meeting"}
					</button>
				) : null}
				<button
					type="button"
					className="button"
					aria-expanded={detailsOpen}
					disabled={busy === "details"}
					onClick={handle_toggle_details}
				>
					{busy === "details" ? "Loading…" : detailsOpen ? "Hide details" : "Details"}
				</button>
				<button
					ref={deleteButtonRef}
					type="button"
					className="button button-danger"
					disabled={busy !== null}
					onClick={() => setConfirmingDelete(true)}
				>
					{busy === "delete" ? "Deleting…" : "Delete"}
				</button>
			</div>
			{/* Not an `alertdialog`: that role promises a modal, and the rest of the row stays usable
			    here. Focus movement plus the description below is what a member actually needs. */}
			{confirmingDelete ? (
				<div className="meeting-confirm">
					<p id={confirmDeleteId}>
						Delete this meeting? The meeting itself is gone for good. Its stored files move to the archive, so a
						member can restore them from Files.
					</p>
					<div className="meeting-confirm-buttons">
						{/* The description sits on the button, not on the panel around it. A description on a
						    plain container is not read out; on the button that just took focus it is. */}
						<button
							ref={confirmDeleteButtonRef}
							type="button"
							className="button button-danger"
							aria-describedby={confirmDeleteId}
							onClick={handle_delete}
						>
							Confirm delete
						</button>
						<button type="button" className="button" onClick={handle_cancel_delete}>
							Cancel
						</button>
					</div>
				</div>
			) : null}
			{roomUrl !== null ? (
				<div className="meeting-room-link">
					<CopyRow label="Your host room link" value={roomUrl} />
					<p className="panel-hint">
						Open this link in a new browser tab to join as the host. It is single-use and expires soon; get a fresh
						one here if it stops working.
					</p>
				</div>
			) : null}
			{detailsOpen && details !== null ? (
				<div className="meeting-details">
					{details.artifacts.length > 0 ? (
						<>
							<h4>Files</h4>
							<ul className="meeting-artifacts">
								{details.artifacts.map((artifact) => (
									<li key={artifact.fileNodeId ?? artifact.name}>
										{artifact.name}
										{artifact.fileNodeId !== null ? <span className="meeting-artifact-id"> · {artifact.fileNodeId}</span> : null}
									</li>
								))}
							</ul>
						</>
					) : (
						<p className="panel-hint">
							{details.meeting.status === "ready"
								? "No files were reported for this meeting."
								: "Recording and transcript files appear here once the meeting is processed."}
						</p>
					)}
				</div>
			) : null}
			{error !== null ? (
				<p className="form-error" role="alert">
					{error}
				</p>
			) : null}
		</li>
	);
}

export function App(props: { client: BonoboUiFrontendClient }) {
	const api = useMemo(() => create_council_api(props.client), [props.client]);
	const [meetings, setMeetings] = useState<CouncilMeeting[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [created, setCreated] = useState<CouncilCreatedMeeting | null>(null);
	const [announcement, setAnnouncement] = useState("");
	// Single-flight guard for the async list refresh; a ref keeps it exact across renders.
	const refreshingRef = useRef(false);
	// The list as the member last saw it. Only the comparison against the next list can tell that a
	// meeting settled or disappeared, and a ref keeps it out of the render that reads it.
	const announcedMeetingsRef = useRef<CouncilMeeting[] | null>(null);

	const refresh = useCallback(() => {
		if (refreshingRef.current) {
			return;
		}
		refreshingRef.current = true;
		setListError(null);
		api.list_meetings().then(
			(items) => {
				refreshingRef.current = false;
				const announced = announcedMeetingsRef.current;
				announcedMeetingsRef.current = items;
				// Skip the first load: arriving meetings are not a change the member should hear.
				if (announced !== null) {
					setAnnouncement(describe_meeting_changes(announced, items));
				}
				setMeetings(items);
			},
			(error: unknown) => {
				refreshingRef.current = false;
				setListError(get_error_message(error));
			},
		);
	}, [api]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Meetings in these states change on their own (close handoff, the processing pipeline, the
	// delete workflow). Refresh until they settle, so "Processing" becomes "Ready" without a
	// manual reload. A tombstoned meeting drops out of the list, which also stops the polling.
	useEffect(() => {
		if (meetings === null || !meetings.some((item) => TRANSITIONAL_STATUSES.includes(item.status))) {
			return;
		}
		const timer = setInterval(refresh, 5000);
		return () => clearInterval(timer);
	}, [meetings, refresh]);

	return (
		<div className="council">
			<header className="council-header">
				<h1>Council</h1>
				<p className="council-tagline">
					Recorded meetings with named transcripts. Files land in this workspace when a meeting ends.
				</p>
			</header>

			{created !== null ? (
				<CreatedMeetingPanel
					created={created}
					onDismiss={() => {
						setCreated(null);
					}}
				/>
			) : (
				<section className="council-create" aria-labelledby="create-heading">
					<h2 id="create-heading">New meeting</h2>
					<CreateMeetingForm
						api={api}
						onCreated={(result) => {
							setCreated(result);
							refresh();
						}}
					/>
				</section>
			)}

			<section className="council-meetings" aria-labelledby="meetings-heading">
				<h2 id="meetings-heading">Meetings</h2>
				{listError !== null ? (
					<div className="council-status is-error" role="alert">
						<span>{listError}</span>
						<button type="button" className="button" onClick={refresh}>
							Retry
						</button>
					</div>
				) : meetings === null ? (
					<div className="council-status" role="status" aria-live="polite">
						Loading…
					</div>
				) : meetings.length === 0 ? (
					<div className="council-status">No meetings yet. Create one above.</div>
				) : (
					<ul className="meeting-list">
						{meetings.map((meeting) => (
							<MeetingRow key={meeting.id} api={api} meeting={meeting} onChanged={refresh} />
						))}
					</ul>
				)}
			</section>

			{/* Keep this mounted at all times. A live region that appears together with its first
			    message is announced unreliably, because the screen reader has nothing to watch yet. */}
			<div className="council-announcer visually-hidden" role="status" aria-live="polite">
				{announcement}
			</div>
		</div>
	);
}
