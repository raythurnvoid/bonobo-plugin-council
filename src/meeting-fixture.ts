/**
 * One meeting fixture, shaped like the meeting the Council service sends.
 *
 * The dashboard preview and the dashboard tests both need meeting rows. They used to build them
 * with two separate `meeting()` helpers whose second and third arguments were swapped, and all
 * three arguments were plain strings. Copying a fixture line from one file into the other — exactly
 * what you do when you turn a preview state into a test — then swapped title and status with no
 * type error and no failure: `status_label` falls back to the raw word, so the title rendered as
 * the status chip. So there is one builder here, and `status` only accepts a status the dashboard
 * has a label for, which makes a swapped call fail to compile.
 *
 * Only `preview.tsx` and the tests import this module. Neither is reachable from `index.html`, so
 * nothing here reaches the published bundle.
 */

import type { CouncilMeeting } from "./council-api";

/** The clock every fixture is relative to, so preview cards and test cards read the same way. */
export const FIXTURE_NOW = Date.UTC(2026, 7, 22, 10, 30);

/** The statuses `STATUS_LABELS` in `app.tsx` has words for. A status outside it is a typo. */
type MeetingFixtureStatus =
	| "created"
	| "create_unknown"
	| "open"
	| "recording_start_unknown"
	| "closed"
	| "processing"
	| "ready"
	| "failed"
	| "expired"
	| "deleting"
	| "delete_failed";

export function meeting(
	id: string,
	title: string,
	status: MeetingFixtureStatus,
	overrides: Partial<CouncilMeeting> = {},
): CouncilMeeting {
	return {
		id,
		title,
		status,
		createdAt: FIXTURE_NOW - 3_600_000,
		openedAt: status === "created" ? null : FIXTURE_NOW - 3_000_000,
		closedAt: ["ready", "failed", "processing", "closed"].includes(status) ? FIXTURE_NOW - 1_200_000 : null,
		deadlineAt: status === "open" ? FIXTURE_NOW + 2_400_000 : null,
		participantCount: status === "created" ? 0 : 4,
		maxParticipants: 25,
		destinationPath: `/meetings/${id}`,
		failureReason: null,
		recordingWarning: null,
		artifacts: [],
		...overrides,
	};
}
