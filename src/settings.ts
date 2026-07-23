import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type TrelloKanbanSyncPlugin from "./main";
import { fetchMyBoards } from "./trelloClient";
import { boardNameToFilename } from "./util/filenames";
import { BoardSyncConfig } from "./types";

export class TrelloKanbanSyncSettingTab extends PluginSettingTab {
	plugin: TrelloKanbanSyncPlugin;

	constructor(app: App, plugin: TrelloKanbanSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Trello Kanban Sync").setHeading();
		containerEl.createEl("p", {
			text: this.plugin.settings.twoWaySyncEnabled
				? "Two-way sync is on: a card's name, its lane, and whether it exists sync back to Trello. Everything else (due dates, labels, order) always reflects Trello's current values."
				: "One-way sync: Trello is the source of truth. Edits made to synced boards inside Obsidian will be overwritten on the next sync.",
		});
		containerEl.createEl("p", {
			text: this.plugin.settings.lastSyncedAt
				? `Last synced: ${new Date(this.plugin.settings.lastSyncedAt).toLocaleString()}`
				: "Last synced: never",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Sync enabled")
			.setDesc("Pause syncing without losing your boards/settings.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.syncEnabled).onChange(async (value) => {
					this.plugin.settings.syncEnabled = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Two-way sync (experimental)")
			.setDesc(
				"Push renames, lane moves, new cards and deletions from Obsidian back to Trello. Only a card's name, its lane, and whether it exists are ever pushed, everything else stays one-way. Safe to turn off again at any time; the board just goes back to today's plain one-way behavior."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.twoWaySyncEnabled).onChange(async (value) => {
					this.plugin.settings.twoWaySyncEnabled = value;
					await this.plugin.saveSettings();
					this.display();
				})
			);

		new Setting(containerEl)
			.setName("Trello API key")
			.setDesc("Get one at trello.com/app-key")
			.addText((text) =>
				text
					.setPlaceholder("API key")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Get a Trello token")
			.setDesc(
				"Opens Trello's authorization page using the API key above, requesting read+write access (needed for two-way sync) that never expires. Copy the token it shows you into the field below."
			)
			.addButton((button) =>
				button.setButtonText("Open authorization page").onClick(() => {
					if (!this.plugin.settings.apiKey) {
						new Notice("Enter your Trello API key first.");
						return;
					}
					const url = `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&name=${encodeURIComponent(
						"Obsidian Trello Kanban Sync"
					)}&key=${encodeURIComponent(this.plugin.settings.apiKey)}`;
					window.open(url, "_blank");
				})
			);

		new Setting(containerEl)
			.setName("Trello API token")
			.setDesc("Generate via the button above, or manually via the link on trello.com/app-key")
			.addText((text) => {
				text
					.setPlaceholder("API token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to poll Trello for changes.")
			.addText((text) =>
				text
					.setPlaceholder("5")
					.setValue(String(this.plugin.settings.syncIntervalSeconds))
					.onChange(async (value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.syncIntervalSeconds = Math.max(1, parsed);
							await this.plugin.saveSettings();
							this.plugin.restartSyncInterval();
						}
					})
			);

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc("Vault folder where synced board notes are written.")
			.addText((text) =>
				text
					.setPlaceholder("Trello")
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.targetFolder = value.trim() || "Trello";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Render due dates")
			.setDesc("Show a card's Trello due date as a @{date} token.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderDueDates).onChange(async (value) => {
					this.plugin.settings.renderDueDates = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Render labels as tags")
			.setDesc("Show a card's Trello labels as #tags.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderLabelsAsTags).onChange(async (value) => {
					this.plugin.settings.renderLabelsAsTags = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Render card links")
			.setDesc("Add a link on each card back to the Trello card.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.renderCardLinks).onChange(async (value) => {
					this.plugin.settings.renderCardLinks = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Cards whose list was archived")
			.setDesc(
				"Trello can leave a card 'open' even after its list is archived. Choose whether those cards are dropped or collected into an Archived lane."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("archive-lane", "Collect into an Archived lane")
					.addOption("drop", "Drop them")
					.setValue(this.plugin.settings.orphanedCardBehavior)
					.onChange(async (value) => {
						this.plugin.settings.orphanedCardBehavior = value as "archive-lane" | "drop";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Show a notice when a board fails to sync (details always go to the console).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName("Boards").setHeading();

		new Setting(containerEl)
			.setName("Fetch my boards")
			.setDesc("Pull the list of your Trello boards so you can pick which ones to sync.")
			.addButton((button) =>
				button.setButtonText("Fetch my boards").onClick(async () => {
					if (!this.plugin.settings.apiKey || !this.plugin.settings.apiToken) {
						new Notice("Enter your Trello API key and token first.");
						return;
					}
					button.setDisabled(true).setButtonText("Fetching...");
					try {
						const boards = await fetchMyBoards(this.plugin.settings.apiKey, this.plugin.settings.apiToken);
						this.mergeFetchedBoards(boards.filter((b) => !b.closed));
						await this.plugin.saveSettings();
						this.display();
					} catch (err) {
						console.error("Trello Kanban Sync: failed to fetch boards", err);
						new Notice("Failed to fetch boards, check your API key/token and the console.");
					} finally {
						button.setDisabled(false).setButtonText("Fetch my boards");
					}
				})
			);

		for (const board of this.plugin.settings.boards) {
			const setting = new Setting(containerEl)
				.setName(board.trelloBoardName)
				.setDesc("Filename, then an optional folder override (blank = use the target folder above).")
				.addToggle((toggle) =>
					toggle.setValue(board.enabled).onChange(async (value) => {
						board.enabled = value;
						await this.plugin.saveSettings();
					})
				)
				.addText((text) =>
					text
						.setPlaceholder(boardNameToFilename(board.trelloBoardName))
						.setValue(board.targetFilename)
						.onChange(async (value) => {
							board.targetFilename = value.trim() || boardNameToFilename(board.trelloBoardName);
							await this.plugin.saveSettings();
						})
				)
				.addText((text) =>
					text
						.setPlaceholder(this.plugin.settings.targetFolder)
						.setValue(board.targetFolder ?? "")
						.onChange(async (value) => {
							board.targetFolder = value.trim() || undefined;
							await this.plugin.saveSettings();
						})
				);
			setting.settingEl.addClass("trello-kanban-sync-board-row");
		}
	}

	private mergeFetchedBoards(boards: { id: string; name: string }[]): void {
		const existingById = new Map(this.plugin.settings.boards.map((b) => [b.trelloBoardId, b]));
		const merged: BoardSyncConfig[] = boards.map((board) => {
			const existing = existingById.get(board.id);
			if (existing) {
				existing.trelloBoardName = board.name;
				return existing;
			}
			return {
				trelloBoardId: board.id,
				trelloBoardName: board.name,
				enabled: false,
				targetFilename: boardNameToFilename(board.name),
			};
		});
		this.plugin.settings.boards = merged;
	}
}
