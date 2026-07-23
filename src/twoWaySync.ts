import {
	createCard,
	createList,
	updateCard,
	updateList,
} from "./trelloClient";
import { ParsedLane } from "./kanbanParser";
import { BoardSnapshot, BoardSyncConfig, PendingCreate, TrelloCard, TrelloList } from "./types";

// Defense in depth on top of the "ambiguity never resolves to archive" rule:
// even a fully-unambiguous diff is capped at this many archives per board per
// cycle, so a genuinely corrupted/truncated file can't nuke a whole board in
// one 5s tick. Extra archives are simply deferred to the next cycle.
const MAX_ARCHIVES_PER_CYCLE = 3;
// If the local file suddenly has far fewer cards than the last known-good
// snapshot, treat it as a truncated/mid-save file rather than a bulk delete.
const MASS_EMPTY_MIN_BASE_SIZE = 4;
const MASS_EMPTY_RATIO = 0.5;

export interface ReconcileResult {
	mutated: boolean;
	extraContentByCardId: Map<string, string[]>;
	log: string[];
}

interface Ctx {
	board: BoardSyncConfig;
	base: BoardSnapshot;
	remoteLists: TrelloList[];
	remoteCards: TrelloCard[];
	boardId: string;
	apiKey: string;
	apiToken: string;
	saveSettings: () => Promise<void>;
}

function buildLocalIndexes(localLanes: ParsedLane[]) {
	const localListsById = new Map<string, { name: string }>();
	const localCardsById = new Map<string, { name: string; idList: string | null }>();
	const duplicateListIds = new Set<string>();
	const duplicateCardIds = new Set<string>();
	const newLanes: { name: string; laneIndex: number }[] = [];
	const newCardsByLaneIndex = new Map<number, { name: string }[]>();

	localLanes.forEach((lane, laneIndex) => {
		if (lane.listId) {
			if (localListsById.has(lane.listId)) duplicateListIds.add(lane.listId);
			localListsById.set(lane.listId, { name: lane.name });
		} else {
			newLanes.push({ name: lane.name, laneIndex });
		}

		for (const card of lane.cards) {
			if (card.hasExtraContent) continue; // opted out of two-way sync entirely
			if (card.cardId) {
				if (localCardsById.has(card.cardId)) duplicateCardIds.add(card.cardId);
				localCardsById.set(card.cardId, { name: card.name, idList: lane.listId });
			} else {
				const bucket = newCardsByLaneIndex.get(laneIndex) ?? [];
				bucket.push({ name: card.name });
				newCardsByLaneIndex.set(laneIndex, bucket);
			}
		}
	});

	return { localListsById, localCardsById, duplicateListIds, duplicateCardIds, newLanes, newCardsByLaneIndex };
}

export function extraContentMap(localLanes: ParsedLane[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const lane of localLanes) {
		for (const card of lane.cards) {
			if (card.hasExtraContent && card.cardId) {
				map.set(card.cardId, card.rawLines.slice(1));
			}
		}
	}
	return map;
}

async function findOrCreatePendingCard(
	ctx: Ctx,
	pendingList: PendingCreate[],
	localKey: string,
	idList: string
): Promise<string> {
	const existing = pendingList.find((p) => p.localKey === localKey);
	if (existing) return existing.trelloId;

	const created = await createCard(localKey, idList, ctx.apiKey, ctx.apiToken);
	pendingList.push({ localKey, trelloId: created.id, createdAt: Date.now() });
	await ctx.saveSettings();
	return created.id;
}

async function findOrCreatePendingList(ctx: Ctx, pendingList: PendingCreate[], localKey: string): Promise<string> {
	const existing = pendingList.find((p) => p.localKey === localKey);
	if (existing) return existing.trelloId;

	const created = await createList(localKey, ctx.boardId, ctx.apiKey, ctx.apiToken);
	pendingList.push({ localKey, trelloId: created.id, createdAt: Date.now() });
	await ctx.saveSettings();
	return created.id;
}

export async function reconcileBoard(
	localLanes: ParsedLane[],
	base: BoardSnapshot,
	remoteLists: TrelloList[],
	remoteCards: TrelloCard[],
	board: BoardSyncConfig,
	boardId: string,
	apiKey: string,
	apiToken: string,
	saveSettings: () => Promise<void>
): Promise<ReconcileResult> {
	const ctx: Ctx = { board, base, remoteLists, remoteCards, boardId, apiKey, apiToken, saveSettings };
	const messages: string[] = [];
	let mutated = false;

	const remoteListsById = new Map(remoteLists.map((l) => [l.id, l]));
	const remoteCardsById = new Map(remoteCards.map((c) => [c.id, c]));

	const { localListsById, localCardsById, duplicateListIds, duplicateCardIds, newLanes, newCardsByLaneIndex } =
		buildLocalIndexes(localLanes);

	if (duplicateListIds.size > 0 || duplicateCardIds.size > 0) {
		messages.push(
			`Duplicate identity markers found (lists: ${[...duplicateListIds].join(", ") || "none"}, cards: ${
				[...duplicateCardIds].join(", ") || "none"
			}), freezing pushes for those ids this cycle.`
		);
	}

	// Mass-emptying guard: abstain from ALL archives this cycle if the file
	// looks truncated rather than intentionally trimmed.
	const totalLocalCards = [...localCardsById.keys()].length;
	const baseOpenCardCount = base.cards.filter((c) => !c.closed).length;
	const abstainFromArchiving =
		baseOpenCardCount >= MASS_EMPTY_MIN_BASE_SIZE && totalLocalCards < baseOpenCardCount * MASS_EMPTY_RATIO;
	if (abstainFromArchiving) {
		messages.push(
			`Local file has far fewer cards (${totalLocalCards}) than the last known state (${baseOpenCardCount}), treating this as a possible truncated/mid-save file and skipping all archives this cycle.`
		);
	}

	let archivesThisCycle = 0;

	// ---- Lists: rename / archive ----
	for (const baseList of base.lists) {
		if (duplicateListIds.has(baseList.id)) continue;
		const remoteList = remoteListsById.get(baseList.id);
		if (!remoteList) continue; // Trello already closed it, plain pull handles this, nothing to push

		const localList = localListsById.get(baseList.id);
		if (!localList) {
			if (abstainFromArchiving || archivesThisCycle >= MAX_ARCHIVES_PER_CYCLE) continue;
			// Only archive the list if ALL of its base-known cards are also gone
			// from the local file entirely (not just moved to another lane,
			// which is handled per-card below and isn't a reason to keep the lane).
			const stillHasAnyCard = base.cards.some((c) => c.idList === baseList.id && localCardsById.has(c.id));
			if (stillHasAnyCard) {
				messages.push(`Lane "${remoteList.name}" removed locally but some of its cards still exist elsewhere, not archiving the Trello list (ambiguous).`);
				continue;
			}
			try {
				await updateList(baseList.id, { closed: true }, apiKey, apiToken);
				archivesThisCycle++;
				mutated = true;
				messages.push(`Archived Trello list "${remoteList.name}" (removed locally).`);
			} catch (err) {
				messages.push(`Failed to archive list "${remoteList.name}": ${err}`);
			}
			continue;
		}

		const localChanged = localList.name !== baseList.name;
		const remoteChanged = remoteList.name !== baseList.name;
		if (localChanged && !remoteChanged) {
			try {
				await updateList(baseList.id, { name: localList.name }, apiKey, apiToken);
				mutated = true;
				messages.push(`Renamed Trello list "${baseList.name}" -> "${localList.name}".`);
			} catch (err) {
				messages.push(`Failed to rename list "${baseList.name}": ${err}`);
			}
		} else if (localChanged && remoteChanged && localList.name !== remoteList.name) {
			messages.push(`List rename conflict on "${baseList.name}", keeping Trello's "${remoteList.name}".`);
		}
	}

	// ---- Cards: rename / move / archive ----
	for (const baseCard of base.cards) {
		if (duplicateCardIds.has(baseCard.id)) continue;
		const remoteCard = remoteCardsById.get(baseCard.id);
		if (!remoteCard || remoteCard.closed) continue; // Trello already archived it

		const localCard = localCardsById.get(baseCard.id);
		if (!localCard) {
			if (abstainFromArchiving || archivesThisCycle >= MAX_ARCHIVES_PER_CYCLE) continue;
			try {
				await updateCard(baseCard.id, { closed: true }, apiKey, apiToken);
				archivesThisCycle++;
				mutated = true;
				messages.push(`Archived Trello card "${baseCard.name}" (removed locally).`);
			} catch (err) {
				messages.push(`Failed to archive card "${baseCard.name}": ${err}`);
			}
			continue;
		}

		const localNameChanged = localCard.name !== baseCard.name;
		const remoteNameChanged = remoteCard.name !== baseCard.name;
		const localListChanged = localCard.idList !== null && localCard.idList !== baseCard.idList;
		const remoteListChanged = remoteCard.idList !== baseCard.idList;

		const fields: { name?: string; idList?: string } = {};

		if (localNameChanged && !remoteNameChanged) {
			fields.name = localCard.name;
		} else if (localNameChanged && remoteNameChanged && localCard.name !== remoteCard.name) {
			messages.push(`Card rename conflict on "${baseCard.name}", keeping Trello's "${remoteCard.name}".`);
		}

		if (localListChanged && !remoteListChanged) {
			fields.idList = localCard.idList as string;
		} else if (localListChanged && remoteListChanged && localCard.idList !== remoteCard.idList) {
			messages.push(`Card lane-move conflict on "${baseCard.name}", keeping Trello's placement.`);
		}

		if (fields.name !== undefined || fields.idList !== undefined) {
			try {
				await updateCard(baseCard.id, fields, apiKey, apiToken);
				mutated = true;
				messages.push(`Updated Trello card "${baseCard.name}".`);
			} catch (err) {
				messages.push(`Failed to update card "${baseCard.name}": ${err}`);
			}
		}
	}

	// ---- New lanes (created locally, no identity yet) ----
	const pendingListCreates = board.pendingListCreates ?? [];
	const newLaneListId = new Map<number, string>();
	for (const { name, laneIndex } of newLanes) {
		try {
			const id = await findOrCreatePendingList(ctx, pendingListCreates, name);
			newLaneListId.set(laneIndex, id);
			mutated = true;
			messages.push(`Created Trello list "${name}".`);
		} catch (err) {
			messages.push(`Failed to create list "${name}": ${err}`);
		}
	}
	board.pendingListCreates = pendingListCreates;
	// Not cleared here, every id resolved this cycle (new or previously
	// pending) is about to be embedded as a marker in this cycle's file write.
	// The caller clears both ledgers once that write actually succeeds, so a
	// failed write doesn't lose track of a create that has no marker on disk
	// yet.

	// ---- New cards (created locally, no identity yet) ----
	const pendingCardCreates = board.pendingCardCreates ?? [];
	for (const [laneIndex, cards] of newCardsByLaneIndex) {
		const lane = localLanes[laneIndex];
		const idList = lane.listId ?? newLaneListId.get(laneIndex);
		if (!idList) {
			messages.push(`Could not resolve a Trello list for new card(s) in lane "${lane.name}", will retry next cycle.`);
			continue;
		}
		for (const card of cards) {
			try {
				await findOrCreatePendingCard(ctx, pendingCardCreates, card.name, idList);
				mutated = true;
				messages.push(`Created Trello card "${card.name}".`);
			} catch (err) {
				messages.push(`Failed to create card "${card.name}": ${err}`);
			}
		}
	}
	board.pendingCardCreates = pendingCardCreates;

	return { mutated, extraContentByCardId: extraContentMap(localLanes), log: messages };
}

export function snapshotFromRemote(lists: TrelloList[], cards: TrelloCard[]): BoardSnapshot {
	return {
		lists: lists.map((l) => ({ id: l.id, name: l.name, closed: l.closed })),
		cards: cards.map((c) => ({ id: c.id, name: c.name, idList: c.idList, closed: c.closed })),
	};
}
