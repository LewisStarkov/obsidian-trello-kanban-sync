import { requestUrl } from "obsidian";
import { TrelloBoard, TrelloCard, TrelloList } from "./types";

const API_BASE = "https://api.trello.com/1";

export class TrelloRateLimitError extends Error {
	constructor() {
		super("Trello API rate limit hit (HTTP 429)");
	}
}

async function trelloGet<T>(path: string, params: Record<string, string>, apiKey: string, apiToken: string): Promise<T> {
	const query = new URLSearchParams({ ...params, key: apiKey, token: apiToken }).toString();
	const response = await requestUrl({
		url: `${API_BASE}${path}?${query}`,
		method: "GET",
		throw: false,
	});

	if (response.status === 429) {
		throw new TrelloRateLimitError();
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Trello API error ${response.status} on ${path}: ${response.text}`);
	}

	return response.json as T;
}

async function trelloWrite<T>(
	method: "POST" | "PUT",
	path: string,
	params: Record<string, string>,
	apiKey: string,
	apiToken: string
): Promise<T> {
	const query = new URLSearchParams({ ...params, key: apiKey, token: apiToken }).toString();
	const response = await requestUrl({
		url: `${API_BASE}${path}?${query}`,
		method,
		throw: false,
	});

	if (response.status === 429) {
		throw new TrelloRateLimitError();
	}
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Trello API error ${response.status} on ${method} ${path}: ${response.text}`);
	}

	return response.json as T;
}

export async function fetchMyBoards(apiKey: string, apiToken: string): Promise<TrelloBoard[]> {
	return trelloGet<TrelloBoard[]>("/members/me/boards", { fields: "name,id,closed" }, apiKey, apiToken);
}

export async function fetchBoardLists(boardId: string, apiKey: string, apiToken: string): Promise<TrelloList[]> {
	return trelloGet<TrelloList[]>(
		`/boards/${boardId}/lists`,
		{ fields: "name,id,closed", filter: "open" },
		apiKey,
		apiToken
	);
}

export async function fetchBoardCards(boardId: string, apiKey: string, apiToken: string): Promise<TrelloCard[]> {
	return trelloGet<TrelloCard[]>(
		`/boards/${boardId}/cards`,
		{
			fields: "name,id,closed,idList,due,dueComplete,desc,labels,pos,shortLink",
			filter: "open",
			members: "true",
			member_fields: "fullName,username",
			checklists: "all",
			checklist_fields: "name",
		},
		apiKey,
		apiToken
	);
}

export interface CardUpdateFields {
	name?: string;
	idList?: string;
	closed?: boolean;
}

export interface ListUpdateFields {
	name?: string;
	closed?: boolean;
}

export async function createCard(name: string, idList: string, apiKey: string, apiToken: string): Promise<{ id: string }> {
	return trelloWrite<{ id: string }>("POST", "/cards", { name, idList, pos: "bottom" }, apiKey, apiToken);
}

export async function updateCard(
	cardId: string,
	fields: CardUpdateFields,
	apiKey: string,
	apiToken: string
): Promise<{ id: string }> {
	const params: Record<string, string> = {};
	if (fields.name !== undefined) params.name = fields.name;
	if (fields.idList !== undefined) params.idList = fields.idList;
	if (fields.closed !== undefined) params.closed = String(fields.closed);
	return trelloWrite<{ id: string }>("PUT", `/cards/${cardId}`, params, apiKey, apiToken);
}

export async function createList(name: string, idBoard: string, apiKey: string, apiToken: string): Promise<{ id: string }> {
	return trelloWrite<{ id: string }>("POST", "/lists", { name, idBoard, pos: "bottom" }, apiKey, apiToken);
}

export async function updateList(
	listId: string,
	fields: ListUpdateFields,
	apiKey: string,
	apiToken: string
): Promise<{ id: string }> {
	const params: Record<string, string> = {};
	if (fields.name !== undefined) params.name = fields.name;
	if (fields.closed !== undefined) params.closed = String(fields.closed);
	return trelloWrite<{ id: string }>("PUT", `/lists/${listId}`, params, apiKey, apiToken);
}

export async function updateCheckItem(
	cardId: string,
	checkItemId: string,
	state: "complete" | "incomplete",
	apiKey: string,
	apiToken: string
): Promise<{ id: string }> {
	return trelloWrite<{ id: string }>(
		"PUT",
		`/cards/${cardId}/checkItem/${checkItemId}`,
		{ state },
		apiKey,
		apiToken
	);
}
