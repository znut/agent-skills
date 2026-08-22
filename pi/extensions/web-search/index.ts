/**
 * pi web-search extension
 *
 * Registers two custom tools:
 *
 *   web_search  DuckDuckGo html endpoint scraping, zero dependencies and no
 *               credentials. Returns {"ok": true, "results": [...]} or an
 *               {"ok": false, "error": {...}} envelope — never throws.
 *   fetch_url   Fetch one public http(s) page, strip HTML to readable text.
 *               SSRF-guarded (loopback/private/link-local/reserved IPs and
 *               non-DNS hostnames are refused). Same never-throw envelope.
 *
 * Both tools return the parsed payload as a JSON string in the text content
 * (the contract the model reads) and again in `details`.
 *
 * The top half of this file is pure exported functions with no pi imports so
 * the logic can be smoke-tested without booting pi. The bottom half is the
 * default extension function registering the tools around them.
 *
 * Adapted from omlx's omlx/websearch.py (envelope + error taxonomy + SSRF
 * guard ideas); DuckDuckGo only, no provider sprawl.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DEFAULT_MAX_RESULTS = 3;
const MAX_RESULTS_CAP = 10;
const MAX_QUERY_CHARS = 300;
const MAX_URL_CHARS = 2048;
const MAX_TITLE_CHARS = 160;
const MAX_SNIPPET_CHARS = 500;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_FETCH_CHARS = 20_000;
const MAX_FETCH_CHARS = 50_000;

const FETCHABLE_CONTENT_TYPES = new Set([
	"text/html",
	"application/xhtml+xml",
	"text/plain",
	"text/markdown",
	"application/json",
]);
const HTML_CONTENT_TYPES = new Set(["", "text/html", "application/xhtml+xml"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export type SearchPayload =
	| { ok: true; results: SearchResult[] }
	| { ok: false; error: { kind: string; message: string } };

export type FetchPayload =
	| { ok: true; url: string; content_type: string; text: string; truncated: boolean }
	| { ok: false; error: { kind: string; message: string } };

function fail(kind: string, message: string): { ok: false; error: { kind: string; message: string } } {
	return { ok: false, error: { kind, message } };
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name] ?? m);
}

function stripTags(html: string): string {
	return html.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(text: string): string {
	return text
		.replace(/[ \t\f\v ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Unwrap DDG's /l/?uddg= redirect to the real URL; keep only clean http(s). */
function unwrapDdgUrl(href: string): string | null {
	const decoded = decodeEntities(href);
	try {
		const wrapper = new URL(decoded, "https://duckduckgo.com");
		const target = wrapper.searchParams.get("uddg") ?? decoded;
		if (target.length > MAX_URL_CHARS) return null;
		const parsed = new URL(target);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		if (parsed.username || parsed.password) return null;
		return target;
	} catch {
		return null;
	}
}

/**
 * Parse the html.duckduckgo.com result page. Anchors appear in document
 * order: each result__a starts a result, each following result__snippet
 * attaches to the latest result that still lacks one.
 */
function parseDdgResults(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = anchorRe.exec(html)) !== null && results.length < maxResults) {
		const cls = m[1].match(/class="([^"]*)"/i)?.[1] ?? "";
		if (/\bresult__a\b/.test(cls)) {
			const href = m[1].match(/href="([^"]*)"/i)?.[1];
			const url = href ? unwrapDdgUrl(href) : null;
			if (!url) continue;
			const title =
				collapseWhitespace(decodeEntities(stripTags(m[2]))).slice(0, MAX_TITLE_CHARS) ||
				new URL(url).hostname;
			results.push({ title, url, snippet: "" });
		} else if (/\bresult__snippet\b/.test(cls)) {
			const last = results[results.length - 1];
			if (last && !last.snippet)
				last.snippet = collapseWhitespace(decodeEntities(stripTags(m[2]))).slice(0, MAX_SNIPPET_CHARS);
		}
	}
	return results;
}

export async function webSearch(query: string, maxResults?: number): Promise<SearchPayload> {
	const trimmed = (query ?? "").trim().slice(0, MAX_QUERY_CHARS);
	if (!trimmed) return fail("invalid_query", "web_search needs a non-empty 'query' string.");
	const count = Math.min(Math.max(Math.trunc(maxResults ?? DEFAULT_MAX_RESULTS) || DEFAULT_MAX_RESULTS, 1), MAX_RESULTS_CAP);

	let html: string;
	try {
		const res = await fetch(DDG_ENDPOINT, {
			method: "POST",
			headers: {
				"User-Agent": USER_AGENT,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ q: trimmed }).toString(),
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
		if (res.status !== 200) {
			if (res.status === 202 || res.status === 403)
				return fail("bot_wall", `DuckDuckGo served an anti-bot challenge (HTTP ${res.status}); retry later or fetch known doc URLs directly.`);
			if (res.status === 429)
				return fail("rate_limited", "DuckDuckGo rate limited the search (HTTP 429); retry later.");
			if (res.status >= 500)
				return fail("provider_unavailable", `DuckDuckGo is unavailable (HTTP ${res.status}).`);
			return fail("http_error", `DuckDuckGo returned HTTP ${res.status}.`);
		}
		html = await res.text();
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError")
			return fail("timeout", "DuckDuckGo search timed out after 20s.");
		return fail("request_failed", `DuckDuckGo search failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	const results = parseDdgResults(html, count);
	if (results.length === 0) {
		// A challenge page contains the anomaly form instead of results.
		if (html.includes("anomaly"))
			return fail("bot_wall", "DuckDuckGo served an anti-bot challenge page; retry later or fetch known doc URLs directly.");
		return fail("no_results", `DuckDuckGo returned no parseable results for: ${trimmed}`);
	}
	return { ok: true, results };
}

function isBlockedIpv4(ip: string): boolean {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

function isBlockedIpv6(ip: string): boolean {
	const lower = ip.toLowerCase().split("%", 1)[0];
	const mapped = lower.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (mapped) return isBlockedIpv4(mapped[1]);
	if (lower === "::" || lower === "::1") return true;
	const firstWord = parseInt(lower.split(":", 1)[0] || "0", 16);
	if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
	if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)
	return false;
}

function isBlockedIp(ip: string): boolean {
	switch (isIP(ip)) {
		case 4:
			return isBlockedIpv4(ip);
		case 6:
			return isBlockedIpv6(ip);
		default:
			return true; // unparseable literal: refuse
	}
}

/** SSRF guard: refuse non-DNS hostnames and hosts resolving to non-public IPs. */
async function assertPublicHost(hostname: string): Promise<string | null> {
	const host = hostname.toLowerCase();
	if (isIP(host) !== 0) return isBlockedIp(host) ? `refused private/local IP ${hostname}` : null;
	if (host === "localhost" || host.endsWith(".localhost") || !host.includes("."))
		return `refused non-DNS hostname ${hostname}`;
	let addresses: { address: string }[];
	try {
		addresses = await lookup(host, { all: true });
	} catch {
		return `could not resolve host ${hostname}`;
	}
	if (addresses.length === 0) return `could not resolve host ${hostname}`;
	for (const { address } of addresses)
		if (isBlockedIp(address)) return `host ${hostname} resolves to private/local address ${address}`;
	return null;
}

function validateFetchUrl(raw: string): { url: URL } | { error: string } {
	const candidate = (raw ?? "").trim();
	if (!candidate || candidate.length > MAX_URL_CHARS)
		return { error: `fetch_url needs an http(s) URL up to ${MAX_URL_CHARS} characters.` };
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return { error: "fetch_url could not parse the URL." };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return { error: "Only http and https URLs can be fetched." };
	if (!url.hostname) return { error: "The URL has no host." };
	if (url.username || url.password) return { error: "URLs with embedded credentials are not allowed." };
	return { url };
}

async function readBodyCapped(res: Response, cap: number): Promise<Buffer> {
	const reader = res.body?.getReader();
	if (!reader) return Buffer.from(await res.arrayBuffer());
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(Buffer.from(value));
			total += value.length;
			if (total >= cap) {
				await reader.cancel().catch(() => {});
				break;
			}
		}
	}
	return Buffer.concat(chunks).subarray(0, cap);
}

/** Strip HTML to readable plain text: drop boilerplate blocks, keep line structure. */
function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<(script|style|noscript|nav|header|footer|svg)\b[\s\S]*?<\/\1>/gi, " ");
	s = s.replace(/<\/?(li|p|h[1-6]|br)\b[^>]*>/gi, "\n");
	s = stripTags(s);
	return collapseWhitespace(decodeEntities(s));
}

export async function fetchUrl(url: string, maxChars?: number): Promise<FetchPayload> {
	const charCap = Math.min(Math.max(Math.trunc(maxChars ?? DEFAULT_FETCH_CHARS) || DEFAULT_FETCH_CHARS, 1), MAX_FETCH_CHARS);
	let current = (url ?? "").trim();
	try {
		// Redirects are followed by hand so every hop re-validates the URL and
		// the SSRF guard. No DNS-rebinding defense between our lookup and the
		// connect — accepted for a local single-user agent.
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const validated = validateFetchUrl(current);
			if ("error" in validated) return fail("invalid_url", validated.error);
			const blocked = await assertPublicHost(validated.url.hostname);
			if (blocked) return fail("blocked_url", `fetch_url ${blocked}.`);

			const res = await fetch(validated.url, {
				headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/json" },
				redirect: "manual",
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});

			if (REDIRECT_STATUSES.has(res.status)) {
				const location = res.headers.get("location");
				if (!location) return fail("http_error", "The server redirected without a Location header.");
				if (hop === MAX_REDIRECTS) return fail("http_error", `Too many redirects (>${MAX_REDIRECTS}).`);
				current = new URL(location, validated.url).toString();
				continue;
			}
			if (res.status === 429) return fail("rate_limited", "The web server rate limited the request (HTTP 429).");
			if (res.status !== 200) return fail("http_error", `The web server returned HTTP ${res.status}.`);

			const contentType = (res.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
			if (contentType && !FETCHABLE_CONTENT_TYPES.has(contentType))
				return fail("unsupported_content_type", `Content type '${contentType}' is not supported; only HTML and plain text pages can be fetched.`);

			const body = await readBodyCapped(res, MAX_RESPONSE_BYTES);
			const raw = new TextDecoder("utf-8").decode(body);
			const full = HTML_CONTENT_TYPES.has(contentType) ? htmlToText(raw) : raw.trim();
			const truncated = full.length > charCap;
			const text = truncated ? `${full.slice(0, charCap)}[truncated]` : full;
			return { ok: true, url: validated.url.toString(), content_type: contentType, text, truncated };
		}
		return fail("http_error", `Too many redirects (>${MAX_REDIRECTS}).`);
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError")
			return fail("timeout", `Fetching ${current} timed out after 20s.`);
		return fail("request_failed", `Fetching ${current} failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query (max 300 characters)" }),
	max_results: Type.Optional(
		Type.Number({ description: "Max results to return (default 3, cap 10)", default: DEFAULT_MAX_RESULTS }),
	),
});

const FetchUrlParams = Type.Object({
	url: Type.String({ description: "Public http(s) URL to fetch (max 2048 characters)" }),
	max_chars: Type.Optional(
		Type.Number({ description: "Max characters of text to return (default 20000, cap 50000)", default: DEFAULT_FETCH_CHARS }),
	),
});

function toolResult(payload: SearchPayload | FetchPayload) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
		details: payload,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web via DuckDuckGo (html endpoint, no credentials). Returns JSON: {\"ok\": true, \"results\": [{title, url, snippet}]} on success, or {\"ok\": false, \"error\": {kind, message}} on any failure (rate_limited, bot_wall, no_results, timeout, ...). On ok:false, adapt: retry later or fetch known documentation URLs directly with fetch_url.",
		parameters: WebSearchParams,
		async execute(_toolCallId, params) {
			return toolResult(await webSearch(params.query, params.max_results));
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch one public http(s) page and return it as readable text (HTML is stripped; script/style/nav/header/footer removed). SSRF-guarded: private/loopback/link-local addresses are refused. Returns JSON: {\"ok\": true, url, content_type, text, truncated} on success, or {\"ok\": false, \"error\": {kind, message}} on failure (blocked_url, unsupported_content_type, http_error, timeout, ...).",
		parameters: FetchUrlParams,
		async execute(_toolCallId, params) {
			return toolResult(await fetchUrl(params.url, params.max_chars));
		},
	});
}
