export interface TrelloBoard {
	id: string;
	name: string;
	closed: boolean;
}

export interface TrelloList {
	id: string;
	name: string;
	closed: boolean;
}

export interface TrelloLabel {
	id: string;
	name: string;
	color: string;
}

export interface TrelloMember {
	id: string;
	fullName: string;
	username: string;
}

export interface TrelloChecklistItem {
	id: string;
	name: string;
	state: "complete" | "incomplete";
}

export interface TrelloChecklist {
	id: string;
	name: string;
	checkItems: TrelloChecklistItem[];
}

export interface TrelloCard {
	id: string;
	name: string;
	closed: boolean;
	idList: string;
	due: string | null;
	dueComplete: boolean;
	desc: string;
	labels: TrelloLabel[];
	members: TrelloMember[];
	checklists: TrelloChecklist[];
	pos: number;
	shortLink: string;
}

export interface BoardSnapshotList {
	id: string;
	name: string;
	closed: boolean;
}

export interface BoardSnapshotCard {
	id: string;
	name: string;
	idList: string;
	closed: boolean;
}

export interface BoardSnapshotCheckItem {
	id: string;
	cardId: string;
	state: "complete" | "incomplete";
}

// "base" for the local/remote 3-way merge, Trello's state as of the last
// completed two-way sync cycle. Overwritten wholesale each cycle, never
// appended to, so it stays small and self-healing.
export interface BoardSnapshot {
	lists: BoardSnapshotList[];
	cards: BoardSnapshotCard[];
	checkItems: BoardSnapshotCheckItem[];
}

// Tracks a create (POST) call that succeeded but whose resulting id hasn't
// been backfilled into the note as a marker yet, POST isn't idempotent, so
// this is what stops an interrupted cycle from creating a duplicate on retry.
export interface PendingCreate {
	localKey: string;
	trelloId: string;
	createdAt: number;
}

export interface BoardSyncConfig {
	trelloBoardId: string;
	trelloBoardName: string;
	enabled: boolean;
	targetFilename: string;
	targetFolder?: string;
	lastKnownListOrder?: string[];
	baseSnapshot?: BoardSnapshot;
	pendingCardCreates?: PendingCreate[];
	pendingListCreates?: PendingCreate[];
	// Ids found "missing locally" (candidate for archiving on Trello) as of the
	// last reconcile cycle. A card/list is only actually archived once it's
	// been missing for two consecutive cycles, so a one-off bad read of the
	// local file (a race with something else touching it) can't archive
	// anything by itself, it just gets recorded here and re-checked next time.
	pendingArchiveCardIds?: string[];
	pendingArchiveListIds?: string[];
}

export type OrphanedCardBehavior = "drop" | "archive-lane";

export interface TrelloKanbanSyncSettings {
	apiKey: string;
	apiToken: string;
	syncEnabled: boolean;
	syncIntervalSeconds: number;
	targetFolder: string;
	boards: BoardSyncConfig[];
	renderDueDates: boolean;
	renderLabelsAsTags: boolean;
	renderCardLinks: boolean;
	renderMembers: boolean;
	renderDescription: boolean;
	renderChecklists: boolean;
	orphanedCardBehavior: OrphanedCardBehavior;
	twoWaySyncEnabled: boolean;
	debugLogging: boolean;
	lastSyncedAt?: number;
}

export const DEFAULT_SETTINGS: TrelloKanbanSyncSettings = {
	apiKey: "",
	apiToken: "",
	syncEnabled: true,
	syncIntervalSeconds: 5,
	targetFolder: "Trello",
	boards: [],
	renderDueDates: true,
	renderLabelsAsTags: true,
	renderCardLinks: true,
	renderMembers: true,
	renderDescription: false,
	renderChecklists: false,
	orphanedCardBehavior: "archive-lane",
	twoWaySyncEnabled: false,
	debugLogging: false,
};

export interface KanbanSettingsBlock {
	"kanban-plugin": string;
	"list-collapse"?: boolean[];
	[key: string]: unknown;
}
