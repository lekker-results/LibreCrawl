# LibreCrawl - Project Context

## What This Is

LibreCrawl is an open-source, self-hosted SEO web crawler and website auditing tool. It crawls websites, extracts SEO metadata, detects technical/SEO issues, and presents results through an interactive web dashboard. Built for SEO professionals who need a free alternative to tools like Screaming Frog or Sitebulb.

**Live site:** https://librecrawl.com | **License:** MIT

## Business Problem

SEO professionals need to audit websites for technical issues (broken links, missing meta tags, poor heading structure, slow pages, accessibility problems). Commercial tools are expensive and closed-source. LibreCrawl provides a free, self-hostable alternative with multi-tenant support, making it usable both as a personal tool and as a hosted service.

## Tech Stack

- **Backend:** Python 3.11, Flask, SQLite, Waitress (WSGI)
- **Frontend:** Vanilla JavaScript (no framework), HTML/CSS, Cytoscape.js (graph visualization)
- **JS Rendering:** Playwright (Chromium/Firefox/WebKit)
- **Deployment:** Docker + docker-compose, or direct Python
- **Auth:** bcrypt password hashing, email verification via SMTP

## Architecture Overview

```
main.py (Flask app, routes, export)
├── src/crawler.py          — Core crawling engine (ThreadPoolExecutor)
├── src/auth_db.py          — User auth & SQLite DB
├── src/crawl_db.py         — Crawl data persistence
├── src/settings_manager.py — Tier-based config management
├── src/email_service.py    — SMTP email verification
├── src/keyword_extractor.py— TF-IDF keyword extraction
├── src/gbp_extractor.py    — Google Business Profile extraction & Places API
└── src/core/
    ├── seo_extractor.py    — HTML metadata extraction
    ├── link_manager.py     — Link discovery & tracking
    ├── issue_detector.py   — 50+ SEO issue checks
    ├── js_renderer.py      — Playwright browser pool
    ├── rate_limiter.py     — Token bucket rate limiting
    ├── sitemap_parser.py   — Sitemap.xml discovery
    ├── memory_monitor.py   — OOM prevention
    └── memory_profiler.py  — Memory analysis

web/
├── templates/
│   ├── index.html          — Main crawler dashboard (primary UI)
│   ├── dashboard.html      — Crawl history view
│   ├── login.html / register.html — Auth pages
│   └── debug_memory.html   — Dev memory profiling
├── static/js/
│   ├── app.js              — Main app controller & state management
│   ├── dashboard.js        — Crawl history UI
│   ├── visualization.js    — Cytoscape network graph
│   ├── settings.js         — Settings modal & localStorage
│   ├── plugin-loader.js    — Plugin system (auto-discovery, lifecycle)
│   ├── virtual-scroller.js — Performance: renders only visible rows
│   ├── incremental_poller.js — Live crawl progress polling
│   └── column-resize.js    — Table column drag-resize
├── static/css/styles.css   — Dark theme, purple accents, glass-morphism
└── static/plugins/
    ├── e-e-a-t.js          — E-E-A-T score analyzer
    ├── seo-keywords.js     — Keyword extraction UI
    ├── seo-images.js       — Image SEO analysis
    ├── gbp-profile.js      — Google Business Profile lookup & NAP audit
    └── _example-plugin.js  — Plugin template (underscore = disabled)
```

## Key API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/start_crawl` | POST | Start new crawl |
| `/api/stop_crawl` | POST | Stop crawl |
| `/api/pause_crawl` / `resume_crawl` | POST | Pause/resume |
| `/api/crawl_status` | GET | Real-time crawl progress |
| `/api/crawls/list` | GET | List saved crawls |
| `/api/crawls/<id>/load` | POST | Load historical crawl |
| `/api/crawls/<id>/resume` | POST | Resume saved crawl |
| `/api/crawls/<id>/delete` | DELETE | Delete crawl |
| `/api/export_data` | POST | Export CSV/JSON/XML |
| `/api/keywords` | GET/POST | Keyword extraction |
| `/api/gbp` | GET/POST | GBP data for active crawl (GET) or saved crawl (POST) |
| `/api/gbp/<id>` | GET | GBP data for a specific saved crawl |
| `/api/gbp/photo` | GET | Proxy for Google Places photo URLs |
| `/api/visualization_data` | GET | Graph data for Cytoscape |
| `/api/get_settings` / `save_settings` | GET/POST | User settings |
| `/api/login` / `register` / `logout` | POST | Authentication |
| `/api/guest-login` | POST | Guest access (rate limited) |
| `/api/user/info` | GET | Current user details |

## Data Model

**SQLite database** (`data/users.db`) with tables:
- `users` — id, username, email, password_hash, tier, verified
- `crawls` — session metadata, status, config snapshot, memory stats
- `crawled_urls` — url, status_code, title, meta_description, h1, h2, h3, word_count, canonical, og_tags, json_ld, images, page_speed metrics, etc.
- `crawl_links` — source_url, target_url, anchor_text, placement
- `crawl_issues` — url, type, category, issue description, details
- `crawl_gbp_data` — cached GBP reports per crawl (UNIQUE on crawl_id)
- `guest_crawls` — IP-based rate limiting (3 crawls/24h)
- `verification_tokens` — email verification flow

## User Tiers

| Tier | Access |
|------|--------|
| Guest | 3 crawls/24h, no settings, IP rate-limited |
| User | Basic crawler + export + issue exclusion settings |
| Extra | + Requests, Filters, JS rendering, Custom CSS |
| Admin | Full access to all settings |

## Running the App

```bash
# Docker (recommended)
docker-compose up --build

# Direct Python
python main.py --local    # Local mode: auto-admin, no rate limits
python main.py            # Standard mode: full auth + rate limiting

# Flags
--local / -l              # Local/dev mode
--disable-register        # Disable new registrations
--disable-guest           # Disable guest login
```

## Plugin System

Plugins are JS files in `web/static/plugins/`. Files starting with `_` are ignored. Plugins register via `LibreCrawlPlugin.register({...})` and receive lifecycle hooks: `onLoad`, `onTabActivate`, `onTabDeactivate`, `onDataUpdate`, `onCrawlComplete`. Each plugin gets its own tab in the UI. Plugin loader is `web/static/js/plugin-loader.js` (392 lines).

### Plugin: E-E-A-T Analyzer (`web/static/plugins/e-e-a-t.js`, 478 lines)
- **ID:** `e-e-a-t` | **Tab:** "E-E-A-T" with icon
- Analyzes Google's Experience, Expertise, Authoritativeness, Trust signals
- **Scoring system (0-100 per page):** HTTPS (10pts), author info (20pts), JSON-LD schema (25pts), external links (up to 15pts), OG tags (10pts), content depth 300+ words (20pts)
- **UI sections:** Overall score card, pages with author/schema/citations stats, trust signals breakdown with progress bars, top 10 pages table, actionable recommendations (high/medium/low priority)
- **Key methods:** `analyzeEEAT(urls, links)` → returns analysis object, `generateRecommendations(analysis)` → priority-sorted list
- Pure client-side analysis — no backend API calls

### Plugin: SEO Keywords (`web/static/plugins/seo-keywords.js`, 529 lines)
- **ID:** `seo-keywords` | **Tab:** "Keywords" with key icon
- **Backend:** `src/keyword_extractor.py` (TF-IDF extraction) + `/api/keywords` endpoint
- **Features:** Word cloud (top 40 keywords, size-scaled by score), sortable table (rank, keyword, score, frequency, pages, sources), per-page keyword breakdown (collapsible, client-side extraction for top 50 URLs)
- **AI enhancement:** Settings panel for OpenAI/Claude/Gemini API key, calls `/api/keywords/ai` — adds category and relevance columns
- **Export:** CSV (server-side download), JSON (client-side blob), clipboard copy
- **State:** `keywordsData`, `sortColumn`, `sortDirection`, `settingsOpen`, `perPageOpen`, `highlightedKeyword`
- **Data flow:** `fetchKeywords()` tries GET `/api/keywords` first, falls back to POST with local URL data for saved crawls

### Plugin: SEO Images (`web/static/plugins/seo-images.js`, 503 lines)
- **ID:** `seo-images` | **Tab:** "Images" with frame icon
- **Features:** Image table with lazy-load previews (click camera icon to load), filter buttons (All / Missing Alt / Has Alt / Long Alt >80 chars), sortable columns (filename, page, alt, width, height), collapsible SEO Summary section
- **SEO Summary detects:** Missing alt text, long alt text (>80 chars), duplicate images across pages
- **Export:** CSV with columns: Image Name, Source URL, Page URL, Alt Text, Width, Height
- **Image filtering:** Skips SVGs and non-raster formats, allows dynamic URLs without extensions
- **State:** `imagesData`, `sortColumn`, `sortDirection`, `seoSummaryOpen`, `activeFilter`
- Pure client-side — extracts from `urlData.images[]` array, no backend API

### Plugin: Google Business Profile (`web/static/plugins/gbp-profile.js`, 735 lines)
- **ID:** `gbp-profile` | **Tab:** "GBP" with 📍 icon
- **Backend:** `src/gbp_extractor.py` (JSON-LD extraction, Google Places API New) + `/api/gbp`, `/api/gbp/<id>`, `/api/gbp/photo` endpoints
- **Features:** Extracts business entities from JSON-LD structured data, searches Google Places API for matching profiles, multi-branch detection (promotes multiple locations sharing the same website domain), NAP consistency audit
- **UI sections:** Extracted contact info card, branch overview table (multi-location), branch selector pills, stat cards (rating/reviews/status/price), business details, opening hours accordion, photos grid (lazy-loaded via proxy), reviews accordion, NAP audit (name/address/phone comparison between site and GBP)
- **API key:** Stored as `google_places_api_key` in user settings (Settings > Requests tab). Resolution order: request param → user DB settings → `GOOGLE_PLACES_API_KEY` env var. Without a key, shows extracted contact info only + banner
- **Research API integration:** `POST /api/research` accepts `google_places_api_key` in request body; GBP data returned in `response.gbp`
- **Caching:** Results cached in `crawl_gbp_data` table per crawl_id. Errors are not cached. Refresh button clears and re-fetches
- **State:** `gbpData`, `selectedBranchIndex`, `photosLoaded`, `reviewsOpen`, `hoursOpen`
- **Key functions (backend):** `extract_business_info(urls)` → scan JSON-LD for business types, `search_google_places(query, api_key)` → Text Search API, `match_place_to_branch(places, domain, branch)` → score by domain/phone/address/name match, `build_gbp_report(urls, api_key)` → orchestrator with multi-branch promotion

### Plugin: Example Template (`web/static/plugins/_example-plugin.js`, 298 lines)
- **ID:** `example-plugin` | Disabled (underscore prefix)
- Full template with documented data structure showing all available fields in `data.urls[]`, `data.links[]`, `data.issues[]`, `data.stats`
- Documents available utilities: `this.utils.showNotification()`, `this.utils.escapeHtml()`, `this.utils.formatUrl()`
- Documents plugin state: `this.isActive`, `this.container`, `this.id`, `this.name`, `this.version`

### Creating New Plugins
1. Copy `_example-plugin.js` → `my-plugin.js` (remove underscore)
2. Set unique `id`, `name`, `tab.label`
3. Implement `onTabActivate(container, data)` as the main render entry
4. Use `this.utils.escapeHtml()` for all user content to prevent XSS
5. Wrap content in `<div class="plugin-content" style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">`
6. Use dark theme colors: backgrounds `#1f2937`/`#0f172a`, text `#e5e7eb`/`#cbd5e1`/`#9ca3af`, borders `#374151`

## Code Conventions

- No test suite exists — no tests/ directory or test files
- Backend is monolithic Flask (`main.py` ~1600 lines, `crawler.py` ~1400 lines)
- Frontend is vanilla JS with no build step — edit and reload
- State management via global `crawlState` object in `app.js`
- Settings stored in both browser localStorage and server-side SQLite
- Thread-safe crawling with locks on shared data structures
- Database batch saves (50 URLs or 30s intervals) for performance

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `PORT` | No | Server port (default: 5000) |
| `LOCAL_MODE` | No | Enable local/dev mode (default: false) |
| `GOOGLE_PLACES_API_KEY` | No | Server-wide default for GBP plugin |

## Current State (as of recent commits)

- Google Business Profile plugin added — extracts business info from JSON-LD, searches Google Places API, multi-branch detection, NAP audit
- Plugin system added for SEO keyword extraction and image analysis
- robots.txt handling fixed (urllib User-Agent issue)
- Visualization hierarchy rendering fixed
- `--disable-guest` flag added
- New files: `src/gbp_extractor.py`, `src/keyword_extractor.py`, `web/static/plugins/gbp-profile.js`, `web/static/plugins/seo-images.js`, `web/static/plugins/seo-keywords.js`
- Modified JS files: `app.js`, `dashboard.js`, `plugin-loader.js`, `visualization.js`, `settings.js`, `column-resize.js`
