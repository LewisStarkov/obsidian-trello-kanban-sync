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
		const parsed = JSON.parse(jsonText);
		if (parsed && typeof parsed === "object" && typeof parsed["kanban-plugin"] === "string") {
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

export interface ParsedCard {
	cardId: string | null;
	name: string;
	hasExtraContent: boolean;
	rawLines: string[];
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
const DUE_SUFFIX = /\s*@\{[^}]*\}\s*$/;
const CHECKBOX_LINE = /^-\s*\[[ xX]\]\s*(.*)$/;

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

		const checkboxMatch = trimmed.match(CHECKBOX_LINE);
		if (checkboxMatch && currentLane) {
			const { name, cardId } = stripCardSuffixes(checkboxMatch[1]);
			currentCard = { cardId, name, hasExtraContent: false, rawLines: [line] };
			currentLane.cards.push(currentCard);
			continue;
		}

		// A non-empty, indented line right after a card belongs to that card as
		// extra body content (Kanban supports multi-line cards), such cards are
		// opted out of two-way sync entirely rather than risk mangling free text.
		if (currentCard && trimmed.length > 0 && /^\s/.test(line)) {
			currentCard.hasExtraContent = true;
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
