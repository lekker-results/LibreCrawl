/**
 * SEO Keywords Analyzer Plugin for LibreCrawl
 * Extracts and displays keyword analysis via REST API
 *
 * @author LibreCrawl Community
 * @version 1.1.0
 */

LibreCrawlPlugin.register({
    id: 'seo-keywords',
    name: 'SEO Keywords',
    version: '1.1.0',
    author: 'LibreCrawl Community',
    description: 'Competitor keyword research: word cloud, sortable table, CSV/JSON export, and AI-enhanced analysis',

    tab: {
        label: 'Keywords',
        icon: '\uD83D\uDD11',
        position: 'end'
    },

    // State
    keywordsData: null,
    aiKeywordsData: null,
    storedPageKeywords: {},
    sortColumn: 'score',
    sortDirection: 'desc',
    aiSortColumn: 'score',
    aiSortDirection: 'desc',
    settingsOpen: false,
    perPageOpen: false,
    extractedOpen: false,
    aiOpen: true,
    highlightedKeyword: null,
    _expandedKeyword: null,
    lastError: null,

    onLoad() {
        console.log('\uD83D\uDD11 SEO Keywords plugin loaded');
    },

    onTabActivate(container, data) {
        this.container = container;
        this.currentData = data;
        container.innerHTML = '<div class="plugin-content" style="padding: 40px; text-align: center;"><div class="loading-spinner"></div><div style="color:var(--text-primary);font-size:15px;">Extracting keywords...</div></div>';
        Promise.all([
            this.fetchKeywords(data),
            this.fetchStoredAIKeywords()
        ]).then(() => this.render(container));
    },

    onCrawlComplete(data) {
        this.currentData = data;
        if (this.isActive && this.container) {
            this.fetchKeywords(data).then(() => this.render(this.container));
        }
    },

    onDataUpdate(data) {
        const prevUrls = this.currentData && this.currentData.urls ? this.currentData.urls.length : 0;
        const newUrls = data && data.urls ? data.urls.length : 0;
        this.currentData = data;

        if (this.isActive && this.container && newUrls > 0 && (prevUrls === 0 || Math.abs(newUrls - prevUrls) > prevUrls * 0.5)) {
            Promise.all([
                this.fetchKeywords(data),
                this.fetchStoredAIKeywords()
            ]).then(() => this.render(this.container));
        }
    },

    async fetchKeywords(data) {
        try {
            const resp = await fetch('/api/keywords?limit=100');
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const result = await resp.json();

            if (result.keywords && result.keywords.length > 0) {
                this.keywordsData = result;
                return;
            }

            if (data && data.urls && data.urls.length > 0) {
                const postResp = await fetch('/api/keywords', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: data.urls, links: data.links || [], limit: 100 })
                });
                if (postResp.ok) {
                    this.keywordsData = await postResp.json();
                    return;
                }
            }

            this.keywordsData = result;
        } catch (e) {
            console.error('Failed to fetch keywords:', e);
            this.keywordsData = null;
        }
    },

    async fetchStoredAIKeywords() {
        try {
            const resp = await fetch('/api/keywords/ai/stored');
            if (!resp.ok) return;
            const result = await resp.json();
            if (result.keywords && result.keywords.length > 0) {
                this.aiKeywordsData = {
                    keywords: result.keywords,
                    provider: result.provider,
                    analyzed_at: result.analyzed_at,
                };
            }
            if (result.page_keywords) {
                this.storedPageKeywords = result.page_keywords;
            }
        } catch (e) {
            console.error('Failed to fetch stored AI keywords:', e);
        }
    },

    async fetchAIKeywords() {
        const provider = localStorage.getItem('kw_ai_provider') || 'openai';
        const apiKey = localStorage.getItem('kw_ai_key') || '';
        if (!apiKey) {
            this._showError('Please set an API key in Settings before running AI analysis.');
            return;
        }
        this.lastError = null;
        try {
            const resp = await fetch(`/api/keywords/ai?provider=${encodeURIComponent(provider)}&api_key=${encodeURIComponent(apiKey)}`);
            const text = await resp.text();
            let result;
            try {
                result = JSON.parse(text);
            } catch {
                throw new Error(`Server returned invalid response: ${text.substring(0, 300)}`);
            }
            if (!resp.ok) {
                throw new Error(result.error || `HTTP ${resp.status}`);
            }
            this.aiKeywordsData = {
                keywords: result.keywords,
                provider: result.provider,
                analyzed_at: result.analyzed_at,
                domain: result.domain,
                pages_analyzed: result.pages_analyzed,
            };
            this.aiOpen = true;
            this.render(this.container);
        } catch (e) {
            console.error('AI analysis failed:', e);
            this._showError('AI analysis failed: ' + e.message);
        }
    },

    _showError(message) {
        this.lastError = message;
        if (this.container) {
            // Remove any existing error banner
            const existing = this.container.querySelector('#kw-error-banner');
            if (existing) existing.remove();

            const banner = document.createElement('div');
            banner.id = 'kw-error-banner';
            banner.style.cssText = 'background: rgba(239,68,68,0.15); border: 1px solid var(--status-error); color: var(--text-primary); padding: 16px 20px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; line-height: 1.5; word-break: break-word; position: relative;';
            banner.innerHTML = `
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;">
                    <div><strong style="color: var(--status-error);">Error:</strong> ${this.utils.escapeHtml(message)}</div>
                    <button id="kw-error-dismiss" style="background: none; border: none; color: var(--status-error); cursor: pointer; font-size: 18px; line-height: 1; flex-shrink: 0;">&times;</button>
                </div>
            `;
            const content = this.container.querySelector('.plugin-content');
            if (content && content.firstChild) {
                content.insertBefore(banner, content.children[1] || null);
            } else if (content) {
                content.appendChild(banner);
            }
            const dismiss = banner.querySelector('#kw-error-dismiss');
            if (dismiss) dismiss.addEventListener('click', () => { banner.remove(); this.lastError = null; });
        }
    },

    render(container) {
        if (!this.keywordsData || !this.keywordsData.keywords || this.keywordsData.keywords.length === 0) {
            container.innerHTML = this.renderEmptyState();
            return;
        }

        const kw = this.keywordsData;
        const keywords = kw.keywords;

        container.innerHTML = `
            <style>
                .kw-accordion-header {
                    font-size: 18px; font-weight: 600; color: var(--text-body); cursor: pointer; user-select: none;
                    display: flex; align-items: center; gap: 8px;
                }
                .kw-accordion-header:hover { color: var(--text-primary); }
            </style>
            <div class="plugin-content" style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">
                ${this.renderHeader()}
                ${this.renderSettingsPanel()}
                ${this.renderStatCards(keywords, kw)}
                ${this.renderExportBar(kw.domain)}
                ${this.renderWordCloud(keywords)}
                ${this.renderAIKeywordsAccordion()}
                ${this.renderExtractedKeywordsAccordion(keywords)}
                ${this.renderPerPageBreakdown()}
            </div>
        `;

        this.bindEvents(container);

        if (this.lastError) {
            this._showError(this.lastError);
        }
    },

    renderHeader() {
        const hasAI = this.aiKeywordsData && this.aiKeywordsData.keywords && this.aiKeywordsData.keywords.length > 0;
        const aiLabel = hasAI ? 'Re-analyze with AI' : 'Analyze with AI';
        return `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px;">
                <div>
                    <h2 style="font-size: 28px; font-weight: 700; margin-bottom: 8px; color: var(--text-body);">
                        \uD83D\uDD11 SEO Keywords
                    </h2>
                    <p style="color: var(--text-muted); font-size: 14px;">
                        Competitor keyword analysis from crawled pages
                    </p>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                    <button id="kw-ai-analyze-main" style="background: var(--accent-1); color: var(--text-primary); border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap;">
                        ${aiLabel}
                    </button>
                    <button id="kw-settings-toggle" style="background: var(--bg-elevated); border: 1px solid var(--border-standard); color: var(--text-body); padding: 10px 12px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                        \u2699\uFE0F
                    </button>
                </div>
            </div>
        `;
    },

    renderSettingsPanel() {
        const provider = localStorage.getItem('kw_ai_provider') || 'openai';
        const apiKey = localStorage.getItem('kw_ai_key') || '';
        const display = this.settingsOpen ? 'block' : 'none';

        return `
            <div id="kw-settings-panel" style="display: ${display}; background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 24px;">
                <h3 style="font-size: 16px; font-weight: 600; color: var(--text-body); margin-bottom: 16px;">AI Analysis Settings</h3>
                <div style="display: flex; gap: 16px; flex-wrap: wrap; align-items: flex-end;">
                    <div style="flex: 1; min-width: 150px;">
                        <label style="display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px;">Provider</label>
                        <select id="kw-ai-provider" style="width: 100%; background: var(--bg-base); border: 1px solid var(--border-alt); color: var(--text-body); padding: 8px 12px; border-radius: 6px; font-size: 14px;">
                            <option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option>
                            <option value="claude" ${provider === 'claude' ? 'selected' : ''}>Claude</option>
                            <option value="gemini" ${provider === 'gemini' ? 'selected' : ''}>Gemini</option>
                        </select>
                    </div>
                    <div style="flex: 2; min-width: 200px;">
                        <label style="display: block; font-size: 13px; color: var(--text-muted); margin-bottom: 6px;">API Key</label>
                        <input type="password" id="kw-ai-key" value="${this.utils.escapeHtml(apiKey)}" placeholder="Enter API key..."
                            style="width: 100%; background: var(--bg-base); border: 1px solid var(--border-alt); color: var(--text-body); padding: 8px 12px; border-radius: 6px; font-size: 14px; box-sizing: border-box;" />
                    </div>
                    <button id="kw-settings-save" style="background: var(--status-success); color: white; border: none; padding: 9px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600; white-space: nowrap;">
                        Save
                    </button>
                </div>
            </div>
        `;
    },

    renderStatCards(keywords, data) {
        const total = keywords.length;
        const topKw = keywords[0] ? keywords[0].keyword : '-';
        const uniqueSources = new Set();
        keywords.forEach(k => (k.sources || []).forEach(s => uniqueSources.add(s)));
        const diversity = uniqueSources.size;
        const pages = data.pages_analyzed || 0;

        const cards = [
            { label: 'Total Keywords', value: total, sub: 'extracted from crawl' },
            { label: 'Top Keyword', value: topKw, sub: keywords[0] ? `score: ${keywords[0].score}` : '', small: true },
            { label: 'Source Diversity', value: diversity, sub: 'unique source types' },
            { label: 'Pages Analyzed', value: pages, sub: 'crawled pages' },
        ];

        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">
                ${cards.map(c => `
                    <div style="background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt);">
                        <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px;">${c.label}</div>
                        <div style="font-size: ${c.small ? '20px' : '36px'}; font-weight: 700; color: var(--text-body); margin-bottom: 6px; ${c.small ? 'word-break: break-word;' : ''}">${this.utils.escapeHtml(String(c.value))}</div>
                        <div style="font-size: 12px; color: var(--text-dim);">${c.sub}</div>
                    </div>
                `).join('')}
            </div>
        `;
    },

    renderExportBar(domain) {
        return `
            <div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">
                <button id="kw-export-csv" style="background: var(--bg-elevated); border: 1px solid var(--border-standard); color: var(--text-body); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
                    Export CSV
                </button>
                <button id="kw-export-json" style="background: var(--bg-elevated); border: 1px solid var(--border-standard); color: var(--text-body); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
                    Export JSON
                </button>
                <button id="kw-copy-clipboard" style="background: var(--bg-elevated); border: 1px solid var(--border-standard); color: var(--text-body); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
                    Copy to Clipboard
                </button>
            </div>
        `;
    },

    renderWordCloud(keywords) {
        const top = keywords.slice(0, 40);
        if (top.length === 0) return '';

        const maxScore = top[0].score;
        const minScore = top[top.length - 1].score;
        const range = maxScore - minScore || 1;
        const colors = ['#6366f1', '#8b5cf6', '#a78bfa', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6'];

        const spans = top.map((kw, i) => {
            const size = 14 + Math.round(((kw.score - minScore) / range) * 42);
            const color = colors[i % colors.length];
            const highlighted = this.highlightedKeyword === kw.keyword ? 'text-decoration: underline; opacity: 1;' : 'opacity: 0.85;';
            return `<span class="kw-cloud-word" data-keyword="${this.utils.escapeHtml(kw.keyword)}"
                style="display: inline-block; font-size: ${size}px; color: ${color}; padding: 4px 10px; cursor: pointer; transition: opacity 0.2s; ${highlighted} font-weight: ${size > 30 ? '700' : '500'};"
                title="Score: ${kw.score} | Freq: ${kw.frequency} | Pages: ${kw.pages}">${this.utils.escapeHtml(kw.keyword)}</span>`;
        });

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 24px; text-align: center; line-height: 2.2;">
                <h3 style="font-size: 18px; font-weight: 600; color: var(--text-body); margin-bottom: 16px; text-align: left;">Word Cloud</h3>
                ${spans.join(' ')}
            </div>
        `;
    },

    renderAIKeywordsAccordion() {
        const hasData = this.aiKeywordsData && this.aiKeywordsData.keywords && this.aiKeywordsData.keywords.length > 0;
        if (!hasData) return '';

        const arrow = this.aiOpen ? '\u25BC' : '\u25B6';

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--accent-1); margin-bottom: 24px;">
                <h3 id="kw-ai-accordion-toggle" class="kw-accordion-header">
                    <span id="kw-ai-arrow">${arrow}</span> AI Analyzed Keywords
                    <span style="font-size: 12px; font-weight: 400; color: var(--accent-stat); margin-left: 8px;">${this.aiKeywordsData.keywords.length} keywords</span>
                </h3>
                <div id="kw-ai-accordion-content" style="${this.aiOpen ? '' : 'display: none;'} margin-top: 16px;">
                    ${this.aiOpen ? this._buildAITableHtml() : ''}
                </div>
            </div>
        `;
    },

    _buildAITableHtml() {
        if (!this.aiKeywordsData || !this.aiKeywordsData.keywords) return '';
        const keywords = this.aiKeywordsData.keywords;
        const sorted = [...keywords].sort((a, b) => {
            let aVal = a[this.aiSortColumn];
            let bVal = b[this.aiSortColumn];
            if (typeof aVal === 'string') aVal = aVal.toLowerCase();
            if (typeof bVal === 'string') bVal = bVal.toLowerCase();
            if (this.aiSortDirection === 'asc') return aVal > bVal ? 1 : -1;
            return aVal < bVal ? 1 : -1;
        });

        const arrowIcon = (col) => this.aiSortColumn === col ? (this.aiSortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';
        const thStyle = 'padding: 12px; text-align: left; color: var(--text-muted); font-size: 13px; font-weight: 600; cursor: pointer; user-select: none;';
        const tdStyle = 'padding: 12px; color: var(--text-secondary); font-size: 13px;';

        const rows = sorted.map((kw, i) => `
            <tr style="border-bottom: 1px solid var(--border-alt);">
                <td style="${tdStyle}">${kw.rank || i + 1}</td>
                <td style="${tdStyle} font-weight: 600;">${this.utils.escapeHtml(kw.keyword)}</td>
                <td style="${tdStyle}">${kw.score}</td>
                <td style="${tdStyle}">${this.utils.escapeHtml(kw.category || '')}</td>
                <td style="${tdStyle} max-width: 300px; white-space: normal; line-height: 1.4;" title="${this.utils.escapeHtml(kw.relevance || '')}">${this.utils.escapeHtml(kw.relevance || '')}</td>
            </tr>
        `).join('');

        const analyzedAt = this.aiKeywordsData.analyzed_at ? ` \u2014 ${new Date(this.aiKeywordsData.analyzed_at).toLocaleString()}` : '';

        return `
            <p style="font-size: 12px; color: var(--text-dim); margin-bottom: 12px;">Provider: ${this.utils.escapeHtml(this.aiKeywordsData.provider || 'unknown')}${analyzedAt}</p>
            <div style="overflow-x: auto;">
                <table id="kw-ai-table" style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="border-bottom: 1px solid var(--border-alt);">
                            <th style="${thStyle}" data-sort="rank">Rank${arrowIcon('rank')}</th>
                            <th style="${thStyle}" data-sort="keyword">Keyword${arrowIcon('keyword')}</th>
                            <th style="${thStyle}" data-sort="score">Score${arrowIcon('score')}</th>
                            <th style="${thStyle}" data-sort="category">Category${arrowIcon('category')}</th>
                            <th style="${thStyle}" data-sort="relevance">Relevance${arrowIcon('relevance')}</th>
                        </tr>
                    </thead>
                    <tbody id="kw-ai-table-body">${rows}</tbody>
                </table>
            </div>
        `;
    },

    renderExtractedKeywordsAccordion(keywords) {
        const arrow = this.extractedOpen ? '\u25BC' : '\u25B6';

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 24px;">
                <h3 id="kw-extracted-accordion-toggle" class="kw-accordion-header">
                    <span id="kw-extracted-arrow">${arrow}</span> Extracted Keywords
                    <span style="font-size: 12px; font-weight: 400; color: var(--text-muted); margin-left: 8px;">${keywords.length} keywords</span>
                </h3>
                <div id="kw-extracted-accordion-content" style="${this.extractedOpen ? '' : 'display: none;'} margin-top: 16px;">
                    ${this.extractedOpen ? this._buildExtractedTableHtml() : ''}
                </div>
            </div>
        `;
    },

    _buildExtractedTableHtml() {
        if (!this.keywordsData || !this.keywordsData.keywords) return '';
        return `
            <p style="font-size: 13px; color: var(--text-dim); margin-bottom: 16px;">
                <strong style="color: var(--text-muted);">Score</strong> \u2014 TF-IDF weighted relevance across titles, headings, meta tags.
                <strong style="color: var(--text-muted);">Freq</strong> \u2014 total occurrences across all pages.
                Click a row to see per-source score breakdown.
            </p>
            <div style="overflow-x: auto;">
                <table id="kw-table" style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="border-bottom: 1px solid var(--border-alt);">
                            ${this._buildExtractedTableHeaders()}
                        </tr>
                    </thead>
                    <tbody id="kw-table-body">${this._buildExtractedTableRows()}</tbody>
                </table>
            </div>
        `;
    },

    _buildExtractedTableHeaders() {
        const arrowIcon = (col) => this.sortColumn === col ? (this.sortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';
        const thStyle = 'padding: 12px; text-align: left; color: var(--text-muted); font-size: 13px; font-weight: 600; cursor: pointer; user-select: none;';
        return `
            <th style="${thStyle}" data-sort="rank">Rank${arrowIcon('rank')}</th>
            <th style="${thStyle}" data-sort="keyword">Keyword${arrowIcon('keyword')}</th>
            <th style="${thStyle}" data-sort="score">Score${arrowIcon('score')}</th>
            <th style="${thStyle}" data-sort="frequency">Freq${arrowIcon('frequency')}</th>
            <th style="${thStyle}" data-sort="pages">Pages${arrowIcon('pages')}</th>
            <th style="${thStyle}" data-sort="sources">Sources${arrowIcon('sources')}</th>
        `;
    },

    _buildExtractedTableRows() {
        const keywords = this.keywordsData.keywords;
        const sorted = [...keywords].sort((a, b) => {
            let aVal = a[this.sortColumn];
            let bVal = b[this.sortColumn];
            if (typeof aVal === 'string') aVal = aVal.toLowerCase();
            if (typeof bVal === 'string') bVal = bVal.toLowerCase();
            if (this.sortDirection === 'asc') return aVal > bVal ? 1 : -1;
            return aVal < bVal ? 1 : -1;
        });

        const tdStyle = 'padding: 12px; color: var(--text-secondary); font-size: 13px;';
        const sourceLabels = {
            title: 'Title', h1: 'H1', h2: 'H2', h3: 'H3',
            meta_description: 'Meta Desc', keywords: 'Meta Keywords',
            anchor_text: 'Anchor Text', alt_text: 'Alt Text'
        };
        const sourceWeights = {
            title: 3.0, h1: 2.5, meta_description: 2.0, keywords: 2.0,
            h2: 1.5, anchor_text: 1.5, h3: 1.0, alt_text: 0.8
        };

        return sorted.map((kw, i) => {
            const highlight = this.highlightedKeyword === kw.keyword ? 'background: var(--bg-elevated);' : '';
            const sources = Array.isArray(kw.sources) ? kw.sources.join(', ') : (kw.sources || '');
            const isExpanded = this._expandedKeyword === kw.keyword;

            let detailRow = '';
            if (isExpanded && kw.source_scores) {
                const bars = Object.entries(sourceLabels)
                    .filter(([key]) => kw.source_scores[key])
                    .map(([key, label]) => {
                        const val = kw.source_scores[key];
                        const maxVal = kw.score || 1;
                        const pct = Math.min(100, Math.round((val / maxVal) * 100));
                        const weight = sourceWeights[key] || 1.0;
                        return `
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                                <span style="width: 90px; font-size: 12px; color: var(--text-muted); text-align: right; flex-shrink: 0;">${label} <span style="color: var(--text-dim);">(${weight}x)</span></span>
                                <div style="flex: 1; height: 16px; background: var(--border-alt); border-radius: 4px; overflow: hidden;">
                                    <div style="height: 100%; width: ${pct}%; background: var(--accent-1); border-radius: 4px; transition: width 0.3s;"></div>
                                </div>
                                <span style="width: 45px; font-size: 12px; color: var(--text-secondary); text-align: right; flex-shrink: 0;">${val}</span>
                            </div>
                        `;
                    }).join('');

                detailRow = `
                    <tr class="kw-detail-row" data-detail-for="${this.utils.escapeHtml(kw.keyword)}">
                        <td colspan="6" style="padding: 8px 12px 16px 40px; background: var(--bg-base); border-bottom: 1px solid var(--border-alt);">
                            <div style="max-width: 500px;">
                                <div style="font-size: 11px; color: var(--text-dim); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">Score by source</div>
                                ${bars || '<span style="font-size: 12px; color: var(--text-dim);">No per-source data available</span>'}
                            </div>
                        </td>
                    </tr>
                `;
            }

            return `
                <tr class="kw-expandable-row" style="border-bottom: ${isExpanded ? 'none' : '1px solid var(--border-alt)'}; ${highlight} cursor: pointer;" data-keyword="${this.utils.escapeHtml(kw.keyword)}">
                    <td style="${tdStyle}">${kw.rank || i + 1}</td>
                    <td style="${tdStyle} font-weight: 600;">${this.utils.escapeHtml(kw.keyword)}</td>
                    <td style="${tdStyle}">${kw.score}</td>
                    <td style="${tdStyle}">${kw.frequency || ''}</td>
                    <td style="${tdStyle}">${kw.pages || ''}</td>
                    <td style="${tdStyle} font-size: 12px; color: var(--text-dim);">${this.utils.escapeHtml(sources)}</td>
                </tr>
                ${detailRow}
            `;
        }).join('');
    },

    renderPerPageBreakdown() {
        if (!this.currentData || !this.currentData.urls || this.currentData.urls.length === 0) return '';

        const arrow = this.perPageOpen ? '\u25BC' : '\u25B6';

        let pageRows = '';
        if (this.perPageOpen) {
            const urls = this.currentData.urls;

            pageRows = urls.slice(0, 50).map((url, idx) => {
                const pageUrl = url.url || '';
                const storedAI = this.storedPageKeywords[pageUrl];
                let keywordsHtml;

                if (storedAI && storedAI.length > 0) {
                    keywordsHtml = storedAI.map(kw =>
                        `<span style="background: var(--accent-1); color: var(--text-primary); padding: 2px 10px; border-radius: 12px; font-size: 12px;" title="Score: ${kw.score} | ${this.utils.escapeHtml(kw.category || '')} \u2014 ${this.utils.escapeHtml(kw.relevance || '')}">${this.utils.escapeHtml(kw.keyword)}</span>`
                    ).join('');
                } else {
                    const tokens = this._clientExtractTopKeywords(url, 5);
                    if (tokens.length === 0) return '';
                    keywordsHtml = tokens.map(t =>
                        `<span style="background: var(--bg-elevated); color: var(--text-body); padding: 2px 10px; border-radius: 12px; font-size: 12px;">${this.utils.escapeHtml(t)}</span>`
                    ).join('');
                }

                const btnLabel = storedAI ? 'Re-analyze' : 'AI Analyze';
                const btnBg = storedAI ? 'var(--status-success)' : 'var(--accent-1)';

                return `
                    <div class="kw-perpage-row" data-page-idx="${idx}" style="background: var(--bg-base); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border-alt);">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                            <div style="font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px;" title="${this.utils.escapeHtml(pageUrl)}">
                                ${this.utils.escapeHtml(pageUrl)}
                            </div>
                            <button class="kw-ai-page-btn" data-url="${this.utils.escapeHtml(pageUrl)}" data-idx="${idx}"
                                style="background: ${btnBg}; color: var(--text-primary); border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; white-space: nowrap; flex-shrink: 0;">
                                ${btnLabel}
                            </button>
                        </div>
                        <div class="kw-perpage-keywords" style="display: flex; gap: 8px; flex-wrap: wrap;">
                            ${keywordsHtml}
                        </div>
                    </div>
                `;
            }).join('');
        }

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt);">
                <h3 id="kw-perpage-toggle" class="kw-accordion-header">
                    <span id="kw-perpage-arrow">${arrow}</span> Per-Page Keyword Breakdown
                </h3>
                <div id="kw-perpage-content" style="${this.perPageOpen ? 'display: flex;' : 'display: none;'} margin-top: 16px; flex-direction: column; gap: 10px;">
                    ${pageRows}
                </div>
            </div>
        `;
    },

    _clientExtractTopKeywords(urlData, limit) {
        const stopwords = new Set(['a','an','the','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','are','were','be','have','has','had','do','does','did','will','would','could','should','it','its','he','she','we','they','me','him','her','us','them','my','your','his','our','their','this','that','these','those','i','you','what','which','who','when','where','why','how','all','each','both','few','more','most','other','some','no','not','only','so','than','too','very','just','if','about','up','out','off','over','under','again','here','there','any','also','after','before','page','site','click','read','home','contact','menu','skip','main','content','search','close','open','next','previous']);
        const fields = [
            urlData.title || '',
            urlData.h1 || '',
            urlData.meta_description || '',
            ...(urlData.h2 || []),
            ...(urlData.h3 || [])
        ];
        const counts = {};
        fields.forEach(text => {
            if (!text) return;
            text.toLowerCase().replace(/[^\w\s-]/g, ' ').split(/\s+/).forEach(token => {
                if (token.length > 1 && !stopwords.has(token) && !/^\d+$/.test(token)) {
                    counts[token] = (counts[token] || 0) + 1;
                }
            });
        });
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(e => e[0]);
    },

    bindEvents(container) {
        const self = this;

        // Settings toggle
        const settingsBtn = container.querySelector('#kw-settings-toggle');
        if (settingsBtn) {
            settingsBtn.addEventListener('click', () => {
                self.settingsOpen = !self.settingsOpen;
                const panel = container.querySelector('#kw-settings-panel');
                if (panel) panel.style.display = self.settingsOpen ? 'block' : 'none';
            });
        }

        // AI provider/key save
        const providerSelect = container.querySelector('#kw-ai-provider');
        const keyInput = container.querySelector('#kw-ai-key');
        if (providerSelect) {
            providerSelect.addEventListener('change', () => localStorage.setItem('kw_ai_provider', providerSelect.value));
        }
        if (keyInput) {
            keyInput.addEventListener('change', () => localStorage.setItem('kw_ai_key', keyInput.value.trim()));
        }

        // Settings save button
        const saveBtn = container.querySelector('#kw-settings-save');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (providerSelect) localStorage.setItem('kw_ai_provider', providerSelect.value);
                if (keyInput) localStorage.setItem('kw_ai_key', keyInput.value.trim());
                self.utils.showNotification('Settings saved', 'success');
                self.settingsOpen = false;
                const panel = container.querySelector('#kw-settings-panel');
                if (panel) panel.style.display = 'none';
            });
        }

        // Main AI analyze button (in header)
        const aiMainBtn = container.querySelector('#kw-ai-analyze-main');
        if (aiMainBtn) {
            aiMainBtn.addEventListener('click', () => {
                if (providerSelect) localStorage.setItem('kw_ai_provider', providerSelect.value);
                if (keyInput) localStorage.setItem('kw_ai_key', keyInput.value.trim());

                const apiKey = localStorage.getItem('kw_ai_key') || '';
                if (!apiKey) {
                    self.settingsOpen = true;
                    const panel = container.querySelector('#kw-settings-panel');
                    if (panel) panel.style.display = 'block';
                    self._showError('Please enter an API key in Settings first.');
                    return;
                }

                aiMainBtn.textContent = 'Analyzing...';
                aiMainBtn.disabled = true;
                aiMainBtn.style.opacity = '0.7';
                self.fetchAIKeywords().finally(() => {
                    aiMainBtn.textContent = self.aiKeywordsData ? 'Re-analyze with AI' : 'Analyze with AI';
                    aiMainBtn.disabled = false;
                    aiMainBtn.style.opacity = '1';
                });
            });
        }

        // Export CSV
        const csvBtn = container.querySelector('#kw-export-csv');
        if (csvBtn) csvBtn.addEventListener('click', () => self.exportCSV());

        // Export JSON
        const jsonBtn = container.querySelector('#kw-export-json');
        if (jsonBtn) jsonBtn.addEventListener('click', () => self.exportJSON());

        // Copy to clipboard
        const copyBtn = container.querySelector('#kw-copy-clipboard');
        if (copyBtn) copyBtn.addEventListener('click', () => self.copyToClipboard());

        // Word cloud click -> highlight
        container.querySelectorAll('.kw-cloud-word').forEach(span => {
            span.addEventListener('click', () => {
                const kw = span.dataset.keyword;
                self.highlightedKeyword = self.highlightedKeyword === kw ? null : kw;
                self.render(container);
            });
        });

        // AI keywords accordion
        const aiToggle = container.querySelector('#kw-ai-accordion-toggle');
        if (aiToggle) {
            aiToggle.addEventListener('click', () => {
                self.aiOpen = !self.aiOpen;
                self._toggleAccordion(container, 'kw-ai-arrow', 'kw-ai-accordion-content', self.aiOpen, () => self._buildAITableHtml());
                if (self.aiOpen) self._bindAITableSort(container);
            });
        }

        // AI table sorting
        this._bindAITableSort(container);

        // Extracted keywords accordion
        const extractedToggle = container.querySelector('#kw-extracted-accordion-toggle');
        if (extractedToggle) {
            extractedToggle.addEventListener('click', () => {
                self.extractedOpen = !self.extractedOpen;
                self._toggleAccordion(container, 'kw-extracted-arrow', 'kw-extracted-accordion-content', self.extractedOpen, () => self._buildExtractedTableHtml());
                if (self.extractedOpen) {
                    self._bindExtractedTableSort(container);
                    self._bindExtractedRowExpand(container);
                }
            });
        }

        // Extracted table sorting + row expand
        this._bindExtractedTableSort(container);
        this._bindExtractedRowExpand(container);

        // Per-page toggle
        const perPageToggle = container.querySelector('#kw-perpage-toggle');
        if (perPageToggle) {
            perPageToggle.addEventListener('click', () => {
                self.perPageOpen = !self.perPageOpen;
                self._togglePerPage(container);
            });
        }

        // Per-page AI buttons
        this._bindPerPageAIButtons(container);
    },

    _toggleAccordion(container, arrowId, contentId, isOpen, buildContentFn) {
        const arrow = container.querySelector('#' + arrowId);
        const content = container.querySelector('#' + contentId);
        if (!arrow || !content) return;

        arrow.textContent = isOpen ? '\u25BC' : '\u25B6';
        if (isOpen) {
            content.innerHTML = buildContentFn();
            content.style.display = '';
        } else {
            content.style.display = 'none';
        }
    },

    _bindAITableSort(container) {
        const self = this;
        const aiTable = container.querySelector('#kw-ai-table');
        if (!aiTable) return;
        aiTable.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const col = th.dataset.sort;
                if (self.aiSortColumn === col) {
                    self.aiSortDirection = self.aiSortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    self.aiSortColumn = col;
                    self.aiSortDirection = 'desc';
                }
                self._updateAITableSort(container);
            });
        });
    },

    _updateAITableSort(container) {
        if (!this.aiKeywordsData || !this.aiKeywordsData.keywords) return;
        const keywords = this.aiKeywordsData.keywords;
        const sorted = [...keywords].sort((a, b) => {
            let aVal = a[this.aiSortColumn];
            let bVal = b[this.aiSortColumn];
            if (typeof aVal === 'string') aVal = aVal.toLowerCase();
            if (typeof bVal === 'string') bVal = bVal.toLowerCase();
            if (this.aiSortDirection === 'asc') return aVal > bVal ? 1 : -1;
            return aVal < bVal ? 1 : -1;
        });

        const tdStyle = 'padding: 12px; color: var(--text-secondary); font-size: 13px;';
        const rows = sorted.map((kw, i) => `
            <tr style="border-bottom: 1px solid var(--border-alt);">
                <td style="${tdStyle}">${kw.rank || i + 1}</td>
                <td style="${tdStyle} font-weight: 600;">${this.utils.escapeHtml(kw.keyword)}</td>
                <td style="${tdStyle}">${kw.score}</td>
                <td style="${tdStyle}">${this.utils.escapeHtml(kw.category || '')}</td>
                <td style="${tdStyle} max-width: 300px; white-space: normal; line-height: 1.4;" title="${this.utils.escapeHtml(kw.relevance || '')}">${this.utils.escapeHtml(kw.relevance || '')}</td>
            </tr>
        `).join('');

        const tbody = container.querySelector('#kw-ai-table-body');
        if (tbody) tbody.innerHTML = rows;

        const arrowIcon = (col) => this.aiSortColumn === col ? (this.aiSortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';
        const headerLabels = { rank: 'Rank', keyword: 'Keyword', score: 'Score', category: 'Category', relevance: 'Relevance' };
        container.querySelectorAll('#kw-ai-table th[data-sort]').forEach(th => {
            const col = th.dataset.sort;
            th.textContent = (headerLabels[col] || col) + arrowIcon(col);
        });
    },

    _bindExtractedTableSort(container) {
        const self = this;
        const table = container.querySelector('#kw-table');
        if (!table) return;
        table.querySelectorAll('th[data-sort]').forEach(th => {
            th.addEventListener('click', (e) => {
                e.stopPropagation();
                const col = th.dataset.sort;
                if (self.sortColumn === col) {
                    self.sortDirection = self.sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    self.sortColumn = col;
                    self.sortDirection = 'desc';
                }
                self._updateExtractedTableSort(container);
            });
        });
    },

    _updateExtractedTableSort(container) {
        if (!this.keywordsData || !this.keywordsData.keywords) return;

        const tbody = container.querySelector('#kw-table-body');
        if (tbody) {
            tbody.innerHTML = this._buildExtractedTableRows();
            this._bindExtractedRowExpand(container);
        }

        // Update header arrows
        const thead = container.querySelector('#kw-table thead tr');
        if (thead) thead.innerHTML = this._buildExtractedTableHeaders();
        this._bindExtractedTableSort(container);
    },

    _bindExtractedRowExpand(container) {
        const self = this;
        container.querySelectorAll('#kw-table .kw-expandable-row').forEach(tr => {
            tr.addEventListener('click', () => {
                const kw = tr.dataset.keyword;
                self._expandedKeyword = self._expandedKeyword === kw ? null : kw;
                // Re-render just the tbody and re-bind
                const tbody = container.querySelector('#kw-table-body');
                if (tbody) {
                    tbody.innerHTML = self._buildExtractedTableRows();
                    self._bindExtractedRowExpand(container);
                }
            });
        });
    },

    _togglePerPage(container) {
        const arrow = container.querySelector('#kw-perpage-arrow');
        const content = container.querySelector('#kw-perpage-content');
        if (!arrow || !content) return;

        arrow.textContent = this.perPageOpen ? '\u25BC' : '\u25B6';
        if (this.perPageOpen) {
            const urls = this.currentData && this.currentData.urls ? this.currentData.urls : [];
            const pageRows = urls.slice(0, 50).map((url, idx) => {
                const pageUrl = url.url || '';
                const storedAI = this.storedPageKeywords[pageUrl];
                let keywordsHtml;

                if (storedAI && storedAI.length > 0) {
                    keywordsHtml = storedAI.map(kw =>
                        `<span style="background: var(--accent-1); color: var(--text-primary); padding: 2px 10px; border-radius: 12px; font-size: 12px;" title="Score: ${kw.score} | ${this.utils.escapeHtml(kw.category || '')} \u2014 ${this.utils.escapeHtml(kw.relevance || '')}">${this.utils.escapeHtml(kw.keyword)}</span>`
                    ).join('');
                } else {
                    const tokens = this._clientExtractTopKeywords(url, 5);
                    if (tokens.length === 0) return '';
                    keywordsHtml = tokens.map(t =>
                        `<span style="background: var(--bg-elevated); color: var(--text-body); padding: 2px 10px; border-radius: 12px; font-size: 12px;">${this.utils.escapeHtml(t)}</span>`
                    ).join('');
                }

                const btnLabel = storedAI ? 'Re-analyze' : 'AI Analyze';
                const btnBg = storedAI ? 'var(--status-success)' : 'var(--accent-1)';

                return `
                    <div class="kw-perpage-row" data-page-idx="${idx}" style="background: var(--bg-base); padding: 12px 16px; border-radius: 8px; border: 1px solid var(--border-alt);">
                        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                            <div style="font-size: 13px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; margin-right: 8px;" title="${this.utils.escapeHtml(pageUrl)}">
                                ${this.utils.escapeHtml(pageUrl)}
                            </div>
                            <button class="kw-ai-page-btn" data-url="${this.utils.escapeHtml(pageUrl)}" data-idx="${idx}"
                                style="background: ${btnBg}; color: var(--text-primary); border: none; padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; white-space: nowrap; flex-shrink: 0;">
                                ${btnLabel}
                            </button>
                        </div>
                        <div class="kw-perpage-keywords" style="display: flex; gap: 8px; flex-wrap: wrap;">
                            ${keywordsHtml}
                        </div>
                    </div>
                `;
            }).join('');
            content.innerHTML = pageRows;
            content.style.display = 'flex';
            content.style.flexDirection = 'column';
            content.style.gap = '10px';
            this._bindPerPageAIButtons(container);
        } else {
            content.style.display = 'none';
        }
    },

    _bindPerPageAIButtons(container) {
        const self = this;
        container.querySelectorAll('.kw-ai-page-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const url = btn.dataset.url;
                self.fetchPageAIKeywords(btn, url);
            });
        });
    },

    async fetchPageAIKeywords(btn, pageUrl) {
        const provider = localStorage.getItem('kw_ai_provider') || 'openai';
        const apiKey = localStorage.getItem('kw_ai_key') || '';
        if (!apiKey) {
            this._showError('Please set an API key in Settings before running AI analysis.');
            return;
        }

        const row = btn.closest('.kw-perpage-row');
        const keywordsDiv = row ? row.querySelector('.kw-perpage-keywords') : null;

        btn.textContent = 'Analyzing...';
        btn.disabled = true;
        if (keywordsDiv) {
            keywordsDiv.innerHTML = '<span style="color: var(--text-muted); font-size: 12px;">Analyzing with AI...</span>';
        }

        try {
            const resp = await fetch('/api/keywords/ai/page', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: pageUrl,
                    provider: provider,
                    api_key: apiKey
                })
            });

            const text = await resp.text();
            let result;
            try {
                result = JSON.parse(text);
            } catch {
                throw new Error(`Server returned invalid response: ${text.substring(0, 300)}`);
            }
            if (!resp.ok) {
                throw new Error(result.error || `HTTP ${resp.status}`);
            }

            const keywords = result.keywords || [];

            // Store locally
            this.storedPageKeywords[pageUrl] = keywords;

            if (keywordsDiv) {
                keywordsDiv.innerHTML = keywords.map(kw =>
                    `<span style="background: var(--accent-1); color: var(--text-primary); padding: 2px 10px; border-radius: 12px; font-size: 12px;" title="Score: ${kw.score} | ${this.utils.escapeHtml(kw.category || '')} \u2014 ${this.utils.escapeHtml(kw.relevance || '')}">${this.utils.escapeHtml(kw.keyword)}</span>`
                ).join('');
            }

            btn.textContent = 'Re-analyze';
            btn.style.background = 'var(--status-success)';
            btn.disabled = false;
        } catch (e) {
            console.error('Per-page AI analysis failed:', e);
            this._showError('Per-page AI analysis failed: ' + e.message);
            if (keywordsDiv) {
                keywordsDiv.innerHTML = '<span style="color: var(--status-error); font-size: 12px;">Analysis failed \u2014 see error above</span>';
            }
            btn.textContent = 'Retry';
            btn.disabled = false;
            btn.style.background = 'var(--accent-1)';
        }
    },

    exportCSV() {
        window.location.href = '/api/keywords?format=csv';
    },

    exportJSON() {
        if (!this.keywordsData) return;
        const exportData = { ...this.keywordsData };
        if (this.aiKeywordsData) {
            exportData.ai_keywords = this.aiKeywordsData;
        }
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `keywords-${this.keywordsData.domain || 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.utils.showNotification('JSON exported', 'success');
    },

    copyToClipboard() {
        if (!this.keywordsData || !this.keywordsData.keywords) return;
        const lines = [];
        if (this.aiKeywordsData && this.aiKeywordsData.keywords) {
            lines.push('--- AI Analyzed Keywords ---');
            this.aiKeywordsData.keywords.forEach(k => lines.push(`${k.keyword}\t${k.score}\t${k.category || ''}`));
            lines.push('');
        }
        lines.push('--- Extracted Keywords ---');
        this.keywordsData.keywords.forEach(k => lines.push(`${k.keyword}\t${k.score}\t${k.frequency}`));
        const text = lines.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            this.utils.showNotification('Keywords copied to clipboard', 'success');
        }).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            this.utils.showNotification('Keywords copied to clipboard', 'success');
        });
    },

    renderEmptyState() {
        return `
            <div style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">
                <div style="text-align: center; padding: 60px 20px;">
                    <div style="font-size: 64px; margin-bottom: 20px;">\uD83D\uDD11</div>
                    <h3 style="font-size: 24px; font-weight: 600; color: var(--text-body); margin-bottom: 12px;">
                        No Keyword Data
                    </h3>
                    <p style="color: var(--text-muted); font-size: 14px;">
                        Start a crawl to extract and analyze SEO keywords from the target site
                    </p>
                </div>
            </div>
        `;
    }
});

console.log('\u2705 SEO Keywords plugin registered');
