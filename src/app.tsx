import type { BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import {
	COUNCIL_SERVICE_ORIGIN,
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
	// The provider answer to Start recording was lost and the service never retries it, so the
	// recording really did fail. "Unknown" made the member wait for an answer that never comes.
	recording_start_unknown: "Recording failed",
	closed: "Closed",
	processing: "Processing",
	ready: "Ready",
	failed: "Failed",
	expired: "Expired",
	deleting: "Deleting",
	delete_failed: "Delete failed",
};

/**
 * The statuses whose card belongs under Active. Everything else lands under Recent. The cut is what
 * the member is still waiting on: a meeting they are driving themselves, or a service run that is
 * happening right now.
 *
 * "Can still change on its own" is not the cut, and reading it that way puts the wrong statuses
 * here. The service cron moves `failed`, `delete_failed` and `create_unknown` with no member
 * action, but only on a slow clock: an hour for the two retries and a day for the expiry. A member
 * reads those three cards as settled, so they belong under Recent.
 */
const ACTIVE_STATUSES = new Set(["created", "open", "recording_start_unknown", "closed", "processing", "deleting"]);

/** The only two statuses the service lets a member close. Its transition map allows no others. */
const CLOSEABLE_STATUSES = new Set(["open", "recording_start_unknown"]);

/**
 * The two statuses the service still counts down. Its deadline cron closes a meeting in either one
 * at `deadlineAt`, so both cards must show when that happens. Every other status ignores the field.
 */
const DEADLINE_STATUSES = new Set(["open", "recording_start_unknown"]);

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

/**
 * Name the kinds of file a meeting saved, one badge per kind.
 *
 * A meeting saves one audio track per speaker, so the raw list repeats `track_audio`. The member
 * only needs to know that a recording exists, so the kinds collapse to a set and then follow the
 * fixed order above instead of the order the pipeline happened to finalize them in.
 */
function artifact_labels(meeting: CouncilMeeting) {
	const kinds = new Set(meeting.artifacts.map((artifact) => artifact.kind));
	return ARTIFACT_ORDER.filter((kind) => kinds.has(kind)).map((kind) => ARTIFACT_LABELS[kind]);
}

/**
 * A value the member needs to carry from the sandboxed plugin page to another browser tab. The
 * frame has no `allow-popups`, so the page cannot open the destination itself and copying is the
 * only supported way out.
 */
function CopyRow(props: { label: string; value: string; subject?: string }) {
	const rootId = `CopyRow-${useId()}`;
	const inputId = `${rootId}-input`;
	const statusId = `${rootId}-status`;
	const inputRef = useRef<HTMLInputElement | null>(null);
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

	// Several cards can carry this row with the same visible words, so a caller that renders it per
	// meeting passes the meeting title as `subject`. The title joins only the accessible names, and
	// each name keeps the visible text inside it, as WCAG 2.5.3 asks. The one-time invite panel is
	// singular, so it passes no subject and its names stay as they are.
	const subjectSuffix = props.subject === undefined ? "" : ` for ${props.subject}`;

	const handle_copy = () => {
		navigator.clipboard.writeText(props.value).then(
			() => setCopyState("copied"),
			() => {
				// `clipboard-write` is Permissions-Policy gated and a cross-origin frame does not
				// inherit it. The current host grants it on the plugin iframe, so this call normally
				// resolves — but that grant belongs to the host, and an older host or a frame that
				// drops it rejects every call here. These values are shown once, so do not depend on
				// it: select the text and try the old command, which this frame can still run. Only
				// when that refuses too does the member have to press Ctrl+C by hand.
				inputRef.current?.select();
				setCopyState(document.execCommand("copy") ? "copied" : "failed");
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
					aria-label={props.subject === undefined ? undefined : `${props.label}${subjectSuffix}`}
					aria-describedby={statusId}
					onFocus={(event) => event.currentTarget.select()}
				/>
				<button
					type="button"
					className="button button-quiet"
					aria-label={`Copy ${props.label.toLowerCase()}${subjectSuffix}`}
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

/**
 * The same cap the service applies to a new title, counted the same way.
 *
 * `handle_create` in the service reads the title with a 200 UTF-8 byte limit. The field used to cap
 * `maxLength` at 180 instead, and that attribute counts UTF-16 units. A 67-character Chinese or emoji
 * title is already over 200 bytes while the browser still calls the field valid, so the create was
 * sent and came back refused with "title is longer than 200 bytes" — a unit the member cannot see or
 * count. Measure the bytes here instead, and refuse in the field where the member can fix it.
 */
const TITLE_MAX_BYTES = 200;

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

	// Send focus to the error so a keyboard or screen-reader member hears why the create failed
	// instead of pressing the same button again.
	useEffect(() => {
		if (actionError !== null) {
			actionErrorRef.current?.focus();
		}
	}, [actionError]);

	// Push the message into the browser's own validity state, so `:invalid` styling and the native
	// bubble say the same thing as the helper text below the field. The trimmed value is what
	// `handle_submit` sends, so it is also what the byte cap has to measure.
	const validate_title = (input: HTMLInputElement) => {
		const value = input.value.trim();
		const message =
			value === ""
				? "Enter a meeting title."
				: new TextEncoder().encode(value).length > TITLE_MAX_BYTES
					? "This title is too long. Shorten it and try again."
					: "";
		input.setCustomValidity(message);
		return message;
	};

	const handle_submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		// Stop a second create while the first one is still in flight. Enter in the title field submits
		// the form directly, and the Create button below stays enabled on purpose, so this guard is the
		// only thing that can stop it.
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
					aria-describedby={titleHelpId}
					// The `onInvalid` handler below cancels the native bubble, and a screen reader does not
					// read `required` back on its own. This is what tells a member returning to the field that
					// the value in it was refused. The room's guest form marks its refused fields the same way.
					aria-invalid={fieldError !== null}
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
				{/* Say the refusal out loud, because nothing else here does. The browser refuses an invalid
				    title before `submit` fires, so `handle_submit` never runs for it, and the `onInvalid`
				    handler above cancels the native bubble that used to be the only thing announcing it. The
				    paragraph right above is the field's `aria-describedby` target, which a screen reader
				    reads when the member enters the field, not when the text in it changes. This node
				    carries the same message and mounts with the message already inside it, so `role="alert"`
				    reads it out as soon as it appears. Keep it visually hidden: the paragraph above is what
				    the eye reads, and two copies on screen would say the same thing twice. */}
				{fieldError !== null ? (
					<p className="visually-hidden" role="alert">
						{fieldError}
					</p>
				) : null}
			</div>
			{actionError !== null ? (
				<p ref={actionErrorRef} id={actionErrorId} className="form-error" role="alert" tabIndex={-1}>
					{actionError}
				</p>
			) : null}
			{/* Same rule as every other action on this page: the button stays enabled and reports the wait
			    with `aria-busy`, because the browser blurs a focused control the moment it becomes disabled
			    and nothing puts that focus back. The guard in `handle_submit` stops the second press. */}
			<button type="submit" className="button button-primary" aria-busy={busy}>
				{busy ? "Creating…" : "Create meeting"}
			</button>
		</form>
	);
}

/** Keep the guest invite here only, because the service never stores the plaintext join code. */
function CreatedMeetingPanel(props: {
	api: CouncilApi;
	created: CouncilCreatedMeeting;
	status: string | null;
	onDismiss: () => void;
	onOpened: (meeting: CouncilMeeting) => void;
}) {
	const rootId = `CreatedMeetingPanel-${useId()}`;
	const headingId = `${rootId}-heading`;
	const headingRef = useRef<HTMLHeadingElement | null>(null);
	const errorRef = useRef<HTMLParagraphElement | null>(null);
	const openedNoticeRef = useRef<HTMLParagraphElement | null>(null);
	// Remember only that the press happened here, for the focus move below. Whether the meeting is
	// open is the meeting's business, not this panel's.
	const openedHereRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The card for this meeting offers the same Open action, so read the meeting instead of
	// remembering the press. A panel that remembered only its own press kept a live button after the
	// card opened the meeting, and the service answers that second open with a 409 the member cannot
	// act on.
	//
	// Read the status itself, never "anything but created". Deleting the meeting from its card moves
	// it to `deleting`, and the unopened-meeting deadline moves it to `expired`; neither one opened
	// anything, and this panel is the member's only reading of the meeting while it is up. A null
	// status means the meeting has left the list, so say nothing about a meeting that is not there.
	const canOpen = props.status === "created";
	const isOpen = props.status === "open";

	// The panel replaces the create form in place, so move focus into it. Otherwise a keyboard member
	// stays on a button that no longer exists and never reaches the code they can only read once.
	useEffect(() => {
		headingRef.current?.focus();
	}, []);

	useEffect(() => {
		if (error !== null) {
			errorRef.current?.focus();
		}
	}, [error]);

	// Opening removes the button that was pressed, so send focus to the line that says what happened.
	// Not to the remaining button: it dismisses this panel, and a held Enter would then throw the join
	// code away, which is the one thing this panel exists to prevent.
	//
	// Only when the press happened here. A member who opened the meeting from its card is reading the
	// list, and pulling their focus into this panel would take them away from it.
	useEffect(() => {
		if (isOpen && openedHereRef.current) {
			openedHereRef.current = false;
			openedNoticeRef.current?.focus();
		}
	}, [isOpen]);

	const handle_open = () => {
		// Same rule as the row actions: both buttons below stay enabled and report the wait with
		// `aria-busy`, because the browser blurs a focused control the moment it becomes disabled and
		// nothing puts that focus back. So this guard, not a disabled button, stops a second open.
		if (busy) {
			return;
		}
		setBusy(true);
		setError(null);
		props.api.open_meeting(props.created.meeting.id).then(
			(meeting) => {
				setBusy(false);
				openedHereRef.current = true;
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
			{/* The second sentence tells the member to press the Open button, so it comes and goes with
			    that button. In every other state there is nothing left to open, and the status line below
			    already says what happens next. */}
			<p className="panel-hint">
				Share both values with guests.{canOpen ? " Open the meeting when you are ready to admit them." : ""}
			</p>
			{error !== null ? (
				<p ref={errorRef} className="form-error" role="alert" tabIndex={-1}>
					{error}
				</p>
			) : null}
			{/* Only `open` really admits a guest holding this code. The service refuses a new join in every
			    other status, including `recording_start_unknown`, where the call keeps running for the
			    people already in it. */}
			{isOpen ? (
				<p ref={openedNoticeRef} className="panel-hint" role="status" tabIndex={-1}>
					The meeting is open. Guests can join it with the code above.
				</p>
			) : null}
			{/* Opening the meeting must not take the panel away with it. The service never stores the
			    plaintext join code, so this panel is its only copy, and a member who has not written it
			    down yet cannot invite anybody afterwards. Only "Done, I saved the invite" dismisses it. */}
			<div className="panel-actions">
				{canOpen ? (
					// Same rule as the row actions: name the meeting, because the card for this meeting
					// offers the same words while it is still waiting to be opened.
					<button
						type="button"
						className="button button-primary"
						aria-label={`Open meeting ${props.created.meeting.title}`}
						aria-busy={busy}
						onClick={handle_open}
					>
						{busy ? "Opening…" : "Open meeting"}
					</button>
				) : null}
				<button type="button" className="button button-quiet" onClick={props.onDismiss}>
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
	/**
	 * The meeting whose card must take focus on its own title, or null. `App` owns this instead of
	 * the row, because the row cannot always survive its own press: a close that settles straight to
	 * `ready` moves the card out of Active and into Recent, which unmounts this row and mounts a new
	 * one, and a ref inside the row would die with it.
	 */
	focusTitleMeetingId: string | null;
	onTitleFocused: () => void;
	/**
	 * The second argument says the press removed the button that was still holding the focus, so the
	 * card's title has to take it. See the effect below.
	 */
	onChanged: (meeting: CouncilMeeting, focusTitle: boolean) => void;
	/**
	 * The second argument says the settled delete removed the element that was still holding the
	 * focus, so the Meetings heading has to take it. See `handle_delete` below.
	 */
	onDeleted: (meeting: CouncilMeeting, focusHeading: boolean) => void;
};

function MeetingRow(props: MeetingRow_Props) {
	const { api, meeting, focusTitleMeetingId, onTitleFocused, onChanged, onDeleted } = props;
	const rootId = `MeetingRow-${useId()}`;
	const headingId = `${rootId}-heading`;
	const confirmDescriptionId = `${rootId}-delete-description`;
	const titleRef = useRef<HTMLHeadingElement | null>(null);
	const errorRef = useRef<HTMLParagraphElement | null>(null);
	const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
	const confirmDescriptionRef = useRef<HTMLParagraphElement | null>(null);
	const roomLinkNoticeRef = useRef<HTMLParagraphElement | null>(null);
	// Remember only that the press happened here, for the focus move below. A poll that drops the
	// link is not a press, and it must not move anybody's focus.
	const roomLinkPressedRef = useRef(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [roomUrl, setRoomUrl] = useState<string | null>(null);

	// The confirmation opens below the button that opened it, so move focus into it. Otherwise a
	// screen reader never reaches the warning before the member presses the next thing. Land on the
	// warning itself and never on Confirm delete: a <button> activates on Enter keydown, and the
	// keyboard repeats keydown while the key is held. So one resting finger would open this
	// confirmation and immediately confirm it, deleting the meeting and its saved files.
	useEffect(() => {
		if (confirmingDelete) {
			confirmDescriptionRef.current?.focus();
		}
	}, [confirmingDelete]);

	useEffect(() => {
		if (error !== null) {
			errorRef.current?.focus();
		}
	}, [error]);

	// The link arrives below a button that keeps its old words, so nothing on screen tells a keyboard
	// or screen-reader member that it is there. Send focus to the line that names it. That line is
	// also a status region, so the same sentence is the announcement, and the link itself is the next
	// stop from there.
	useEffect(() => {
		if (roomUrl === null || !roomLinkPressedRef.current) {
			return;
		}
		// Clear the press whether or not the focus moves, so cancelling the confirmation below never
		// runs this again and steals the focus that Cancel just put back on Delete.
		roomLinkPressedRef.current = false;
		// Not while the delete confirmation is open. Pressing Delete while this request was still in
		// the air already moved focus into that warning, and pulling the member out of it is how a
		// delete gets confirmed unread. The status region still announces the link.
		if (!confirmingDelete) {
			roomLinkNoticeRef.current?.focus();
		}
	}, [roomUrl, confirmingDelete]);

	// A room ticket is single-use and the service only mints one for a meeting that is still open.
	// A poll that reports any other status means the link on screen can no longer be used, so drop
	// it instead of leaving a dead link the member may still copy.
	useEffect(() => {
		if (meeting.status !== "open") {
			setRoomUrl(null);
		}
	}, [meeting.status]);

	// Closing a meeting, and opening one from its card, take away the button that was pressed. No
	// button lands in its place, so the focus it held would fall to the page body. Send it to this
	// card's own title. The meeting still has a card, so the member stays where they were reading,
	// and the next Tab from the title reaches whatever the new status left in the row. A settled
	// delete lands on the Meetings heading instead: its card stays up with a Deleting chip, but the
	// confirm block that was holding the focus unmounts, and the Deleting card keeps no button that
	// could take the focus over.
	//
	// `App` asks for this, and only for a press that was still holding the focus when the answer
	// arrived. A member can walk away while the request is in the air, into the create form or into
	// the delete warning below. Pulling them back here is what this must not do.
	useEffect(() => {
		if (focusTitleMeetingId !== meeting.id) {
			return;
		}
		onTitleFocused();
		titleRef.current?.focus();
	}, [focusTitleMeetingId, meeting.id, onTitleFocused]);

	/**
	 * Run one row action at a time. The row's buttons stay enabled and report the wait with
	 * `aria-busy`, because the browser blurs a focused control the moment it becomes disabled and
	 * nothing puts that focus back. So this guard, not a disabled button, is what stops a second
	 * press from starting the same action twice.
	 */
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

	const handle_delete = (event: MouseEvent<HTMLButtonElement>) => {
		// Read the card now, the way Open reads its button: React clears `currentTarget` once this
		// handler returns, and the check below runs after the request.
		const card = event.currentTarget.closest("li");
		run("delete", async () => {
			const status = await api.delete_meeting(meeting.id);
			// A settling delete moves this card to `deleting`, and that removes every control in the
			// row: the confirm block, and also the Delete button that Cancel may have put the focus
			// back on. So check the whole card, not only the pressed button, and read the focus now,
			// before the state change below unmounts anything. A member who walked away, into the
			// create form or another card, must not be pulled back.
			const focusHeading = card !== null && card.contains(document.activeElement);
			setConfirmingDelete(false);
			onDeleted({ ...meeting, status }, focusHeading);
		});
	};

	const labels = artifact_labels(meeting);

	return (
		<li className="meeting" data-meeting-id={meeting.id} aria-labelledby={headingId}>
			<div className="meeting-head">
				<div>
					<h4 ref={titleRef} id={headingId} className="meeting-title" tabIndex={-1}>
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
				{DEADLINE_STATUSES.has(meeting.status) && meeting.deadlineAt !== null ? (
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
				{/* The service writes `destinationPath` when the meeting is created and always sends it
				    back, but the folder is only created by the first upload. Name the path once a file
				    really lives there; otherwise the card sends the member to a folder Files does not
				    have. */}
				{meeting.destinationPath !== null && meeting.artifacts.length > 0 ? (
					<div className="meeting-destination">
						<dt>Saved to</dt>
						<dd>{meeting.destinationPath}</dd>
					</div>
				) : null}
			</dl>

			{/* A finished meeting with no artifacts at all is the no-recording settle: closing a meeting
			    that stored no recording id sends it straight to `ready` with nothing to process. Say that
			    much, or the card reads as a finished recording whose files went missing. Say no more than
			    that either. Council cannot tell "nobody pressed record" apart from "the provider answer to
			    Start recording was lost", and in that second case a recording may really be running on the
			    provider. The card must not tell the member that no recording was started. */}
			{meeting.recordingWarning ? (
				<p className="meeting-failure" role="status">
					{meeting.recordingWarning}
				</p>
			) : null}

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
			) : meeting.status === "ready" ? (
				<p className="meeting-progress">Council saved no files for this meeting.</p>
			) : null}

			{meeting.status === "failed" || meeting.status === "delete_failed" ? (
				meeting.failureReason ? (
					<p className="meeting-failure" role="status">
						{meeting.failureReason}
					</p>
				) : null
			) : null}

			{/* Neither status carries a `failureReason`, so the red chip alone would leave the member
			    guessing. The service lost a provider answer it never retries, and both cases need the
			    member to know that waiting will not help. */}
			{meeting.status === "create_unknown" ? (
				<p className="meeting-failure" role="status">
					Council did not get an answer when it created the room, so this meeting cannot be opened. Delete it and
					create a new meeting.
				</p>
			) : meeting.status === "recording_start_unknown" ? (
				<p className="meeting-failure" role="status">
					Council could not start the recording, so this meeting saves no files. The room stays up for the people
					already in it, and nobody else can join.
				</p>
			) : null}

			{/* The guest link is only the meeting id, so the card can rebuild it at any time. The join
			    code cannot be rebuilt: the service stores only its hash and has no route that issues a
			    new one. So the card says plainly that the code is gone, or a member who dismissed the
			    invite panel is left with a guest link nobody can use and no idea what to do. */}
			{meeting.status === "created" || meeting.status === "open" ? (
				<div className="meeting-guest">
					{/* Same rule as the row actions below: several cards repeat these words, so the copy
					    row carries this meeting's title in its accessible names. */}
					<CopyRow label="Guest link" value={`${COUNCIL_SERVICE_ORIGIN}/room?m=${meeting.id}`} subject={meeting.title} />
					<p className="panel-hint">
						Guests also need the join code. Council showed it once when this meeting was created and cannot show
						it again. Create a new meeting to get a new code.
					</p>
				</div>
			) : null}

			{/* Several cards show the same button words, so every row action carries its meeting title in
			    its accessible name. Without it a screen reader reads "Delete, Delete, Delete" and the
			    member cannot tell which meeting a press would destroy. */}
			<div className="meeting-actions">
				{meeting.status === "created" ? (
					<button
						type="button"
						className="button button-primary"
						aria-label={`Open meeting ${meeting.title}`}
						aria-busy={busy === "open"}
						onClick={(event) => {
							// Read the button now. React clears `currentTarget` once this handler returns, and
							// the check below runs after the request.
							const pressed = event.currentTarget;
							run("open", async () => {
								// An open meeting offers no Open button, so this press removes the button it
								// came from. Report whether it still holds the focus.
								onChanged(await api.open_meeting(meeting.id), document.activeElement === pressed);
							});
						}}
					>
						{busy === "open" ? "Opening…" : "Open meeting"}
					</button>
				) : null}
				{meeting.status === "open" ? (
					<button
						type="button"
						className="button button-primary"
						aria-label={`Get host room link ${meeting.title}`}
						aria-busy={busy === "room-link"}
						onClick={() =>
							run("room-link", async () => {
								const url = await api.room_ticket(meeting.id);
								roomLinkPressedRef.current = true;
								setRoomUrl(url);
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
						aria-label={`Close meeting ${meeting.title}`}
						aria-busy={busy === "close"}
						onClick={(event) => {
							// Read the button now, for the same reason as Open above.
							const pressed = event.currentTarget;
							run("close", async () => {
								const status = await api.close_meeting(meeting.id);
								setRoomUrl(null);
								// A closed meeting cannot be closed again, so this press removes the button it
								// came from. Report whether it still holds the focus.
								onChanged({ ...meeting, status }, document.activeElement === pressed);
							});
						}}
					>
						{busy === "close" ? "Closing…" : "Close meeting"}
					</button>
				) : null}
				{/* The service refuses a delete while the pipeline runs, and that refusal is true before
				    the button can be focused, so this one is really disabled. */}
				{meeting.status === "processing" ? (
					<button
						type="button"
						className="button button-quiet"
						aria-label={`Delete after processing ${meeting.title}`}
						disabled
					>
						Delete after processing
					</button>
				) : meeting.status !== "deleting" ? (
					<button
						ref={deleteButtonRef}
						type="button"
						className="button button-danger"
						aria-label={`Delete ${meeting.title}`}
						onClick={() => setConfirmingDelete(true)}
					>
						Delete
					</button>
				) : null}
			</div>

			{confirmingDelete ? (
				<div className="meeting-confirm">
					{/* Name the meeting here: this paragraph is the confirm button's description, and it is
					    the only place that says which meeting the press destroys. A meeting that saved
					    nothing has no folder either, so promise only what the delete really archives. */}
					<p ref={confirmDescriptionRef} id={confirmDescriptionId} tabIndex={-1}>
						Delete {meeting.title}? Any files Council saved for it move to the Files archive, where a member can restore
						them.
					</p>
					{/* These two follow the same rule as the row actions above: they stay enabled and report
					    the wait with `aria-busy`, and `run` refuses a second press. Disabling them would blur
					    whichever one holds focus and leave a keyboard member on the page body, with no way to
					    cancel, for the whole round-trip. */}
					<div className="panel-actions">
						<button
							type="button"
							className="button button-danger"
							aria-describedby={confirmDescriptionId}
							aria-busy={busy === "delete"}
							onClick={handle_delete}
						>
							{busy === "delete" ? "Deleting…" : "Confirm delete"}
						</button>
						<button
							type="button"
							className="button button-quiet"
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
					{/* This sentence comes before the link, not after it. It is the focus target above, so
					    from here the next Tab reaches the link and then its Copy button. Behind the link the
					    member would have to walk backwards to reach the value they just asked for. */}
					<p ref={roomLinkNoticeRef} className="panel-hint" role="status" tabIndex={-1}>
						Copy this single-use link and open it in a new browser tab.
					</p>
					<CopyRow label="Host room link" value={roomUrl} subject={meeting.title} />
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
	focusTitleMeetingId: string | null;
	onTitleFocused: () => void;
	onChanged: (meeting: CouncilMeeting, focusTitle: boolean) => void;
	onDeleted: (meeting: CouncilMeeting, focusHeading: boolean) => void;
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
						focusTitleMeetingId={props.focusTitleMeetingId}
						onTitleFocused={props.onTitleFocused}
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
	// Only a refresh the member asked for says so on screen. The 5-second poll runs the same
	// `refresh`, and a status line that is inserted and removed every 5 seconds for as long as the tab
	// stays open is noise the member has no control to stop.
	//
	// The two Retry buttons read this for the same reason. They are the only buttons on this page
	// whose wait is not a press of their own, so a poll would otherwise mark them busy, dim them, and
	// rename them on a timer.
	const [isMemberRefreshing, setIsMemberRefreshing] = useState(false);
	const [created, setCreated] = useState<CouncilCreatedMeeting | null>(null);
	const [announcement, setAnnouncement] = useState({ sequence: 0, text: "" });
	// Single-flight guard for the list refresh, plus one remembered follow-up. A row action finishes
	// its own refresh while a poll is still in the air, and a ref is the only value both the running
	// refresh and the next caller read without waiting for a render.
	const refreshingRef = useRef(false);
	const refreshQueuedRef = useRef(false);
	const meetingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
	const newMeetingHeadingRef = useRef<HTMLHeadingElement | null>(null);
	// The list as the member was last told about it. Only a comparison against the next list can say
	// that a meeting settled or disappeared, and this must not force the render that reads it.
	const announcedMeetingsRef = useRef<CouncilMeeting[] | null>(null);
	const [focusNewMeetingAfterPanel, setFocusNewMeetingAfterPanel] = useState(false);
	// Only a Retry press sets this. The 5-second poll calls the same `refresh`, and a poll that
	// succeeds must never move the focus of a member who is reading or typing somewhere else.
	const [focusMeetingsAfterRetry, setFocusMeetingsAfterRetry] = useState(false);
	// The card that has to take focus on its own title, because the press that just settled removed
	// the button holding it. Kept here and not inside the card, because a close that settles straight
	// to `ready` moves the card from Active to Recent, and that unmounts the card that was pressed.
	const [focusTitleMeetingId, setFocusTitleMeetingId] = useState<string | null>(null);

	// The default is the refresh nobody asked for: the first load, the poll, and the reload every row
	// action runs. Only a Retry press passes "member".
	const refresh = useCallback((trigger: "member" | "background" = "background") => {
		// Set this before the single-flight guard below. A Retry that lands while a poll is still in
		// the air is queued behind it, and the member is still waiting for that queued run.
		if (trigger === "member") {
			setIsMemberRefreshing(true);
		}
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
					// Skip the very first load. The meetings already there are not a change the member
					// should hear read out.
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
				setIsMemberRefreshing(false);
			});
	}, [api]);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// This page has no live subscription to the Council service, so it polls. Keep polling after every
	// meeting settles: a meeting another member creates has to appear here without a reload too.
	useEffect(() => {
		const timer = setInterval(refresh, 5_000);
		return () => clearInterval(timer);
	}, [refresh]);

	// Move focus only after the invite panel is really gone, because the New meeting heading it must
	// land on is only rendered once the panel unmounts.
	useEffect(() => {
		if (created !== null || !focusNewMeetingAfterPanel) {
			return;
		}
		newMeetingHeadingRef.current?.focus();
		setFocusNewMeetingAfterPanel(false);
	}, [created, focusNewMeetingAfterPanel]);

	// Move focus only once the retry has really settled, because the Retry button the member pressed
	// unmounts together with the alert and focus would otherwise fall to the page body.
	//
	// Land on the Meetings heading. The list the member was trying to reach starts there, so a screen
	// reader reads the heading and then walks straight into the cards that just arrived. A finished
	// delete already sends focus to the same heading, so recovering from an error and finishing a
	// delete leave the member in the same place. The first card is the wrong target: a failed refresh
	// left the old cards untouched, and a failed first load can settle to an empty list with no card
	// at all.
	//
	// A retry that fails again keeps its own alert and its own button, so leave that focus alone.
	useEffect(() => {
		if (isRefreshing || !focusMeetingsAfterRetry) {
			return;
		}
		if (listError === null) {
			meetingsHeadingRef.current?.focus();
		}
		setFocusMeetingsAfterRetry(false);
	}, [isRefreshing, listError, focusMeetingsAfterRetry]);

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
	// Only a card's Open and Close reach this, and both take away the button that was pressed. When
	// that button was still holding the focus, the card says so and its title takes the focus over;
	// the card runs that move itself, because only it knows its own heading.
	const handle_changed = (meeting: CouncilMeeting, focusTitle: boolean) => {
		merge_meeting(meeting);
		if (focusTitle) {
			setFocusTitleMeetingId(meeting.id);
		}
		refresh();
	};
	// Clear the request as soon as a card has taken it. The same meeting gets a new card later. The
	// poll that moves it from Active to Recent when processing finishes builds one, and a request
	// left standing would pull the member's focus back into it.
	const handle_title_focused = useCallback(() => setFocusTitleMeetingId(null), []);
	// `refreshingRef` stops a second press from starting a second request straight away. It does not
	// throw the press away: `refresh` remembers it and runs it once the request already in the air
	// finishes. So a second press is queued behind that run, never lost, and the queued run clears the
	// member spinner when it settles. That queue, not a disabled button, is what makes the two Retry
	// buttons safe to leave enabled.
	const handle_retry = () => {
		setFocusMeetingsAfterRetry(true);
		refresh("member");
	};
	// A settling delete unmounts the confirm block, and its Deleting card keeps no button that could
	// take the focus over, so the Meetings heading takes it — but only when the card says the focus
	// was still inside it. A member who walked away while the request was in the air stays where
	// they are.
	const handle_deleted = (meeting: CouncilMeeting, focusHeading: boolean) => {
		merge_meeting(meeting);
		if (focusHeading) {
			meetingsHeadingRef.current?.focus();
		}
		refresh();
	};

	return (
		<div className="council">
			{/* No "New meeting" jump link here. The create form is sticky, so on a wide screen it never
			    leaves the viewport, and below 820px it is the first thing under this header. The link
			    pointed at a form that was already on screen: it scrolled this heading away, dropped focus
			    on the page body, and repeated the name of the heading right below it. */}
			<header className="council-header">
				<p className="section-kicker">Workspace meeting room</p>
				<h1>Council</h1>
				<p className="council-tagline">
					Create a call, invite guests, and keep the recording and notes with your files.
				</p>
			</header>

			<main className="council-layout">
				<aside className="council-compose">
					{created !== null ? (
						<CreatedMeetingPanel
							api={api}
							created={created}
							// The merged list is the one place that knows this meeting's real status, whichever of
							// the two Open buttons was pressed. `onCreated` merges the meeting into the list before
							// it opens this panel, so a meeting missing here has left the list: its delete finished.
							// Pass null then. The panel offers no Open button for a meeting the service already
							// destroyed, and it never disagrees with the cards next to it.
							status={meetings?.find((meeting) => meeting.id === created.meeting.id)?.status ?? null}
							onDismiss={() => {
								setFocusNewMeetingAfterPanel(true);
								setCreated(null);
							}}
							onOpened={(meeting) => {
								merge_meeting(meeting);
								refresh();
							}}
						/>
					) : (
						<section className="council-create" aria-labelledby={`${newMeetingId}-heading`}>
							<p className="section-kicker">Start here</p>
							<h2 ref={newMeetingHeadingRef} id={`${newMeetingId}-heading`} tabIndex={-1}>
								New meeting
							</h2>
							{/* Name the files as the read-only part, never the folder. The service upload locks only the
							    file it creates: it points that file's own read-only scope at itself, and it cannot lock
							    the folder around it. A member who read "read-only meeting folder" could drop their own
							    notes in there and believe the folder was protecting them. */}
							<p className="create-copy">
								When recording is started, Council saves its tracks, transcript, summary, and provider transcript as
								read-only files in the meeting folder.
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
					{/* This is the page's one piece of persistent wayfinding, so it names the path and the next
					    step. It used to explain the plugin frame sandbox instead, which tells a workspace
					    member nothing they can act on. */}
					<div className="files-callout">
						<strong>Find finished files in Files</strong>
						<span>
							Council saves the files for each meeting under /meetings in Files. Open Files in another tab to
							reach them.
						</span>
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
						{isMemberRefreshing && meetings !== null ? (
							<span className="refreshing-label" role="status">
								Refreshing…
							</span>
						) : null}
					</div>

					{listError !== null && meetings !== null ? (
						<div className="refresh-error" role="alert">
							<span>Could not refresh: {listError}</span>
							{/* Same rule as every other action on this page: the button stays enabled and reports the
							    wait with `aria-busy`. Disabling it would blur the member who just pressed it and drop
							    them on the page body for the whole round-trip, with the error still on screen.

							    Read `isMemberRefreshing`, not `isRefreshing`. The 5 second poll runs the same request,
							    and this alert stays on screen for as long as Council keeps failing. So `isRefreshing`
							    would mark this button busy every 5 seconds for a wait nobody started, and `council.css`
							    would dim it and the label below would change with it. A press that lands during a poll
							    is queued rather than dropped, so the button must not look unpressable then either.

							    Say the wait in words as well, the way every other action here does. `council.css` dims a
							    busy button; the label is what a member reads. */}
							<button
								type="button"
								className="button button-quiet"
								aria-busy={isMemberRefreshing}
								onClick={handle_retry}
							>
								{isMemberRefreshing ? "Retrying…" : "Retry"}
							</button>
						</div>
					) : null}

					{meetings === null ? (
						listError !== null ? (
							<div className="council-status is-error" role="alert">
								<span>{listError}</span>
								{/* Enabled and labelled while busy for the same reasons as the refresh error above. Here
								    the label carries the whole answer on its own: the "Refreshing…" line needs a list to
								    stand beside, and a first load that failed left none, so nothing else on this screen
								    changes for the whole round-trip. */}
								<button
									type="button"
									className="button button-quiet"
									aria-busy={isMemberRefreshing}
									onClick={handle_retry}
								>
									{isMemberRefreshing ? "Retrying…" : "Retry"}
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
								focusTitleMeetingId={focusTitleMeetingId}
								onTitleFocused={handle_title_focused}
								onChanged={handle_changed}
								onDeleted={handle_deleted}
							/>
							<MeetingGroup
								title="Recent"
								meetings={recentMeetings}
								api={api}
								focusTitleMeetingId={focusTitleMeetingId}
								onTitleFocused={handle_title_focused}
								onChanged={handle_changed}
								onDeleted={handle_deleted}
							/>
						</div>
					)}
				</section>
			</main>

			{/* A live region stays silent when the new text equals the old text, and two polls can report
			    the same change wording. The counter changes every time, so the region always has something
			    new to read; `aria-hidden` keeps the number itself out of what the member hears. */}
			<div className="council-announcer visually-hidden" role="status" aria-live="polite">
				<span aria-hidden="true" data-announcement-sequence={String(announcement.sequence)}>
					{announcement.sequence}
				</span>
				{announcement.text !== "" ? ` ${announcement.text}` : ""}
			</div>
		</div>
	);
}
