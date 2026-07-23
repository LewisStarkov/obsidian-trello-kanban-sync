import { KanbanSettingsBlock, OrphanedCardBehavior, TrelloCard, TrelloLabel, TrelloList } from "./types";
import { slugifyTag } from "./util/filenames";

export interface Lane {
	listId: string;
	name: string;
	cards: TrelloCard[];
}

// Synthetic id for the catch-all lane holding cards whose Trello list was
// archived but the card itself wasn't, Trello's cards-by-board endpoint
// still returns these as "open", so without this they'd silently vanish
// from the board instead of just being hidden the way Trello itself hides them.
export const ARCHIVE_LANE_ID = "__orphaned_archive__";
const ARCHIVE_LANE_NAME = "Archived";

export function buildLanes(
	lists: TrelloList[],
	cards: TrelloCard[],
	orphanedCardBehavior: OrphanedCardBehavior
): Lane[] {
	const openLists = lists.filter((list) => !list.closed);
	const openListIds = new Set(openLists.map((list) => list.id));

	const cardsByList = new Map<string, TrelloCard[]>();
	const orphaned: TrelloCard[] = [];
	for (const card of cards) {
		if (card.closed) continue;
		if (openListIds.has(card.idList)) {
			const bucket = cardsByList.get(card.idList) ?? [];
			bucket.push(card);
			cardsByList.set(card.idList, bucket);
		} else if (orphanedCardBehavior === "archive-lane") {
			orphaned.push(card);
		}
	}
	for (const bucket of cardsByList.values()) {
		bucket.sort((a, b) => a.pos - b.pos);
	}
	orphaned.sort((a, b) => a.pos - b.pos);

	const lanes: Lane[] = openLists.map((list) => ({
		listId: list.id,
		name: list.name,
		cards: cardsByList.get(list.id) ?? [],
	}));

	if (orphanedCardBehavior === "archive-lane" && orphaned.length > 0) {
		lanes.push({ listId: ARCHIVE_LANE_ID, name: ARCHIVE_LANE_NAME, cards: orphaned });
	}

	return lanes;
}

/**
 * list-collapse is index-aligned to the *current* lane order. To carry a
 * lane's collapsed state across reorders/additions/removals, look up each
 * current list id in the previously-rendered order and copy its old boolean;
 * anything not seen before (new list) defaults to false. Lists that vanished
 * are simply absent from currentListIds, so their entries are dropped for free.
 */
export function buildListCollapse(
	currentListIds: string[],
	lastKnownListOrder: string[] | undefined,
	existingCollapse: boolean[] | undefined
): boolean[] {
	return currentListIds.map((id) => {
		if (!lastKnownListOrder || !existingCollapse) return false;
		const oldIndex = lastKnownListOrder.indexOf(id);
		if (oldIndex === -1) return false;
		return existingCollapse[oldIndex] ?? false;
	});
}

export function mergeSettingsBlock(
	existing: KanbanSettingsBlock | null,
	listCollapse: boolean[]
): KanbanSettingsBlock {
	const base: KanbanSettingsBlock = existing ? { ...existing } : { "kanban-plugin": "board" };
	base["list-collapse"] = listCollapse;
	return base;
}

// ISO 8601 datetime -> YYYY-MM-DD. obsidian-kanban's actual date-display
// format is user/file configurable (moment.js format string), this default
// covers the common case; verify against https://publish.obsidian.md/kanban
// if a file's settings block ever carries a custom "date-format".
function formatDue(due: string): string {
	return due.slice(0, 10);
}

function labelsToTags(labels: TrelloLabel[]): string[] {
	const seen = new Set<string>();
	for (const label of labels) {
		if (!label.name) continue;
		const slug = slugifyTag(label.name);
		if (slug) seen.add(slug);
	}
	return Array.from(seen);
}

function renderCardLine(card: TrelloCard, opts: RenderOptions): string {
	let line = `- [ ] ${card.name}`;
	if (opts.renderDueDates && card.due) {
		line += ` @{${formatDue(card.due)}}`;
	}
	if (opts.renderLabelsAsTags && card.labels.length > 0) {
		for (const tag of labelsToTags(card.labels)) {
			line += ` #${tag}`;
		}
	}
	if (opts.renderCardLinks && card.shortLink) {
		line += ` [↗](https://trello.com/c/${card.shortLink})`;
	}
	// Hidden identity marker, always emitted regardless of two-way sync being
	// on, this is what lets two-way sync recognize "this line is still card
	// X" the moment it's turned on, without a separate first-run migration.
	line += ` %%tid:${card.id}%%`;
	return line;
}

export interface RenderOptions {
	renderDueDates: boolean;
	renderLabelsAsTags: boolean;
	renderCardLinks: boolean;
}

export function renderBoardMarkdown(
	lanes: Lane[],
	settings: KanbanSettingsBlock,
	opts: RenderOptions,
	extraContentByCardId: Map<string, string[]> = new Map()
): string {
	const parts: string[] = ["---", "", "kanban-plugin: board", "", "---", ""];

	for (const lane of lanes) {
		const heading = lane.listId === ARCHIVE_LANE_ID ? `## ${lane.name}` : `## ${lane.name} %%lid:${lane.listId}%%`;
		parts.push(heading);
		parts.push("");
		for (const card of lane.cards) {
			parts.push(renderCardLine(card, opts));
			const extra = extraContentByCardId.get(card.id);
			if (extra) {
				parts.push(...extra);
			}
		}
		parts.push("");
		parts.push("");
	}

	parts.push("");
	parts.push("%% kanban:settings");
	parts.push("```");
	parts.push(JSON.stringify(settings));
	parts.push("```");
	parts.push("%%");
	parts.push("");

	return parts.join("\n");
}
