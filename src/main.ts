import { Notice, Plugin } from "obsidian";
import { DEFAULT_SETTINGS, TrelloKanbanSyncSettings } from "./types";
import { TrelloKanbanSyncSettingTab } from "./settings";
import { SyncEngine } from "./syncEngine";

export default class TrelloKanbanSyncPlugin extends Plugin {
	settings!: TrelloKanbanSyncSettings;
	private syncEngine!: SyncEngine;
	private intervalId: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.syncEngine = new SyncEngine(
			this.app,
			() => this.settings,
			() => this.saveSettings()
		);

		this.addSettingTab(new TrelloKanbanSyncSettingTab(this.app, this));

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: async () => {
				new Notice("Trello Kanban Sync: syncing...");
				await this.syncEngine.syncAll();
				new Notice("Trello Kanban Sync: done.");
			},
		});

		this.restartSyncInterval();
	}

	onunload(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	restartSyncInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		this.syncEngine.checkRateLimitGuard();
		const ms = Math.max(1, this.settings.syncIntervalSeconds) * 1000;
		this.intervalId = this.registerInterval(
			window.setInterval(() => {
				this.syncEngine.syncAll().catch((err: unknown) => {
					console.error("Trello Kanban Sync: unexpected error during sync", err);
				});
			}, ms)
		);
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<TrelloKanbanSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
