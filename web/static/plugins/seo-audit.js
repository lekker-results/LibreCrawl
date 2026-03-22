/**
 * SEO Audit Plugin for LibreCrawl
 * Displays AI-generated SEO audit results with interactive checklist,
 * copy-ready content, and server-side progress tracking.
 *
 * @author LekkerResults
 * @version 1.0.0
 */

LibreCrawlPlugin.register({
    id: 'seo-audit',
    name: 'SEO Audit',
    version: '1.0.0',
    author: 'LekkerResults',
    description: 'AI-powered SEO audit checklist with before/after previews, copy-ready content, and progress tracking',

    tab: {
        label: 'SEO Audit',
        icon: '\uD83D\uDCCB',
        position: 'end'
    },

    // State
    auditData: null,
    auditMeta: null,
    progress: {},
    activePanel: null,
    _saveTimeout: null,
    _styleInjected: false,

    onLoad() {
        console.log('\uD83D\uDCCB SEO Audit plugin loaded');
    },

    onTabActivate(container, data) {
        this.container = container;
        this.currentData = data;
        this._injectStyles();
        container.innerHTML = '<div class="sa-loading"><div class="loading-spinner"></div><div>Loading audit data\u2026</div></div>';
        this._fetchAudit().then(() => this._render());
    },

    onTabDeactivate() {
        this._flushProgress();
    },

    onCrawlComplete(data) {
        this.currentData = data;
    },

    // ── Data fetching ─────────────────────────────────────────

    async _fetchAudit() {
        // Determine domain from crawl state
        let domain = '';
        if (this.currentData && this.currentData.urls && this.currentData.urls.length > 0) {
            try { domain = new URL(this.currentData.urls[0].url).hostname; } catch(e) {}
        }
        if (!domain && this.currentData && this.currentData.stats && this.currentData.stats.baseUrl) {
            try { domain = new URL(this.currentData.stats.baseUrl).hostname; } catch(e) {}
        }

        if (!domain) {
            this.auditData = null;
            this.auditMeta = null;
            return;
        }

        try {
            const resp = await fetch(`/api/audit-results/domain/${encodeURIComponent(domain)}`, {
                headers: { 'X-Local-Auth': 'true' }
            });
            const result = await resp.json();
            if (result.success && result.audit) {
                this.auditMeta = {
                    id: result.audit.id,
                    crawl_id: result.audit.crawl_id,
                    domain: result.audit.domain,
                    client_name: result.audit.client_name,
                    version: result.audit.version,
                    overall_score_percent: result.audit.overall_score_percent,
                    total_checks: result.audit.total_checks,
                    checks_passed: result.audit.checks_passed,
                    checks_failed: result.audit.checks_failed,
                    critical_count: result.audit.critical_count,
                    warning_count: result.audit.warning_count,
                    info_count: result.audit.info_count,
                    created_at: result.audit.created_at
                };
                this.auditData = result.audit.audit_data;
                this.progress = result.audit.progress || {};
            } else {
                this.auditData = null;
                this.auditMeta = null;
            }
        } catch (e) {
            console.error('SEO Audit: fetch error', e);
            this.auditData = null;
            this.auditMeta = null;
        }
    },

    // ── Progress persistence ──────────────────────────────────

    _markCheck(pagePath, checkId, checked) {
        if (!this.progress.checked) this.progress.checked = {};
        if (!this.progress.checked[pagePath]) this.progress.checked[pagePath] = [];

        const arr = this.progress.checked[pagePath];
        const idx = arr.indexOf(checkId);
        if (checked && idx === -1) arr.push(checkId);
        if (!checked && idx !== -1) arr.splice(idx, 1);

        this._debounceSave();
        this._recalcProgress();
    },

    _isChecked(pagePath, checkId) {
        return this.progress.checked &&
               this.progress.checked[pagePath] &&
               this.progress.checked[pagePath].includes(checkId);
    },

    _debounceSave() {
        if (this._saveTimeout) clearTimeout(this._saveTimeout);
        this._saveTimeout = setTimeout(() => this._flushProgress(), 500);
    },

    async _flushProgress() {
        if (!this.auditMeta || !this.auditMeta.id) return;
        try {
            await fetch(`/api/audit-results/${this.auditMeta.id}/progress`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'X-Local-Auth': 'true' },
                body: JSON.stringify(this.progress)
            });
        } catch (e) {
            console.error('SEO Audit: progress save error', e);
        }
    },

    // ── Main render ───────────────────────────────────────────

    _render() {
        if (!this.container) return;
        this.container.innerHTML = '';

        if (!this.auditData) {
            this._renderEmpty();
            return;
        }

        // Sub-tab bar with overall progress
        const tabBar = el('div', 'sa-subtab-bar');
        const tabLeft = el('div', 'sa-subtab-tabs');
        const onPageBtn = el('button', 'sa-subtab active', 'On-Page SEO');
        const offPageBtn = el('button', 'sa-subtab', 'Off-Page SEO');
        onPageBtn.addEventListener('click', () => {
            onPageBtn.classList.add('active');
            offPageBtn.classList.remove('active');
            onPageWrap.style.display = '';
            offPageWrap.style.display = 'none';
        });
        offPageBtn.addEventListener('click', () => {
            offPageBtn.classList.add('active');
            onPageBtn.classList.remove('active');
            offPageWrap.style.display = '';
            onPageWrap.style.display = 'none';
        });
        tabLeft.append(onPageBtn, offPageBtn);

        const overallPct = this._calcOverallProgress();
        const tabRight = el('div', 'sa-subtab-progress');
        tabRight.innerHTML = `
            <span class="sa-subtab-progress-label">Overall</span>
            <div class="sa-subtab-progress-bar"><div class="sa-progress-fill" data-sa-overall-bar style="width:${overallPct}%;background:${this._pctColor(overallPct)}"></div></div>
            <span class="sa-subtab-progress-pct" data-sa-overall-pct>${overallPct}%</span>`;
        tabBar.append(tabLeft, tabRight);

        // On-Page content
        const onPageWrap = el('div', 'sa-onpage-wrap');
        this._renderOnPage(onPageWrap);

        // Off-Page placeholder
        const offPageWrap = el('div', 'sa-offpage-wrap');
        offPageWrap.style.display = 'none';
        offPageWrap.innerHTML = '<div class="sa-empty"><h3>Off-Page SEO</h3><p>Coming soon — off-page audit data (GBP, directories, social, reviews, NAP) will appear here once pushed from agency skills.</p></div>';

        this.container.append(tabBar, onPageWrap, offPageWrap);
    },

    _renderEmpty() {
        this.container.innerHTML = `
            <div class="sa-empty">
                <h3>No SEO Audit Found</h3>
                <p>No audit data has been pushed for this domain yet.</p>
                <p style="color:var(--text-muted);font-size:13px;margin-top:12px;">
                    Run <code>/technical-seo-audit</code> in Claude Code to generate an audit and push it to LibreCrawl automatically.
                </p>
            </div>`;
    },

    // ── On-Page layout ────────────────────────────────────────

    _renderOnPage(wrap) {
        const data = this.auditData;

        // Stats row
        const stats = el('div', 'sa-stats-row');
        const m = this.auditMeta;
        stats.innerHTML = `
            <div class="sa-stat"><span class="sa-stat-val">${m.total_checks || 0}</span><span class="sa-stat-lbl">Total Checks</span></div>
            <div class="sa-stat sa-stat-pass"><span class="sa-stat-val">${m.checks_passed || 0}</span><span class="sa-stat-lbl">Passed</span></div>
            <div class="sa-stat sa-stat-crit"><span class="sa-stat-val">${m.critical_count || 0}</span><span class="sa-stat-lbl">Critical</span></div>
            <div class="sa-stat sa-stat-warn"><span class="sa-stat-val">${m.warning_count || 0}</span><span class="sa-stat-lbl">Warning</span></div>
            <div class="sa-stat sa-stat-info"><span class="sa-stat-val">${m.info_count || 0}</span><span class="sa-stat-lbl">Info</span></div>`;
        wrap.appendChild(stats);

        // Two-column layout
        const layout = el('div', 'sa-layout');
        const sidebar = el('div', 'sa-sidebar');
        const content = el('div', 'sa-content');
        layout.append(sidebar, content);
        wrap.appendChild(layout);

        // Build panels and sidebar items
        this._panels = {};
        this._sidebarItems = {};

        // Site-wide checks
        if (data.site_wide_checks && data.site_wide_checks.length > 0) {
            this._addSidebarGroup(sidebar, 'Site Checks', [
                { id: 'site-wide', label: 'Site-Wide Checks', path: '__site__', checks: data.site_wide_checks }
            ]);
            this._buildPanel(content, 'site-wide', 'Site-Wide Checks', data.site_wide_checks, '__site__');
        }

        // Redirects
        if (data.redirects && data.redirects.length > 0) {
            this._addSidebarItem(sidebar, 'redirects', `Redirects (${data.redirects.length})`);
            this._buildRedirectsPanel(content, data.redirects);
        }

        // Missing pages (site_wide_checks with id starting with 'missing_' and status=fail)
        const missingPages = (data.site_wide_checks || []).filter(c => c.id.startsWith('missing_') && c.status === 'fail');
        if (missingPages.length > 0) {
            const group = el('div', 'sa-sidebar-group');
            const hdr = this._createGroupHeading('Missing Pages');
            const body = el('div', 'sa-sidebar-group-body');
            body.style.display = 'none';
            hdr.classList.add('sa-collapsed');
            hdr.addEventListener('click', () => {
                const open = body.style.display !== 'none';
                body.style.display = open ? 'none' : '';
                hdr.classList.toggle('sa-collapsed', open);
            });
            for (const mp of missingPages) {
                const panelId = 'missing-' + mp.id;
                const pagePath = '/' + mp.id.replace('missing_', '') + '/';
                this._addSidebarItemToGroup(body, panelId, pagePath, mp.name, this._calcPanelProgress([mp], '__missing__' + mp.id));
                this._buildMissingPagePanel(content, panelId, mp);
            }
            group.append(hdr, body);
            sidebar.appendChild(group);
        }

        // Crawled pages
        if (data.pages && data.pages.length > 0) {
            const group = el('div', 'sa-sidebar-group');
            const hdr = this._createGroupHeading('Crawled Pages');
            const body = el('div', 'sa-sidebar-group-body');
            body.style.display = 'none';
            hdr.classList.add('sa-collapsed');
            hdr.addEventListener('click', () => {
                const open = body.style.display !== 'none';
                body.style.display = open ? 'none' : '';
                hdr.classList.toggle('sa-collapsed', open);
            });
            for (const page of data.pages) {
                const panelId = 'page-' + this._slugify(page.path || page.url);
                const pct = this._calcPanelProgress(page.checks || [], page.path || page.url);
                this._addSidebarItemToGroup(body, panelId, page.path || page.url, page.title || page.path, pct);
                this._buildPagePanel(content, panelId, page);
            }
            group.append(hdr, body);
            sidebar.appendChild(group);
        }

        // Show first panel
        const firstId = Object.keys(this._panels)[0];
        if (firstId) this._selectPanel(firstId);
    },

    // ── Sidebar helpers ───────────────────────────────────────

    _addSidebarGroup(sidebar, heading, items) {
        const group = el('div', 'sa-sidebar-group');
        const hdr = this._createGroupHeading(heading);
        const body = el('div', 'sa-sidebar-group-body');
        body.style.display = 'none';
        hdr.classList.add('sa-collapsed');
        hdr.addEventListener('click', () => {
            const open = body.style.display !== 'none';
            body.style.display = open ? 'none' : '';
            hdr.classList.toggle('sa-collapsed', open);
        });
        for (const item of items) {
            const pct = this._calcPanelProgress(item.checks, item.path);
            this._addSidebarItemToGroup(body, item.id, item.label, item.label, pct);
        }
        group.append(hdr, body);
        sidebar.appendChild(group);
    },

    _createGroupHeading(text) {
        const hdr = el('div', 'sa-sidebar-heading');
        hdr.innerHTML = `<span class="sa-sidebar-heading-text">${esc(text)}</span><span class="sa-sidebar-heading-arrow">\u25BC</span>`;
        return hdr;
    },

    _addSidebarItem(sidebar, panelId, label) {
        const item = el('div', 'sa-sidebar-item');
        item.dataset.panel = panelId;
        item.innerHTML = `<span class="sa-sidebar-label">${esc(label)}</span>`;
        item.addEventListener('click', () => this._selectPanel(panelId));
        sidebar.appendChild(item);
        this._sidebarItems[panelId] = item;
    },

    _addSidebarItemToGroup(group, panelId, path, title, pct) {
        const item = el('div', 'sa-sidebar-item');
        item.dataset.panel = panelId;
        item.innerHTML = `
            <div class="sa-sidebar-item-top">
                <span class="sa-sidebar-path" title="${esc(path)}">${esc(path)}</span>
                <span class="sa-sidebar-pct" data-sa-pct="${panelId}">${pct}%</span>
            </div>
            <div class="sa-sidebar-title">${esc(title)}</div>
            <div class="sa-progress-bar sa-progress-bar-sm"><div class="sa-progress-fill" data-sa-bar="${panelId}" style="width:${pct}%;background:${this._pctColor(pct)}"></div></div>`;
        item.addEventListener('click', () => this._selectPanel(panelId));
        group.appendChild(item);
        this._sidebarItems[panelId] = item;
    },

    _selectPanel(panelId) {
        // Show matching panel, hide all others
        for (const [id, panel] of Object.entries(this._panels)) {
            panel.style.display = id === panelId ? 'block' : 'none';
        }
        for (const [id, item] of Object.entries(this._sidebarItems)) {
            item.classList.toggle('active', id === panelId);
        }
        this.activePanel = panelId;
    },

    // ── Panel builders ────────────────────────────────────────

    _buildPanel(content, panelId, title, checks, pagePath) {
        const panel = el('div', 'sa-panel');
        panel.dataset.panelId = panelId;
        panel.innerHTML = `<h2 class="sa-panel-title">${esc(title)}</h2>`;

        for (const check of checks) {
            // Skip missing_* checks in site-wide panel (they get their own panels)
            if (check.id.startsWith('missing_')) continue;
            panel.appendChild(this._renderCheck(check, pagePath));
        }

        content.appendChild(panel);
        this._panels[panelId] = panel;
    },

    _buildRedirectsPanel(content, redirects) {
        const panel = el('div', 'sa-panel');
        panel.dataset.panelId = 'redirects';
        panel.innerHTML = `<h2 class="sa-panel-title">Redirects</h2>`;

        const table = el('table', 'sa-redirects-table');
        table.innerHTML = `<thead><tr><th>URL</th><th>Status</th><th>Redirects To</th></tr></thead>`;
        const tbody = el('tbody');
        for (const r of redirects) {
            const tr = el('tr');
            tr.innerHTML = `<td>${esc(r.url)}</td><td>${r.status_code}</td><td>${esc(r.redirects_to)}</td>`;
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        panel.appendChild(table);
        content.appendChild(panel);
        this._panels['redirects'] = panel;
    },

    _buildMissingPagePanel(content, panelId, check) {
        const panel = el('div', 'sa-panel');
        panel.dataset.panelId = panelId;
        const pagePath = '/' + check.id.replace('missing_', '') + '/';

        panel.innerHTML = `<h2 class="sa-panel-title">${esc(check.name)}</h2>`;
        panel.appendChild(this._renderCheck(check, '__missing__' + check.id));

        content.appendChild(panel);
        this._panels[panelId] = panel;
    },

    _buildPagePanel(content, panelId, page) {
        const panel = el('div', 'sa-panel');
        panel.dataset.panelId = panelId;

        const pagePath = page.path || page.url;
        const initPct = this._calcPanelProgress(page.checks || [], pagePath);
        const titleRow = el('div', 'sa-panel-header');
        titleRow.innerHTML = `
            <h2 class="sa-panel-title">${esc(pagePath)} <span class="sa-panel-page-title">${esc(page.title || '')}</span></h2>
            <span class="sa-panel-score" data-sa-panel-score="${esc(panelId)}" style="color:${this._pctColor(initPct)}">${initPct}%</span>`;
        panel.appendChild(titleRow);

        for (const check of (page.checks || [])) {
            panel.appendChild(this._renderCheck(check, pagePath));
        }

        content.appendChild(panel);
        this._panels[panelId] = panel;
    },

    // ── Check renderer ────────────────────────────────────────

    _renderCheck(check, pagePath) {
        const wrap = el('div', 'sa-check ' + (check.status === 'pass' ? 'sa-check-pass' : check.status === 'not_applicable' ? 'sa-check-na' : 'sa-check-fail'));

        if (check.status === 'pass') {
            wrap.innerHTML = `
                <div class="sa-check-header">
                    <span class="sa-check-icon sa-icon-pass">\u2713</span>
                    <span class="sa-check-name">${esc(check.name)}</span>
                    <span class="sa-badge sa-badge-pass">Pass</span>
                    ${check.current ? `<span class="sa-check-preview">${esc(truncate(check.current, 80))}</span>` : ''}
                </div>`;
            return wrap;
        }

        if (check.status === 'not_applicable') {
            wrap.innerHTML = `
                <div class="sa-check-header">
                    <span class="sa-check-icon sa-icon-na">\u2014</span>
                    <span class="sa-check-name">${esc(check.name)}</span>
                    <span class="sa-badge sa-badge-na">N/A</span>
                </div>`;
            return wrap;
        }

        // Failed check
        const isChecked = this._isChecked(pagePath, check.id);
        const sevClass = check.severity === 'critical' ? 'sa-badge-critical' : check.severity === 'warning' ? 'sa-badge-warning' : 'sa-badge-info';

        const header = el('div', 'sa-check-header');
        header.innerHTML = `
            <label class="sa-checkbox-wrap">
                <input type="checkbox" class="sa-checkbox" data-page="${esc(pagePath)}" data-check="${esc(check.id)}" ${isChecked ? 'checked' : ''}>
                <span class="sa-checkbox-visual"></span>
            </label>
            <span class="sa-check-name ${isChecked ? 'sa-done' : ''}">${esc(check.name)}</span>
            <span class="sa-badge ${sevClass}">${esc(check.severity)}</span>`;

        const cb = header.querySelector('.sa-checkbox');
        cb.addEventListener('change', (e) => {
            this._markCheck(pagePath, check.id, e.target.checked);
            header.querySelector('.sa-check-name').classList.toggle('sa-done', e.target.checked);
        });

        wrap.appendChild(header);

        // Before / After boxes
        const body = el('div', 'sa-check-body');

        if (check.current) {
            body.appendChild(this._box('Current', check.current, 'sa-box-current'));
        }

        if (check.recommended || check.copy_content) {
            const recText = check.recommended || check.copy_content;
            const box = this._box('Recommended', recText, 'sa-box-recommended');
            if (check.copy_content) {
                box.appendChild(this._copyBtn(check.copy_content, 'Copy'));
            }
            body.appendChild(box);
        }

        if (check.detail) {
            const detail = el('div', 'sa-check-detail');
            detail.textContent = check.detail;
            body.appendChild(detail);
        }

        // Sub-items
        if (check.sub_items && check.sub_items.length > 0) {
            body.appendChild(this._renderSubItems(check.sub_items, check.id));
        }

        wrap.appendChild(body);
        return wrap;
    },

    // ── Sub-item renderers ────────────────────────────────────

    _renderSubItems(items, checkId) {
        const wrap = el('div', 'sa-subitems');
        const toggle = el('button', 'sa-subitems-toggle', `Show ${items.length} items \u25BC`);
        const list = el('div', 'sa-subitems-list');
        list.style.display = 'none';

        toggle.addEventListener('click', () => {
            const open = list.style.display !== 'none';
            list.style.display = open ? 'none' : '';
            toggle.textContent = open ? `Show ${items.length} items \u25BC` : `Hide items \u25B2`;
        });

        for (const item of items) {
            list.appendChild(this._renderSubItem(item, checkId));
        }

        wrap.append(toggle, list);
        return wrap;
    },

    _renderSubItem(item, checkId) {
        const row = el('div', 'sa-subitem');

        // Detect type by presence of fields
        if (item.image_src) {
            // Image sub-item
            row.classList.add('sa-subitem-image');
            row.innerHTML = `
                <div class="sa-subitem-img-label">${esc(item.label || '')}</div>
                ${item.current_alt !== undefined ? `<div class="sa-subitem-field"><span class="sa-field-label">Current alt:</span> ${esc(item.current_alt || '(empty)')}</div>` : ''}
                <div class="sa-subitem-field"><span class="sa-field-label">Proposed alt:</span> ${esc(item.copy_content || item.content || '')}</div>`;
            if (item.copy_content) row.appendChild(this._copyBtn(item.copy_content, 'Copy Alt'));
            if (item.ai_prompt) {
                const promptBox = el('div', 'sa-subitem-prompt');
                promptBox.innerHTML = `<span class="sa-field-label">AI Prompt:</span> <span class="sa-prompt-text">${esc(truncate(item.ai_prompt, 120))}</span>`;
                promptBox.appendChild(this._copyBtn(item.ai_prompt, 'Copy Prompt'));
                row.appendChild(promptBox);
            }
        } else if (item.label && item.label.startsWith('Q')) {
            // FAQ sub-item
            row.classList.add('sa-subitem-faq');
            row.innerHTML = `<div class="sa-subitem-q">${esc(item.label)}</div>
                <div class="sa-subitem-a">${esc(item.content || '')}</div>`;
            if (item.copy_content) row.appendChild(this._copyBtn(item.copy_content, 'Copy Q&A'));
        } else if (item.label && (item.label === 'H2' || item.label === 'H3')) {
            // Heading sub-item
            row.classList.add('sa-subitem-heading');
            row.innerHTML = `<span class="sa-heading-badge">${esc(item.label)}</span> <span>${esc(item.content || item.copy_content || '')}</span>`;
            if (item.copy_content) row.appendChild(this._copyBtn(item.copy_content, 'Copy'));
        } else if (item.label && item.label.startsWith('Link to')) {
            // Internal link sub-item
            row.classList.add('sa-subitem-link');
            row.innerHTML = `<span class="sa-link-target">${esc(item.label)}</span> <span class="sa-link-anchor">${esc(item.content || '')}</span>`;
            if (item.copy_content) row.appendChild(this._copyBtn(item.copy_content, 'Copy Anchor'));
        } else {
            // Generic
            row.innerHTML = `<span class="sa-subitem-label">${esc(item.label || '')}</span> <span>${esc(item.content || item.copy_content || '')}</span>`;
            if (item.copy_content) row.appendChild(this._copyBtn(item.copy_content, 'Copy'));
        }

        return row;
    },

    // ── UI helpers ────────────────────────────────────────────

    _box(label, text, cls) {
        const box = el('div', 'sa-box ' + cls);
        box.innerHTML = `<div class="sa-box-label">${esc(label)}</div><div class="sa-box-text">${esc(text)}</div>`;
        return box;
    },

    _copyBtn(text, label) {
        const btn = el('button', 'sa-copy-btn');
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> ${esc(label)}`;
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await navigator.clipboard.writeText(text);
                btn.classList.add('sa-copied');
                const orig = btn.innerHTML;
                btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied!`;
                setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('sa-copied'); }, 1500);
            } catch (err) {
                console.error('Copy failed', err);
            }
        });
        return btn;
    },

    // ── Progress calculations ─────────────────────────────────

    _calcOverallProgress() {
        if (!this.auditData) return 0;
        let total = 0, done = 0;

        // Site-wide checks (excluding missing_ which are separate)
        for (const c of (this.auditData.site_wide_checks || [])) {
            if (c.id.startsWith('missing_')) {
                if (c.status === 'fail') { total++; if (this._isChecked('__missing__' + c.id, c.id)) done++; }
                else if (c.status === 'pass') { total++; done++; }
            } else {
                if (c.status === 'fail') { total++; if (this._isChecked('__site__', c.id)) done++; }
                else if (c.status === 'pass') { total++; done++; }
            }
        }

        // Per-page checks
        for (const page of (this.auditData.pages || [])) {
            const path = page.path || page.url;
            for (const c of (page.checks || [])) {
                if (c.status === 'fail') { total++; if (this._isChecked(path, c.id)) done++; }
                else if (c.status === 'pass') { total++; done++; }
            }
        }

        return total === 0 ? 0 : Math.round(done / total * 100);
    },

    _calcPanelProgress(checks, pagePath) {
        if (!checks || checks.length === 0) return 0;
        let total = 0, done = 0;
        for (const c of checks) {
            if (c.status === 'not_applicable') continue;
            total++;
            if (c.status === 'pass') { done++; }
            else if (c.status === 'fail' && this._isChecked(pagePath, c.id)) { done++; }
        }
        return total === 0 ? 0 : Math.round(done / total * 100);
    },

    _recalcProgress() {
        // Update overall
        const overallPct = this._calcOverallProgress();
        const overallEl = this.container.querySelector('[data-sa-overall-pct]');
        if (overallEl) overallEl.textContent = overallPct + '%';
        const overallBar = this.container.querySelector('[data-sa-overall-bar]');
        if (overallBar) { overallBar.style.width = overallPct + '%'; overallBar.style.background = this._pctColor(overallPct); }

        // Update per-panel progress bars
        if (!this.auditData) return;

        const updatePanel = (panelId, pct) => {
            const pctEl = this.container.querySelector(`[data-sa-pct="${panelId}"]`);
            if (pctEl) pctEl.textContent = pct + '%';
            const barEl = this.container.querySelector(`[data-sa-bar="${panelId}"]`);
            if (barEl) { barEl.style.width = pct + '%'; barEl.style.background = this._pctColor(pct); }
            const scoreEl = this.container.querySelector(`[data-sa-panel-score="${panelId}"]`);
            if (scoreEl) { scoreEl.textContent = pct + '%'; scoreEl.style.color = this._pctColor(pct); }
        };

        // Site-wide panel
        const siteChecks = (this.auditData.site_wide_checks || []).filter(c => !c.id.startsWith('missing_'));
        if (siteChecks.length > 0) {
            updatePanel('site-wide', this._calcPanelProgress(siteChecks, '__site__'));
        }

        // Missing pages panels
        for (const c of (this.auditData.site_wide_checks || []).filter(c => c.id.startsWith('missing_') && c.status === 'fail')) {
            const panelId = 'missing-' + c.id;
            updatePanel(panelId, this._calcPanelProgress([c], '__missing__' + c.id));
        }

        // Per-page panels
        for (const page of (this.auditData.pages || [])) {
            const panelId = 'page-' + this._slugify(page.path || page.url);
            const pct = this._calcPanelProgress(page.checks || [], page.path || page.url);
            updatePanel(panelId, pct);
        }
    },

    _pctColor(pct) {
        if (pct >= 80) return 'var(--status-success)';
        if (pct >= 50) return 'var(--status-warning)';
        return 'var(--status-error)';
    },

    _slugify(str) {
        return (str || '').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'root';
    },

    // ── Style injection ───────────────────────────────────────

    _injectStyles() {
        if (this._styleInjected) return;
        this._styleInjected = true;

        const style = document.createElement('style');
        style.textContent = `
/* SEO Audit Plugin Styles */
.sa-loading { padding: 40px; text-align: center; color: var(--text-primary); font-size: 15px; }
.sa-empty { padding: 60px 40px; text-align: center; color: var(--text-secondary); }
.sa-empty h3 { color: var(--text-primary); margin-bottom: 8px; font-size: 18px; }
.sa-empty p { margin: 4px 0; font-size: 14px; }
.sa-empty code { background: var(--surface-1); padding: 2px 6px; border-radius: 3px; font-size: 13px; }

/* Sub-tab bar */
.sa-subtab-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-section); padding: 0 16px; background: var(--bg-elevated); }
.sa-subtab-tabs { display: flex; gap: 0; }
.sa-subtab { padding: 10px 20px; background: none; border: none; color: var(--text-muted); font-size: 14px; font-weight: 500; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
.sa-subtab:hover { color: var(--text-primary); background: var(--tab-hover-bg); }
.sa-subtab.active { color: var(--accent-2); border-bottom-color: var(--accent-2); }
.sa-subtab-progress { display: flex; align-items: center; gap: 10px; padding: 8px 0; }
.sa-subtab-progress-label { font-size: 12px; color: var(--text-muted); font-weight: 500; white-space: nowrap; }
.sa-subtab-progress-bar { width: 140px; height: 6px; background: var(--progress-bg); border-radius: 3px; overflow: hidden; }
.sa-subtab-progress-pct { font-size: 13px; font-weight: 700; color: var(--text-primary); min-width: 36px; text-align: right; }

/* Stats row */
.sa-stats-row { display: flex; gap: 12px; padding: 16px; flex-wrap: wrap; }
.sa-stat { padding: 10px 16px; background: var(--bg-elevated); border: 1px solid var(--border-section); border-radius: 8px; text-align: center; min-width: 80px; }
.sa-stat-val { display: block; font-size: 22px; font-weight: 700; color: var(--text-primary); }
.sa-stat-lbl { display: block; font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
.sa-stat-pass .sa-stat-val { color: var(--status-success); }
.sa-stat-crit .sa-stat-val { color: var(--status-error); }
.sa-stat-warn .sa-stat-val { color: var(--status-warning); }
.sa-stat-info .sa-stat-val { color: var(--status-info); }

/* Layout */
.sa-layout { display: flex; height: calc(100vh - 220px); min-height: 400px; }
.sa-sidebar { width: 260px; min-width: 200px; overflow-y: auto; border-right: 1px solid var(--border-section); padding: 12px 0; background: var(--bg-sidebar); }
.sa-content { flex: 1; overflow-y: auto; padding: 20px; }

/* Progress bars */
.sa-progress-bar { height: 6px; background: var(--progress-bg); border-radius: 3px; overflow: hidden; }
.sa-progress-bar-sm { height: 4px; margin-top: 6px; }
.sa-progress-fill { height: 100%; border-radius: 3px; transition: width 0.3s, background 0.3s; }

/* Sidebar groups */
.sa-sidebar-group { margin-bottom: 4px; }
.sa-sidebar-heading { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; font-size: 11px; font-weight: 700; color: var(--accent-4); text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; background: var(--surface-1); border-top: 1px solid var(--border-section); border-bottom: 1px solid var(--border-section); user-select: none; transition: background 0.1s; }
.sa-sidebar-heading:hover { background: var(--tab-hover-bg); }
.sa-sidebar-heading-arrow { font-size: 9px; color: var(--text-dim); transition: transform 0.2s; }
.sa-sidebar-heading.sa-collapsed .sa-sidebar-heading-arrow { transform: rotate(-90deg); }
.sa-sidebar-group-body { }
.sa-sidebar-item { padding: 8px 16px; cursor: pointer; border-left: 3px solid transparent; transition: all 0.1s; }
.sa-sidebar-item:hover { background: var(--tab-hover-bg); }
.sa-sidebar-item.active { background: var(--tab-active-bg); border-left-color: var(--accent-2); }
.sa-sidebar-item-top { display: flex; justify-content: space-between; align-items: center; }
.sa-sidebar-path { font-size: 12px; color: var(--text-muted); font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
.sa-sidebar-pct { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.sa-sidebar-title { font-size: 13px; color: var(--text-body); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-sidebar-label { font-size: 13px; color: var(--text-body); }

/* Panels */
.sa-panel { display: none; }
.sa-panel-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin-bottom: 16px; }
.sa-panel-page-title { font-size: 14px; font-weight: 400; color: var(--text-muted); margin-left: 8px; }
.sa-panel-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 16px; }
.sa-panel-score { font-size: 24px; font-weight: 700; }

/* Check items */
.sa-check { margin-bottom: 12px; border: 1px solid var(--border-section); border-radius: 8px; overflow: hidden; }
.sa-check-pass { border-color: var(--status-success-border); }
.sa-check-fail { border-color: var(--border-section); }
.sa-check-na { border-color: var(--border-subtle); opacity: 0.6; }
.sa-check-header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--surface-1); }
.sa-check-icon { width: 20px; text-align: center; font-weight: 700; }
.sa-icon-pass { color: var(--status-success); }
.sa-icon-na { color: var(--text-dim); }
.sa-check-name { font-size: 14px; font-weight: 500; color: var(--text-primary); }
.sa-check-name.sa-done { text-decoration: line-through; opacity: 0.6; }
.sa-check-preview { font-size: 12px; color: var(--text-muted); margin-left: auto; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Badges */
.sa-badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; text-transform: capitalize; }
.sa-badge-pass { background: var(--status-success-bg); color: var(--status-success); }
.sa-badge-critical { background: var(--status-error-bg); color: var(--status-error); }
.sa-badge-warning { background: var(--status-warning-bg); color: var(--status-warning); }
.sa-badge-info { background: var(--status-info-bg); color: var(--status-info); }
.sa-badge-na { background: var(--surface-1); color: var(--text-dim); }

/* Checkbox */
.sa-checkbox-wrap { display: flex; align-items: center; cursor: pointer; }
.sa-checkbox { display: none; }
.sa-checkbox-visual { width: 18px; height: 18px; border: 2px solid var(--border-input); border-radius: 4px; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.sa-checkbox:checked + .sa-checkbox-visual { background: var(--status-success); border-color: var(--status-success); }
.sa-checkbox:checked + .sa-checkbox-visual::after { content: '\u2713'; color: #fff; font-size: 12px; font-weight: 700; }

/* Check body */
.sa-check-body { padding: 12px 14px; }
.sa-check-detail { font-size: 13px; color: var(--text-muted); margin-top: 8px; }

/* Before/After boxes */
.sa-box { padding: 10px 12px; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid; position: relative; }
.sa-box-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.sa-box-text { font-size: 13px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
.sa-box-current { background: var(--status-error-bg); border-left-color: var(--status-error); }
.sa-box-current .sa-box-label { color: var(--status-error); }
.sa-box-current .sa-box-text { color: var(--text-body); }
.sa-box-recommended { background: var(--status-success-bg); border-left-color: var(--status-success); }
.sa-box-recommended .sa-box-label { color: var(--status-success); }
.sa-box-recommended .sa-box-text { color: var(--text-body); }

/* Copy button */
.sa-copy-btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; color: var(--text-secondary); background: var(--btn-ghost-bg); border: 1px solid var(--btn-ghost-border); border-radius: 4px; cursor: pointer; transition: all 0.15s; margin-top: 6px; }
.sa-copy-btn:hover { background: var(--btn-ghost-hover); color: var(--text-primary); }
.sa-copy-btn.sa-copied { color: var(--status-success); border-color: var(--status-success-border); }
.sa-box-recommended .sa-copy-btn { position: absolute; top: 8px; right: 8px; margin-top: 0; }

/* Sub-items */
.sa-subitems { margin-top: 10px; }
.sa-subitems-toggle { background: none; border: 1px solid var(--border-section); color: var(--text-muted); padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; transition: all 0.15s; }
.sa-subitems-toggle:hover { color: var(--text-primary); border-color: var(--border-standard); }
.sa-subitems-list { margin-top: 8px; }
.sa-subitem { padding: 8px 12px; border: 1px solid var(--border-subtle); border-radius: 6px; margin-bottom: 6px; font-size: 13px; color: var(--text-body); }
.sa-subitem-image .sa-subitem-img-label { font-weight: 500; color: var(--text-primary); font-family: monospace; font-size: 12px; margin-bottom: 4px; }
.sa-subitem-field { margin: 2px 0; }
.sa-field-label { font-weight: 600; color: var(--text-secondary); font-size: 12px; }
.sa-subitem-prompt { margin-top: 4px; font-size: 12px; color: var(--text-muted); }
.sa-prompt-text { font-style: italic; }
.sa-subitem-faq .sa-subitem-q { font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
.sa-subitem-faq .sa-subitem-a { color: var(--text-secondary); }
.sa-heading-badge { display: inline-block; padding: 1px 6px; font-size: 11px; font-weight: 600; background: var(--accent-1); color: #fff; border-radius: 3px; margin-right: 6px; }
.sa-link-target { font-family: monospace; font-size: 12px; color: var(--accent-2); }
.sa-link-anchor { color: var(--text-secondary); margin-left: 8px; }

/* Redirects table */
.sa-redirects-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.sa-redirects-table th { text-align: left; padding: 8px 12px; background: var(--table-header-bg); color: var(--text-secondary); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
.sa-redirects-table td { padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); color: var(--text-body); font-family: monospace; font-size: 12px; }
.sa-redirects-table tr:hover td { background: var(--table-row-hover); }

/* Onpage/offpage wraps fill space */
.sa-onpage-wrap, .sa-offpage-wrap { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
`;
        document.head.appendChild(style);
    }
});

// ── Utility functions ─────────────────────────────────────────

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, max) {
    if (!str || str.length <= max) return str || '';
    return str.slice(0, max) + '\u2026';
}
