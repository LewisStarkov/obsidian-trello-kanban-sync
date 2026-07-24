# Trello Kanban Sync

Mirrors Trello boards into native Obsidian Kanban-plugin boards (requires the
[Kanban plugin](https://github.com/mgmeyers/obsidian-kanban) to actually
render them). Defaults to one-way sync: **Trello is the source of truth**.
Edits you make to a synced note inside Obsidian are overwritten on the next
sync, unless you turn on two-way sync (see below).

## Setup

1. Go to https://trello.com/power-ups/admin/ and create your own app.
2. Copy the API key and paste it into the "Trello API key" field, then click
   "Open authorization page".
3. Grant access, then copy the token shown on that page.
4. Paste the token into the "Trello API token" field.
5. Click "Fetch my boards", then toggle on the boards you want synced.
6. Each enabled board is written to `Trello/<Board Name>.md` (configurable)
   on the configured interval (default every 5 seconds), or immediately via
   the "Sync now" command.

## Two-way sync (experimental, off by default)

Turn on "Two-way sync" in settings to push edits made directly in Obsidian's
Kanban view back to Trello. Only three things ever sync Obsidian → Trello: a
card's **name**, which **lane** it's in, and whether it **exists** (creating
or archiving). Everything else (due dates, labels, card order, lane order)
always stays one-way, reflecting Trello's current values.

How it works, briefly: every card and lane gets a hidden `%%tid:...%%` /
`%%lid:...%%` marker (invisible in the Kanban board view) so the plugin can
recognize "this is still card X" across edits. Each sync cycle 3-way-merges
the note's current content against a saved snapshot of Trello's last-known
state, so a partner's concurrent edit on Trello.com always wins over a stale
local edit rather than silently clobbering it. Cards/lists are only ever
archived (never hard-deleted) and only when it's unambiguous that they were
actually removed locally, anything uncertain is left alone and logged rather
than guessed at. A card with extra indented lines under it (Kanban supports
multi-line card bodies) is automatically excluded from two-way sync so your
notes are never mistaken for something to push to Trello.

Turning two-way sync back off at any time is safe, the board just reverts to
today's plain one-way behavior, no cleanup needed.

## Development

```
npm install
npm run dev     # esbuild watch, rebuilds main.js on save
npm run build    # type-check + production bundle
```

Use the "Sync now" command to test a sync pass immediately instead of waiting
on the interval.

## Notes

- All Trello calls go through Obsidian's `requestUrl` (not `fetch`), so this
  works on mobile too.
- The plugin preserves everything already in a board note's
  `%% kanban:settings %%` block (lane collapse state, `show-checkboxes`,
  etc.), it only ever touches `list-collapse` to keep it aligned with the
  current lane order.
- Your Trello API key/token live in this plugin's `data.json`. If your vault
  is under git, make sure that file is gitignored.
