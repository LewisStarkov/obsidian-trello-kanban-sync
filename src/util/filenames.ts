const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|]/g;

export function boardNameToFilename(boardName: string): string {
	const cleaned = boardName
		.replace(ILLEGAL_FILENAME_CHARS, " ")
		.replace(/\s+/g, " ")
		.trim();
	return `${cleaned || "Untitled Board"}.md`;
}

export function joinVaultPath(folder: string, filename: string): string {
	const trimmedFolder = folder.replace(/^\/+|\/+$/g, "");
	return trimmedFolder ? `${trimmedFolder}/${filename}` : filename;
}

const TAG_ILLEGAL_CHARS = /[^A-Za-z0-9_/-]+/g;

export function slugifyTag(labelName: string): string | null {
	const slug = labelName.trim().replace(TAG_ILLEGAL_CHARS, "-").replace(/^-+|-+$/g, "");
	return slug.length > 0 ? slug : null;
}
