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

export interface TrelloCard {
	id: string;
	name: string;
	closed: boolean;
	idList: string;
	due: string | null;
	labels: TrelloLabel[];
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

// "base" for the local/remote 3-way merge, Trello's state as of the last
// completed two-way sync cycle. Overwritten wholesale each cycle, never
// appended to, so it stays small and self-healing.
export interface BoardSnapshot {
	lists: BoardSnapshotList[];
	cards: BoardSnapshotCard[];
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
	orphanedCardBehavior: "archive-lane",
	twoWaySyncEnabled: false,
	debugLogging: false,
};

export interface KanbanSettingsBlock {
	"kanban-plugin": string;
	"list-collapse"?: boolean[];
	[key: string]: unknown;
}
