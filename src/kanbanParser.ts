import { KanbanSettingsBlock } from "./types";

const SETTINGS_MARKER = "%% kanban:settings";
const CLOSE_MARKER = "%%";
const FENCE = "```";

/**
 * Line-scan (not a monolithic regex) so a card whose text happens to contain
 * "%%" or "```" doesn't corrupt the match, we only trust an exact-match
 * marker line, then expect a fenced block immediately after it.
 */
export function extractSettingsBlock(fileContent: string): KanbanSettingsBlock | null {
	const lines = fileContent.split("\n");

	let markerIndex = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === SETTINGS_MARKER) {
			markerIndex = i;
			break;
		}
	}
	if (markerIndex === -1) return null;

	let fenceStart = -1;
	for (let i = markerIndex + 1; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		if (lines[i].trim() === FENCE) fenceStart = i;
		break;
	}
	if (fenceStart === -1) return null;

	let fenceEnd = -1;
	for (let i = fenceStart + 1; i < lines.length; i++) {
		if (lines[i].trim() === FENCE) {
			fenceEnd = i;
			break;
		}
	}
	if (fenceEnd === -1) return null;

	let closeFound = false;
	for (let i = fenceEnd + 1; i < lines.length; i++) {
		if (lines[i].trim() === "") continue;
		closeFound = lines[i].trim() === CLOSE_MARKER;
		break;
	}
	if (!closeFound) return null;

	const jsonText = lines.slice(fenceStart + 1, fenceEnd).join("\n");
	try {
		const parsed: unknown = JSON.parse(jsonText);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as Record<string, unknown>)["kanban-plugin"] === "string"
		) {
			return parsed as KanbanSettingsBlock;
		}
		return null;
	} catch {
		return null;
	}
}

const CONFLICT_MARKERS = ["<<<<<<<", "=======", ">>>>>>>"];

/**
 * Cheap guard against reconciling a mid-merge or mid-save-truncated file.
 * Deliberately a plain substring check on trimmed lines, not clever parsing.
 * A false positive here just skips a cycle harmlessly; a false negative could
 * mean pushing garbage to Trello.
 */
export function hasConflictMarkers(fileContent: string): boolean {
	return fileContent.split("\n").some((line) => CONFLICT_MARKERS.some((marker) => line.trim().startsWith(marker)));
}

export interface ParsedCheckItem {
	id: string;
	checked: boolean;
}

export interface ParsedCard {
	cardId: string | null;
	name: string;
	hasExtraContent: boolean;
	rawLines: string[];
	checkItems: ParsedCheckItem[];
}

export interface ParsedLane {
	listId: string | null;
	name: string;
	cards: ParsedCard[];
}

const LID_SUFFIX = /\s*%%lid:([A-Za-z0-9_-]+)%%\s*$/;
const TID_SUFFIX = /\s*%%tid:([A-Za-z0-9_-]+)%%\s*$/;
const CARD_LINK_SUFFIX = /\s*\[↗\]\(https:\/\/trello\.com\/c\/[A-Za-z0-9]+\)\s*$/;
const TAG_SUFFIX = /\s*#[^\s#]+\s*$/;
const MEMBER_SUFFIX = /\s*@[^\s@]+\s*$/;
const DUE_SUFFIX = /\s*@\{[^}]*\}\s*$/;
const CHECKBOX_LINE = /^-\s*\[[ xX]\]\s*(.*)$/;

// Appended to every description/checklist line the plugin itself renders
// under a card, so a rendered-from-Trello body line can be told apart from a
// line the user typed by hand, see the extra-content branch in
// parseBoardMarkdown below. Trello-owned lines never opt a card out of
// two-way sync (they're regenerated fresh every cycle anyway, never a stale
// value to accidentally push); hand-typed lines still do. A checklist item's
// marker additionally carries its Trello checkItem id (":ciid:<id>"), so its
// checked state can be pushed back to Trello, that's the one part of
// Trello-owned content that's genuinely two-way, see reconcileBoard.
export const TRELLO_LINE_MARKER = "%%trello%%";
export function trelloChecklistItemMarker(checkItemId: string): string {
	return `%%trello:ciid:${checkItemId}%%`;
}
export const TRELLO_LINE_MARKER_SUFFIX = /\s*%%trello(?::ciid:([A-Za-z0-9_-]+))?%%\s*$/;
const INDENTED_CHECKBOX_PREFIX = /^-\s*\[([ xX])\]/;

function stripCardSuffixes(rawText: string): { name: string; cardId: string | null } {
	let text = rawText;

	let cardId: string | null = null;
	const tidMatch = text.match(TID_SUFFIX);
	if (tidMatch) {
		cardId = tidMatch[1];
		text = text.slice(0, tidMatch.index).trimEnd();
	}

	const linkMatch = text.match(CARD_LINK_SUFFIX);
	if (linkMatch) {
		text = text.slice(0, linkMatch.index).trimEnd();
	}

	// Members are emitted as zero or more trailing "@username" tokens, strip
	// repeatedly, before tags/due so a due date's "@{...}" token (stripped
	// last, see below) is never mistaken for a member token.
	let memberMatch = text.match(MEMBER_SUFFIX);
	while (memberMatch) {
		text = text.slice(0, memberMatch.index).trimEnd();
		memberMatch = text.match(MEMBER_SUFFIX);
	}

	// Tags are emitted as zero or more trailing "#tag" tokens, strip repeatedly.
	let tagMatch = text.match(TAG_SUFFIX);
	while (tagMatch) {
		text = text.slice(0, tagMatch.index).trimEnd();
		tagMatch = text.match(TAG_SUFFIX);
	}

	const dueMatch = text.match(DUE_SUFFIX);
	if (dueMatch) {
		text = text.slice(0, dueMatch.index).trimEnd();
	}

	return { name: text.trim(), cardId };
}

/**
 * Parses the lane/card body of a rendered board note back into structured
 * data, for the two-way-sync diff. Line-scan in the same defensive style as
 * extractSettingsBlock: only the region between the frontmatter's closing
 * "---" and the trailing "%% kanban:settings" marker is considered, so the
 * settings JSON blob (or anything a card's text coincidentally contains) can
 * never be misread as lane/card structure.
 */
export function parseBoardMarkdown(fileContent: string): ParsedLane[] {
	const lines = fileContent.split("\n");

	let bodyStart = 0;
	if (lines[0]?.trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				bodyStart = i + 1;
				break;
			}
		}
	}

	let bodyEnd = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim() === SETTINGS_MARKER) {
			bodyEnd = i;
			break;
		}
	}

	const lanes: ParsedLane[] = [];
	let currentLane: ParsedLane | null = null;
	let currentCard: ParsedCard | null = null;

	for (let i = bodyStart; i < bodyEnd; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed.startsWith("## ")) {
			const headingText = trimmed.slice(3);
			const lidMatch = headingText.match(LID_SUFFIX);
			const name = lidMatch ? headingText.slice(0, lidMatch.index).trimEnd() : headingText;
			currentLane = { listId: lidMatch ? lidMatch[1] : null, name, cards: [] };
			lanes.push(currentLane);
			currentCard = null;
			continue;
		}

		// Only an unindented line can start a new card, an indented line that
		// happens to look like a checkbox (e.g. a rendered checklist item, or
		// any user-typed nested checkbox) belongs to the card above it instead,
		// see the extra-content branch below. Without this, such a line would
		// be misread as a new sibling card and two-way sync would try to create
		// a real Trello card out of it.
		const isIndented = /^\s/.test(line);
		const checkboxMatch = !isIndented ? trimmed.match(CHECKBOX_LINE) : null;
		if (checkboxMatch && currentLane) {
			const { name, cardId } = stripCardSuffixes(checkboxMatch[1]);
			currentCard = { cardId, name, hasExtraContent: false, rawLines: [line], checkItems: [] };
			currentLane.cards.push(currentCard);
			continue;
		}

		// A non-empty, indented line right after a card belongs to that card as
		// extra body content (Kanban supports multi-line cards). A line the
		// plugin itself rendered from a Trello description/checklist (tagged
		// with TRELLO_LINE_MARKER) is exempt from the opt-out below, only a
		// hand-typed line still opts the card out of two-way sync entirely,
		// rather than risk mangling free text. A checklist item line also
		// carries its checkItem id, extracted so its checked state can be
		// diffed against Trello, see reconcileBoard.
		if (currentCard && trimmed.length > 0 && isIndented) {
			const markerMatch = trimmed.match(TRELLO_LINE_MARKER_SUFFIX);
			if (!markerMatch) {
				currentCard.hasExtraContent = true;
			} else if (markerMatch[1]) {
				const itemCheckboxMatch = trimmed.match(INDENTED_CHECKBOX_PREFIX);
				if (itemCheckboxMatch) {
					currentCard.checkItems.push({ id: markerMatch[1], checked: itemCheckboxMatch[1] !== " " });
				}
			}
			currentCard.rawLines.push(line);
			continue;
		}

		if (trimmed.length > 0) {
			// Blank-line-separated content that isn't a heading/card/continuation
			// (e.g. stray text), stop treating subsequent indented lines as
			// belonging to the last card.
			currentCard = null;
		}
	}

	return lanes;
}
