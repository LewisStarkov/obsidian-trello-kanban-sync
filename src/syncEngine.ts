import { App, Notice, TFile } from "obsidian";
import { fetchBoardCards, fetchBoardLists, TrelloRateLimitError } from "./trelloClient";
import { extractSettingsBlock, hasConflictMarkers, parseBoardMarkdown } from "./kanbanParser";
import { buildLanes, buildListCollapse, mergeSettingsBlock, renderBoardMarkdown } from "./kanbanWriter";
import { boardNameToFilename, joinVaultPath } from "./util/filenames";
import { extraContentMap, reconcileBoard, snapshotFromRemote } from "./twoWaySync";
import { BoardSyncConfig, TrelloKanbanSyncSettings } from "./types";

const SAFE_TOKEN_CALLS_PER_10S = 60;

export class SyncEngine {
	private backoffUntil = 0;
	private isSyncing = false;

	constructor(
		private app: App,
		private getSettings: () => TrelloKanbanSyncSettings,
		private saveSettings: () => Promise<void>
	) {}

	checkRateLimitGuard(): void {
		const settings = this.getSettings();
		const enabledCount = settings.boards.filter((b) => b.enabled).length;
		if (enabledCount === 0) return;
		const estimatedCallsPer10s = 2 * enabledCount * (10 / settings.syncIntervalSeconds);
		if (estimatedCallsPer10s > SAFE_TOKEN_CALLS_PER_10S) {
			new Notice(
				`Trello Kanban Sync: ${enabledCount} boards at ${settings.syncIntervalSeconds}s is likely to hit Trello's rate limit. Consider a longer interval or fewer boards.`,
				8000
			);
		}
	}

	async syncAll(): Promise<void> {
		if (Date.now() < this.backoffUntil) return;

		const settings = this.getSettings();
		if (!settings.syncEnabled) return;
		if (!settings.apiKey || !settings.apiToken) return;

		// Guard against overlapping runs: a full pass over several boards (each
		// doing 2+ sequential Trello round-trips, more with two-way's reconcile
		// step) can easily take longer than a short interval like 5s. Without
		// this, two concurrent passes over the same board would both read the
		// same stale file, race on writing it and on persisting baseSnapshot,
		// and edits would appear to get silently reverted/lost.
		if (this.isSyncing) return;
		this.isSyncing = true;
		try {
			const enabledBoards = settings.boards.filter((b) => b.enabled);
			for (const board of enabledBoards) {
				try {
					await this.syncBoard(board, settings);
				} catch (err) {
					if (err instanceof TrelloRateLimitError) {
						this.backoffUntil = Date.now() + 30_000;
						new Notice("Trello Kanban Sync: rate limited by Trello, backing off for 30s.", 6000);
						return;
					}
					console.error(`Trello Kanban Sync: failed to sync board "${board.trelloBoardName}"`, err);
					if (settings.debugLogging) {
						new Notice(`Trello Kanban Sync: failed to sync "${board.trelloBoardName}", see console.`, 6000);
					}
				}
			}
		} finally {
			this.isSyncing = false;
		}
	}

	private async syncBoard(board: BoardSyncConfig, settings: TrelloKanbanSyncSettings): Promise<void> {
		let [lists, cards] = await Promise.all([
			fetchBoardLists(board.trelloBoardId, settings.apiKey, settings.apiToken),
			fetchBoardCards(board.trelloBoardId, settings.apiKey, settings.apiToken),
		]);

		const folder = board.targetFolder?.trim() || settings.targetFolder;
		const filename = board.targetFilename || boardNameToFilename(board.trelloBoardName);
		const path = joinVaultPath(folder, filename);

		const existingFile = this.app.vault.getAbstractFileByPath(path);
		const existingContent = existingFile instanceof TFile ? await this.app.vault.read(existingFile) : null;
		const existingSettings = existingContent ? extractSettingsBlock(existingContent) : null;

		const twoWayActive = settings.twoWaySyncEnabled;
		let extraContentByCardId = new Map<string, string[]>();

		if (twoWayActive && existingContent && hasConflictMarkers(existingContent)) {
			console.warn(
				`Trello Kanban Sync: "${board.trelloBoardName}" note contains merge-conflict-marker-looking lines, skipping two-way reconciliation and the regular pull for this cycle to avoid pushing garbage.`
			);
			if (settings.debugLogging) {
				new Notice(`Trello Kanban Sync: "${board.trelloBoardName}" has conflict-marker-like text, sync skipped this cycle.`, 6000);
			}
			return;
		}

		const isBootstrapCycle = twoWayActive && !board.baseSnapshot;
		if (isBootstrapCycle) {
			// First cycle with two-way on for this board: nothing to diff
			// against yet, so just fall through to a plain one-way render below,
			// identical to today's behavior. board.baseSnapshot is seeded further
			// down, only once that render has actually been written successfully
			// (same crash-safety reasoning as the regular reconcile path below).
		} else if (twoWayActive && board.baseSnapshot && existingContent) {
			const localLanes = parseBoardMarkdown(existingContent);
			const result = await reconcileBoard(
				localLanes,
				board.baseSnapshot,
				lists,
				cards,
				board,
				board.trelloBoardId,
				settings.apiKey,
				settings.apiToken,
				this.saveSettings
			);
			extraContentByCardId = result.extraContentByCardId;
			if (result.log.length > 0) {
				for (const line of result.log) console.log(`Trello Kanban Sync [${board.trelloBoardName}]: ${line}`);
				if (settings.debugLogging) {
					new Notice(`Trello Kanban Sync: pushed changes for "${board.trelloBoardName}", see console.`, 5000);
				}
			}
			if (result.mutated) {
				[lists, cards] = await Promise.all([
					fetchBoardLists(board.trelloBoardId, settings.apiKey, settings.apiToken),
					fetchBoardCards(board.trelloBoardId, settings.apiKey, settings.apiToken),
				]);
			}
		} else if (twoWayActive && existingContent) {
			// Base exists but nothing to reconcile against right now (shouldn't
			// normally happen), still need the extra-content map so multi-line
			// cards render correctly below.
			extraContentByCardId = extraContentMap(parseBoardMarkdown(existingContent));
		}

		const lanes = buildLanes(lists, cards, settings.orphanedCardBehavior);
		const currentListIds = lanes.map((lane) => lane.listId);

		const listCollapse = buildListCollapse(
			currentListIds,
			board.lastKnownListOrder,
			existingSettings?.["list-collapse"]
		);
		const mergedSettings = mergeSettingsBlock(existingSettings, listCollapse);

		const rendered = renderBoardMarkdown(
			lanes,
			mergedSettings,
			{
				renderDueDates: settings.renderDueDates,
				renderLabelsAsTags: settings.renderLabelsAsTags,
				renderCardLinks: settings.renderCardLinks,
			},
			extraContentByCardId
		);

		if (existingContent === rendered) {
			// Already converged, safe to refresh the merge base immediately,
			// nothing was written so there's no write-failure risk to guard against.
			if (twoWayActive) {
				board.baseSnapshot = snapshotFromRemote(lists, cards);
				board.pendingCardCreates = [];
				board.pendingListCreates = [];
				await this.saveSettings();
			}
			board.lastKnownListOrder = currentListIds;
			return;
		}

		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, rendered);
		} else {
			await this.ensureFolder(folder);
			await this.app.vault.create(path, rendered);
		}

		// Only refresh the merge base once the write above has actually
		// succeeded (an exception thrown by vault.modify/create propagates out
		// of syncBoard before reaching here), otherwise a failed write would
		// leave baseSnapshot pointing at state the on-disk file never reached.
		if (twoWayActive) {
			board.baseSnapshot = snapshotFromRemote(lists, cards);
			board.pendingCardCreates = [];
			board.pendingListCreates = [];
		}

		board.lastKnownListOrder = currentListIds;
		settings.lastSyncedAt = Date.now();
		await this.saveSettings();
	}

	private async ensureFolder(folder: string): Promise<void> {
		const trimmed = folder.replace(/^\/+|\/+$/g, "");
		if (!trimmed) return;
		const existing = this.app.vault.getAbstractFileByPath(trimmed);
		if (!existing) {
			await this.app.vault.createFolder(trimmed);
		}
	}
}
