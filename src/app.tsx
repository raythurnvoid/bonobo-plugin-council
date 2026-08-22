import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import {
	create_council_api,
	get_error_message,
	type CouncilApi,
	type CouncilArtifactKind,
	type CouncilCreatedMeeting,
	type CouncilMeeting,
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

const ACTIVE_STATUSES = new Set(["created", "open", "recording_start_unknown", "closed", "processing", "deleting"]);
const CLOSEABLE_STATUSES = new Set(["open", "recording_start_unknown"]);

const ARTIFACT_LABELS: Record<CouncilArtifactKind, string> = {
	track_audio: "Recording",
	transcript_markdown: "Transcript",
	summary_markdown: "Summary",
	provider_transcript: "Provider transcript",
};

const ARTIFACT_ORDER: CouncilArtifactKind[] = [
	"track_audio",
	"transcript_markdown",
	"summary_markdown",
	"provider_transcript",
];

function status_label(status: string) {
	return STATUS_LABELS[status] ?? status;
}

/**
 * Compare poll results outside the rows, because a removed row cannot announce its own deletion.
 */
function describe_meeting_changes(previous: CouncilMeeting[], next: CouncilMeeting[]) {
	const nextById = new Map(next.map((meeting) => [meeting.id, meeting]));
	const previousIds = new Set(previous.map((meeting) => meeting.id));
	const changes: string[] = [];
	for (const meeting of next) {
		if (!previousIds.has(meeting.id)) {
			changes.push(`Meeting ${meeting.title} was added`);
		}
	}

	for (const before of previous) {
		const after = nextById.get(before.id);
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

function format_time(epochMs: number) {
	return new Date(epochMs).toLocaleString();
}

function artifact_labels(meeting: CouncilMeeting) {
	const kinds = new Set(meeting.artifacts.map((artifact) => artifact.kind));
	return ARTIFACT_ORDER.filter((kind) => kinds.has(kind)).map((kind) => ARTIFACT_LABELS[kind]);
}

/** A value the member needs to carry from the sandboxed plugin page to another browser tab. */
function CopyRow(props: { label: string; value: string }) {
	const rootId = `CopyRow-${useId()}`;
	const inputId = `${rootId}-input`;
	const statusId = `${rootId}-status`;
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

	const handle_copy = () => {
		navigator.clipboard.writeText(props.value).then(
			() => setCopyState("copied"),
			() => {
				// Keep manual copy usable when the iframe is denied clipboard access.
				inputRef.current?.select();
				setCopyState("failed");
			},
		);
	};

	return (
		<div className="copy-row">
			<label className="copy-row-label" htmlFor={inputId}>
				{props.label}
			</label>
			<div className="copy-row-controls">
				<input
					ref={inputRef}
					id={inputId}
					className="copy-row-input"
					type="text"
					readOnly
					value={props.value}
					aria-describedby={statusId}
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button
					type="button"
					className="button button-quiet"
					aria-label={`Copy ${props.label.toLowerCase()}`}
					onClick={handle_copy}
				>
					Copy
				</button>
			</div>
			<span id={statusId} className="copy-row-status" role="status">
				{copyState === "copied"
					? "Copied."
					: copyState === "failed"
						? "Copy failed. Select the text and copy it manually."
						: ""}
			</span>
		</div>
	);
}

function CreateMeetingForm(props: { api: CouncilApi; onCreated: (created: CouncilCreatedMeeting) => void }) {
	const rootId = `CreateMeetingForm-${useId()}`;
	const titleId = `${rootId}-title-input`;
	const titleHelpId = `${rootId}-title-helper`;
	const actionErrorId = `${rootId}-action-error`;
	const titleRef = useRef<HTMLInputElement | null>(null);
	const actionErrorRef = useRef<HTMLParagraphElement | null>(null);
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [fieldError, setFieldError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	useEffect(() => {
		if (actionError !== null) {
			actionErrorRef.current?.focus();
		}
	}, [actionError]);

	const validate_title = (input: HTMLInputElement) => {
		const message = input.value.trim() === "" ? "Enter a meeting title." : "";
		input.setCustomValidity(message);
		return message;
	};

	const handle_submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (busy) {
			return;
		}
		const input = titleRef.current;
		if (!input) {
			return;
		}
		const validationMessage = validate_title(input);
		if (validationMessage !== "" || !event.currentTarget.checkValidity()) {
			setFieldError(validationMessage || input.validationMessage);
			input.focus();
			return;
		}

		setBusy(true);
		setActionError(null);
		props.api.create_meeting(title.trim()).then(
			(created) => {
				setBusy(false);
				setTitle("");
				setFieldError(null);
				props.onCreated(created);
			},
			(createError: unknown) => {
				setBusy(false);
				setActionError(get_error_message(createError));
			},
		);
	};

	return (
		<form className="create-form" onSubmit={handle_submit}>
			<div className="field">
				<label htmlFor={titleId}>Meeting title</label>
				<input
					ref={titleRef}
					id={titleId}
					type="text"
					value={title}
					required
					maxLength={180}
					aria-describedby={titleHelpId}
					onInput={(event) => {
						setTitle(event.currentTarget.value);
						setActionError(null);
						const nextError = validate_title(event.currentTarget);
						if (fieldError !== null) {
							setFieldError(nextError || null);
						}
					}}
					onBlur={(event) => {
						const nextError = validate_title(event.currentTarget);
						if (event.currentTarget.value !== "") {
							setFieldError(nextError || null);
						}
					}}
					onInvalid={(event) => {
						event.preventDefault();
						const nextError = validate_title(event.currentTarget) || event.currentTarget.validationMessage;
						setFieldError(nextError);
						event.currentTarget.focus();
					}}
				/>
				<p id={titleHelpId} className={fieldError === null ? "field-help" : "field-help is-error"}>
					{fieldError ?? "Use a short name that guests will recognize."}
				</p>
			</div>
			{actionError !== null ? (
				<p ref={actionErrorRef} id={actionErrorId} className="form-error" role="alert" tabIndex={-1}>
					{actionError}
				</p>
			) : null}
			<button type="submit" className="button button-primary" disabled={busy}>
				{busy ? "Creating…" : "Create meeting"}
			</button>
		</form>
	);
}

/** Keep the guest invite here only, because the service never stores the plaintext join code. */
function CreatedMeetingPanel(props: {
	api: CouncilApi;
	created: CouncilCreatedMeeting;
	onDismiss: () => void;
	onOpened: (meeting: CouncilMeeting) => void;
}) {
	const rootId = `CreatedMeetingPanel-${useId()}`;
	const headingId = `${rootId}-heading`;
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const errorRef = useRef<HTMLParagraphElement | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	useEffect(() => {
		if (error !== null) {
			errorRef.current?.focus();
		}
	}, [error]);

	const handle_open = () => {
		setBusy(true);
		setError(null);
		props.api.open_meeting(props.created.meeting.id).then(
			(meeting) => {
				setBusy(false);
				props.onOpened(meeting);
			},
			(openError: unknown) => {
				setBusy(false);
				setError(get_error_message(openError));
			},
		);
	};

	return (
		<section className="created-panel" aria-labelledby={headingId}>
			<p className="section-kicker">One-time invite</p>
			<h2 id={headingId} tabIndex={-1} ref={headingRef}>
				{props.created.meeting.title}
			</h2>
			<p className="created-panel-warning">Save the join code now. Council cannot show it again.</p>
			<CopyRow label="Join code" value={props.created.joinCode} />
			<CopyRow label="Guest link" value={props.created.guestUrl} />
			<p className="panel-hint">Share both values with guests. Open the meeting when you are ready to admit them.</p>
			{error !== null ? (
				<p ref={errorRef} className="form-error" role="alert" tabIndex={-1}>
					{error}
				</p>
			) : null}
			<div className="panel-actions">
				<button type="button" className="button button-primary" disabled={busy} onClick={handle_open}>
					{busy ? "Opening…" : "Open meeting"}
				</button>
				<button type="button" className="button button-quiet" disabled={busy} onClick={props.onDismiss}>
					Done, I saved the invite
				</button>
			</div>
			<p className="saved-files-note">
				If recording is started, its tracks, transcript, and summary will be saved under /meetings in Files.
			</p>
		</section>
	);
}

type MeetingRow_Props = {
	api: CouncilApi;
	meeting: CouncilMeeting;
	onChanged: (meeting: CouncilMeeting) => void;
	onDeleted: (meeting: CouncilMeeting) => void;
};

function MeetingRow(props: MeetingRow_Props) {
	const { api, meeting } = props;
	const rootId = `MeetingRow-${useId()}`;
	const headingId = `${rootId}-heading`;
	const confirmDescriptionId = `${rootId}-delete-description`;
	const errorRef = useRef<HTMLParagraphElement | null>(null);
	const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
	const confirmDeleteButtonRef = useRef<HTMLButtonElement | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [roomUrl, setRoomUrl] = useState<string | null>(null);

	useEffect(() => {
		if (confirmingDelete) {
			confirmDeleteButtonRef.current?.focus();
		}
	}, [confirmingDelete]);

	useEffect(() => {
		if (error !== null) {
			errorRef.current?.focus();
		}
	}, [error]);

	useEffect(() => {
		if (meeting.status !== "open") {
			setRoomUrl(null);
		}
	}, [meeting.status]);

	const run = (action: string, work: () => Promise<void>) => {
		if (busy !== null) {
			return;
		}
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

	const handle_delete = () => {
		if (busy !== null) {
			return;
		}
		setBusy("delete");
		setError(null);
		api.delete_meeting(meeting.id).then(
			(status) => {
				setBusy(null);
				setConfirmingDelete(false);
				props.onDeleted({ ...meeting, status });
			},
			(actionError: unknown) => {
				setBusy(null);
				setError(get_error_message(actionError));
			},
		);
	};

	const labels = artifact_labels(meeting);

	return (
		<li className="meeting" data-meeting-id={meeting.id} aria-labelledby={headingId}>
			<div className="meeting-head">
				<div>
					<h4 id={headingId} className="meeting-title" tabIndex={-1}>
						{meeting.title}
					</h4>
					{meeting.createdAt !== null ? (
						<p className="meeting-created">Created {format_time(meeting.createdAt)}</p>
					) : null}
				</div>
				<span className={`meeting-status meeting-status-${meeting.status}`}>{status_label(meeting.status)}</span>
			</div>

			<dl className="meeting-facts">
				{meeting.openedAt !== null ? (
					<div>
						<dt>Opened</dt>
						<dd>{format_time(meeting.openedAt)}</dd>
					</div>
				) : null}
				{meeting.closedAt !== null ? (
					<div>
						<dt>Ended</dt>
						<dd>{format_time(meeting.closedAt)}</dd>
					</div>
				) : null}
				{meeting.status === "open" && meeting.deadlineAt !== null ? (
					<div>
						<dt>Open until</dt>
						<dd>{format_time(meeting.deadlineAt)}</dd>
					</div>
				) : null}
				{meeting.participantCount !== null ? (
					<div>
						<dt>Participants</dt>
						<dd>{meeting.participantCount}</dd>
					</div>
				) : null}
				{meeting.destinationPath !== null ? (
					<div className="meeting-destination">
						<dt>Saved to</dt>
						<dd>{meeting.destinationPath}</dd>
					</div>
				) : null}
			</dl>

			{labels.length > 0 ? (
				<ul className="artifact-badges" aria-label="Saved artifacts">
					{labels.map((label) => (
						<li key={label}>{label}</li>
					))}
				</ul>
			) : meeting.status === "processing" ? (
				<p className="meeting-progress" role="status">
					Council is preparing the saved files.
				</p>
			) : null}

			{meeting.status === "failed" || meeting.status === "delete_failed" ? (
				meeting.failureReason ? (
					<p className="meeting-failure" role="status">
						{meeting.failureReason}
					</p>
				) : null
			) : null}

			<div className="meeting-actions">
				{meeting.status === "created" ? (
					<button
						type="button"
						className="button button-primary"
						disabled={busy !== null}
						onClick={() =>
							run("open", async () => {
								props.onChanged(await api.open_meeting(meeting.id));
							})
						}
					>
						{busy === "open" ? "Opening…" : "Open meeting"}
					</button>
				) : null}
				{meeting.status === "open" ? (
					<button
						type="button"
						className="button button-primary"
						disabled={busy !== null}
						onClick={() =>
							run("room-link", async () => {
								setRoomUrl(await api.room_ticket(meeting.id));
							})
						}
					>
						{busy === "room-link" ? "Getting link…" : "Get host room link"}
					</button>
				) : null}
				{CLOSEABLE_STATUSES.has(meeting.status) ? (
					<button
						type="button"
						className="button button-quiet"
						disabled={busy !== null}
						onClick={() =>
							run("close", async () => {
								const status = await api.close_meeting(meeting.id);
								setRoomUrl(null);
								props.onChanged({ ...meeting, status });
							})
						}
					>
						{busy === "close" ? "Closing…" : "Close meeting"}
					</button>
				) : null}
				{meeting.status === "processing" ? (
					<button type="button" className="button button-quiet" disabled>
						Delete after processing
					</button>
				) : meeting.status !== "deleting" ? (
					<button
						ref={deleteButtonRef}
						type="button"
						className="button button-danger"
						disabled={busy !== null}
						onClick={() => setConfirmingDelete(true)}
					>
						Delete
					</button>
				) : null}
			</div>

			{confirmingDelete ? (
				<div className="meeting-confirm">
					<p id={confirmDescriptionId}>
						Delete this meeting? Its saved folder moves to the Files archive, where a member can restore it.
					</p>
					<div className="panel-actions">
						<button
							ref={confirmDeleteButtonRef}
							type="button"
							className="button button-danger"
							aria-describedby={confirmDescriptionId}
							disabled={busy !== null}
							onClick={handle_delete}
						>
							{busy === "delete" ? "Deleting…" : "Confirm delete"}
						</button>
						<button
							type="button"
							className="button button-quiet"
							disabled={busy !== null}
							onClick={() => {
								setConfirmingDelete(false);
								deleteButtonRef.current?.focus();
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			{meeting.status === "open" && roomUrl !== null ? (
				<div className="meeting-room-link">
					<CopyRow label="Host room link" value={roomUrl} />
					<p className="panel-hint">Copy this single-use link and open it in a new browser tab.</p>
				</div>
			) : null}

			{error !== null ? (
				<p ref={errorRef} className="form-error meeting-action-error" role="alert" tabIndex={-1}>
					{error}
				</p>
			) : null}
		</li>
	);
}

function MeetingGroup(props: {
	title: string;
	meetings: CouncilMeeting[];
	api: CouncilApi;
	onChanged: (meeting: CouncilMeeting) => void;
	onDeleted: (meeting: CouncilMeeting) => void;
}) {
	const headingId = `MeetingGroup-${useId()}-heading`;
	if (props.meetings.length === 0) {
		return null;
	}
	return (
		<section className="meeting-group" aria-labelledby={headingId}>
			<h3 id={headingId}>{props.title}</h3>
			<ul className="meeting-list">
				{props.meetings.map((meeting) => (
					<MeetingRow
						key={meeting.id}
						api={props.api}
						meeting={meeting}
						onChanged={props.onChanged}
						onDeleted={props.onDeleted}
					/>
				))}
			</ul>
		</section>
	);
}

export function App(props: { client: BonoboUiFrontendClient }) {
	const api = useMemo(() => create_council_api(props.client), [props.client]);
	const newMeetingId = `Council-${useId()}-new-meeting`;
	const meetingsHeadingId = `${newMeetingId}-meetings-heading`;
	const [meetings, setMeetings] = useState<CouncilMeeting[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [created, setCreated] = useState<CouncilCreatedMeeting | null>(null);
	const [announcement, setAnnouncement] = useState({ sequence: 0, text: "" });
	const refreshingRef = useRef(false);
	const refreshQueuedRef = useRef(false);
	const meetingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
	const newMeetingHeadingRef = useRef<HTMLHeadingElement | null>(null);
	const announcedMeetingsRef = useRef<CouncilMeeting[] | null>(null);
	const [focusAfterCreatedPanel, setFocusAfterCreatedPanel] = useState<"create" | string | null>(null);

	const refresh = useCallback(() => {
		if (refreshingRef.current) {
			refreshQueuedRef.current = true;
			return;
		}
		refreshingRef.current = true;
		setIsRefreshing(true);
		api
			.list_meetings()
			.then(
				(items) => {
					const announced = announcedMeetingsRef.current;
					announcedMeetingsRef.current = items;
					if (announced !== null) {
						const text = describe_meeting_changes(announced, items);
						if (text !== "") {
							setAnnouncement((current) => ({ sequence: current.sequence + 1, text }));
						}
					}
					setMeetings(items);
					setListError(null);
				},
				(error: unknown) => {
					// Keep the last useful cards visible when only a later poll fails.
					setListError(get_error_message(error));
				},
			)
			.finally(() => {
				refreshingRef.current = false;
				if (refreshQueuedRef.current) {
					refreshQueuedRef.current = false;
					refresh();
					return;
				}
				setIsRefreshing(false);
			});
	}, [api]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	useEffect(() => {
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	}, [refresh]);

	useEffect(() => {
		if (created !== null || focusAfterCreatedPanel === null) {
			return;
		}
		if (focusAfterCreatedPanel === "create") {
			newMeetingHeadingRef.current?.focus();
		} else {
			const heading = document.querySelector<HTMLElement>(
				`[data-meeting-id="${focusAfterCreatedPanel}"] .meeting-title`,
			);
			heading?.focus();
		}
		setFocusAfterCreatedPanel(null);
	}, [created, focusAfterCreatedPanel]);

	const activeMeetings = meetings?.filter((meeting) => ACTIVE_STATUSES.has(meeting.status)) ?? [];
	const recentMeetings = meetings?.filter((meeting) => !ACTIVE_STATUSES.has(meeting.status)) ?? [];
	const merge_meeting = (next: CouncilMeeting) => {
		setMeetings((current) => {
			if (current === null) {
				return [next];
			}
			return current.some((meeting) => meeting.id === next.id)
				? current.map((meeting) => (meeting.id === next.id ? next : meeting))
				: [next, ...current];
		});
	};
	const handle_changed = (meeting: CouncilMeeting) => {
		merge_meeting(meeting);
		refresh();
	};
	const handle_deleted = (meeting: CouncilMeeting) => {
		merge_meeting(meeting);
		meetingsHeadingRef.current?.focus();
		refresh();
	};

	return (
		<div className="council">
			<header className="council-header">
				<div>
					<p className="section-kicker">Workspace meeting room</p>
					<h1>Council</h1>
					<p className="council-tagline">
						Create a call, invite guests, and keep the recording and notes with your files.
					</p>
				</div>
				<a className="button button-primary council-new-meeting" href={`#${newMeetingId}`}>
					New meeting
				</a>
			</header>

			<main className="council-layout">
				<aside id={newMeetingId} className="council-compose">
					{created !== null ? (
						<CreatedMeetingPanel
							api={api}
							created={created}
							onDismiss={() => {
								setFocusAfterCreatedPanel("create");
								setCreated(null);
							}}
							onOpened={(meeting) => {
								merge_meeting(meeting);
								setFocusAfterCreatedPanel(meeting.id);
								setCreated(null);
								refresh();
							}}
						/>
					) : (
						<section className="council-create" aria-labelledby={`${newMeetingId}-heading`}>
							<p className="section-kicker">Start here</p>
							<h2 ref={newMeetingHeadingRef} id={`${newMeetingId}-heading`} tabIndex={-1}>
								New meeting
							</h2>
							<p className="create-copy">
								When recording is started, Council saves its tracks, transcript, summary, and provider transcript in a
								read-only meeting folder.
							</p>
							<CreateMeetingForm
								api={api}
								onCreated={(result) => {
									merge_meeting(result.meeting);
									setCreated(result);
									refresh();
								}}
							/>
						</section>
					)}
					<div className="files-callout">
						<strong>Find finished files in Files</strong>
						<span>Council cannot open host pages from this secure plugin frame.</span>
					</div>
				</aside>

				<section className="council-meetings" aria-labelledby={meetingsHeadingId}>
					<div className="meetings-heading-row">
						<div>
							<p className="section-kicker">Live and recent</p>
							<h2 ref={meetingsHeadingRef} id={meetingsHeadingId} tabIndex={-1}>
								Meetings
							</h2>
						</div>
						{isRefreshing && meetings !== null ? (
							<span className="refreshing-label" role="status">
								Refreshing…
							</span>
						) : null}
					</div>

					{listError !== null && meetings !== null ? (
						<div className="refresh-error" role="alert">
							<span>Could not refresh: {listError}</span>
							<button type="button" className="button button-quiet" disabled={isRefreshing} onClick={refresh}>
								Retry
							</button>
						</div>
					) : null}

					{meetings === null ? (
						listError !== null ? (
							<div className="council-status is-error" role="alert">
								<span>{listError}</span>
								<button type="button" className="button button-quiet" disabled={isRefreshing} onClick={refresh}>
									Retry
								</button>
							</div>
						) : (
							<div className="council-status" role="status" aria-live="polite">
								Loading meetings…
							</div>
						)
					) : meetings.length === 0 ? (
						<div className="council-status council-empty">No meetings yet. Create one to get a guest invite.</div>
					) : (
						<div className="meeting-groups">
							<MeetingGroup
								title="Active"
								meetings={activeMeetings}
								api={api}
								onChanged={handle_changed}
								onDeleted={handle_deleted}
							/>
							<MeetingGroup
								title="Recent"
								meetings={recentMeetings}
								api={api}
								onChanged={handle_changed}
								onDeleted={handle_deleted}
							/>
						</div>
					)}
				</section>
			</main>

			<div className="council-announcer visually-hidden" role="status" aria-live="polite">
				<span aria-hidden="true" data-announcement-sequence={String(announcement.sequence)}>
					{announcement.sequence}
				</span>
				{announcement.text !== "" ? ` ${announcement.text}` : ""}
			</div>
		</div>
	);
}
