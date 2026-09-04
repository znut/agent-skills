# web-search

Zero-dependency web access for pi: two custom tools, no API keys, no npm
packages (Node 18+ global `fetch` only). Concept adapted from omlx's
`omlx/websearch.py`, cut down to DuckDuckGo only.

## Tools

### `web_search`

Scrapes the DuckDuckGo html endpoint (`POST https://html.duckduckgo.com/html/`
— chosen over the `lite` endpoint because the live smoke test showed it
working from a plain `fetch` with a desktop browser User-Agent).

Params: `query` (required, capped at 300 chars), `max_results` (optional,
default 3, cap 10).

Success payload:

```json
{"ok": true, "results": [{"title": "...", "url": "...", "snippet": "..."}]}
```

### `fetch_url`

Fetches one public http(s) page and returns readable text: script/style/
noscript/nav/header/footer/svg blocks removed, block boundaries become
newlines, tags stripped, entities decoded, whitespace collapsed. SSRF-guarded:
hostnames resolving to loopback/private/link-local/reserved IPs (and non-DNS
hostnames like `localhost`) are refused; redirects (max 3) are followed by
hand so every hop is re-validated. Response body capped at 2 MB; timeout 20s.

Params: `url` (required, http/https only, cap 2048 chars), `max_chars`
(optional, default 20000, cap 50000 — truncated text ends in `[truncated]`).

Success payload:

```json
{"ok": true, "url": "<final url>", "content_type": "text/html", "text": "...", "truncated": false}
```

### Failure contract (both tools)

The tools **never throw**. Any failure — network error, non-200 HTTP,
rate limit, anti-bot page, zero parsed results, blocked URL, unsupported
content type — returns:

```json
{"ok": false, "error": {"kind": "bot_wall", "message": "..."}}
```

with `kind` one of `invalid_query`, `invalid_url`, `blocked_url`,
`unsupported_content_type`, `rate_limited`, `bot_wall`, `no_results`,
`timeout`, `http_error`, `provider_unavailable`, `request_failed`. The JSON
is the tool's text content (and mirrored in `details`); the model reads it
and adapts.

## Caveat: rate limits / bot walls

Plain-fetch DuckDuckGo scraping works but is not a guaranteed API: under
load or from datacenter IPs, DDG can serve an anti-bot challenge instead of
results (the tool reports `ok:false` with `kind: "bot_wall"` or
`"rate_limited"`). When that happens the agent should fall back to fetching
known documentation URLs directly with `fetch_url` (or `curl`), and retry
search later.

## Install

Symlink into pi's extension dir (same pattern as the sibling extensions):

```bash
mkdir -p ~/.pi/agent/extensions/web-search
ln -sf "$PWD/index.ts" ~/.pi/agent/extensions/web-search/index.ts
```

Then `/reload` (or restart pi).

## Configuration

None.
