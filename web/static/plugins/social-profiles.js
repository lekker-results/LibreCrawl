/* social-profiles.js — Social Profile Discovery & Analysis Plugin */
LibreCrawlPlugin.register({
    id: 'social-profiles',
    name: 'Social Profiles',
    version: '1.0.0',
    tab: { label: 'Social', icon: '🔗', position: 'end' },

    state: {
        socialData: null,
        currentData: null,
        loading: false,
        loadingPlatforms: new Set(),
    },

    onLoad() {
        window.addEventListener('social-account-connected', () => {
            // New platform connected — clear cached report and re-fetch settings + cards
            this.state.socialData = null;
            if (window._userSettings) delete window._userSettings.social_cookies;
            if (this.isActive) this._renderWithData(this.state.currentData);
        });
    },

    onDataUpdate(data) {
        this.state.socialData = null;
        this.state.currentData = data;
        if (this.isActive) {
            this._renderWithData(data);
        }
    },

    onCrawlComplete(data) {
        this.state.currentData = data;
        this.state.socialData = null;
        this._ensureSettingsLoaded().then(() => this._fetchSocialData(data, false)).then(report => {
            this.state.socialData = report;
            if (this.isActive) this._render(report);
        }).catch(() => {});
    },

    onTabActivate(container, data) {
        this.state.currentData = data;
        this._renderWithData(data);
    },

    onTabDeactivate() {},

    async _ensureSettingsLoaded() {
        if (window._userSettings && window._userSettings.social_cookies !== undefined) return;
        try {
            const resp = await fetch('/api/get_settings');
            if (!resp.ok) return;
            const data = await resp.json();
            if (!window._userSettings) window._userSettings = {};
            window._userSettings.social_cookies = (data.settings && data.settings.social_cookies) || {};
            window._userSettings.social_credentials = (data.settings && data.settings.social_credentials) || {};
        } catch (_) {}
    },

    _hasCrawlData(data) {
        return !!(data && data.urls && data.urls.length > 0);
    },

    async _renderWithData(data) {
        if (!this.container) return;
        if (this.state.socialData) {
            this._render(this.state.socialData);
            return;
        }
        await this._ensureSettingsLoaded();
        if (!this._hasCrawlData(data)) {
            // No crawl loaded — just show connected accounts with no-URL cards
            this._render({ profiles: {}, summary: {}, business_name: '' });
            return;
        }
        this._showSpinner();
        try {
            const report = await this._fetchSocialData(data, false);
            this.state.socialData = report;
            this._render(report);
        } catch (e) {
            this._showError(e.message || 'Failed to load social data');
        }
    },

    async _fetchSocialData(data, fetchProfiles) {
        const isSavedCrawl = data && data.crawlId && !window.crawlState?.isActive;
        const qs = fetchProfiles ? '?fetch_profiles=1' : '';
        let resp;
        if (isSavedCrawl) {
            const urls = (data.urls || []).slice(0, 500);
            const links = (data.links || []).slice(0, 2000);
            resp = await fetch('/api/social' + qs, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ urls, links })
            });
        } else {
            resp = await fetch('/api/social' + qs);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
    },

    _showSpinner() {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="plugin-content" style="padding:20px;overflow-y:auto;max-height:calc(100vh - 280px)">
                <div style="display:flex;align-items:center;gap:12px;color:var(--text-muted);margin-top:40px;justify-content:center">
                    <div style="width:24px;height:24px;border:3px solid var(--border-alt);border-top-color:#6366f1;border-radius:50%;animation:spin 0.8s linear infinite"></div>
                    Analyzing social profiles\u2026
                </div>
            </div>`;
    },

    _showError(msg) {
        if (!this.container) return;
        this.container.innerHTML = `
            <div class="plugin-content" style="padding:20px;overflow-y:auto;max-height:calc(100vh - 280px)">
                <div style="background:var(--bg-elevated);border:1px solid var(--status-error);border-radius:8px;padding:16px;color:var(--status-error)">
                    ${this.utils.escapeHtml(msg)}
                </div>
            </div>`;
    },

    _getPlatformsMap() {
        const svg = (path) =>
            `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="#fff">${path}</svg>`;
        return {
            facebook:  { name: 'Facebook',    color: '#1877f2', svg: svg('<path d="M24 12.073C24 5.404 18.627 0 12 0S0 5.404 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.514c-1.491 0-1.956.93-1.956 1.887v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>') },
            instagram: { name: 'Instagram',   color: '#e1306c', svg: svg('<path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>') },
            twitter:   { name: 'X / Twitter', color: '#000000', svg: svg('<path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.265 5.638L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"/>') },
            linkedin:  { name: 'LinkedIn',    color: '#0077b5', svg: svg('<path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>') },
            youtube:   { name: 'YouTube',     color: '#ff0000', svg: svg('<path d="M23.495 6.205a3.007 3.007 0 00-2.088-2.088c-1.87-.501-9.396-.501-9.396-.501s-7.507-.01-9.396.501A3.007 3.007 0 00.527 6.205a31.247 31.247 0 00-.522 5.805 31.247 31.247 0 00.522 5.783 3.007 3.007 0 002.088 2.088c1.868.502 9.396.502 9.396.502s7.506 0 9.396-.502a3.007 3.007 0 002.088-2.088 31.247 31.247 0 00.5-5.783 31.247 31.247 0 00-.5-5.805zM9.609 15.601V8.408l6.264 3.602z"/>') },
            tiktok:    { name: 'TikTok',      color: '#010101', svg: svg('<path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/>') },
            pinterest: { name: 'Pinterest',   color: '#e60023', svg: svg('<path d="M12 0C5.373 0 0 5.372 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 01.083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/>') },
            yelp:      { name: 'Yelp',        color: '#d32323', svg: svg('<path d="M20.16 12.594l-4.995 1.452c-.96.246-1.76-.81-1.234-1.66l2.7-4.347a1.13 1.13 0 011.948.22 9.167 9.167 0 011.52 3.604 1.13 1.13 0 01-.94 1.33zm-6.957 3.13l1.42 4.905c.283.976-.75 1.803-1.64 1.303a9.168 9.168 0 01-3.094-2.79 1.13 1.13 0 01.528-1.73l4.786-1.687zM12 13.18a1.174 1.174 0 110-2.348 1.174 1.174 0 010 2.348zm-1.85-3.624L5.35 8.122c-.976-.283-.995-1.683-.029-2.004A9.168 9.168 0 019.35 5.38a1.13 1.13 0 011.25 1.44L9.285 8.962a1.174 1.174 0 01-1.135.594zM9.192 14.8l-2.694 4.348c-.513.83-1.73.604-1.925-.354a9.168 9.168 0 01.093-3.9 1.13 1.13 0 011.63-.74l4.995 1.452a1.174 1.174 0 01-.099 1.194zm3.424-9.854L12.85 0h-.003C12.59.002 12.295 0 12 0a9.17 9.17 0 00-3.635.745 1.13 1.13 0 00-.398 1.82l3.534 3.666a1.174 1.174 0 001.115-1.285z"/>') },
        };
    },

    async _loadAllProfiles(force) {
        const profiles = (this.state.socialData && this.state.socialData.profiles) || {};
        const withUrl = Object.entries(profiles).filter(([p, v]) => v && v.url);
        const entries = force
            ? withUrl
            : withUrl.filter(([p, v]) => !v.data);
        if (entries.length === 0) {
            if (withUrl.length === 0) {
                this.utils.showNotification('No profile URLs were discovered on this site. Try running a deeper crawl or enter a URL manually.', 'info');
            } else {
                this.utils.showNotification('All profiles already loaded. Use Refresh All to re-fetch.', 'info');
            }
            return;
        }
        const loadBtn = this.container && this.container.querySelector('#social-load-all-btn');
        for (let i = 0; i < entries.length; i++) {
            const [platform, profile] = entries[i];
            if (loadBtn) loadBtn.textContent = `🔍 Loading ${i + 1} / ${entries.length}\u2026`;
            await this._fetchOneProfile(platform, profile.url, !!force);
            if (i < entries.length - 1) {
                await new Promise(r => setTimeout(r, 800 + Math.random() * 1000));
            }
        }
        if (loadBtn) {
            loadBtn.textContent = '🔄 Refresh All';
            loadBtn.setAttribute('data-mode', 'refresh');
        }
    },

    async _fetchOneProfile(platform, url, force) {
        this.state.loadingPlatforms.add(platform);
        this._setCardLoading(platform, true);
        try {
            const resp = await fetch('/api/social/fetch-profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform, url, force: !!force })
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || 'Failed');
            if (!this.state.socialData) this.state.socialData = { profiles: {} };
            if (!this.state.socialData.profiles[platform]) {
                this.state.socialData.profiles[platform] = { url, data: null };
            }
            this.state.socialData.profiles[platform].data = result.data;
            this._updateCard(platform);
        } catch (e) {
            this._setCardLoading(platform, false);
            this.utils.showNotification(`Failed to load ${platform}: ${e.message}`, 'error');
        } finally {
            this.state.loadingPlatforms.delete(platform);
        }
    },

    _updateCard(platform) {
        if (!this.container || !this.state.socialData) return;
        const existing = this.container.querySelector('#social-card-' + platform);
        if (!existing) return;
        const profiles = this.state.socialData.profiles || {};
        const socialCookies = (window._userSettings && window._userSettings.social_cookies) || {};
        const isConnected = !!(socialCookies[platform] && socialCookies[platform].length);
        const PLATFORMS = this._getPlatformsMap();
        const meta = PLATFORMS[platform] || { name: platform, icon: '🔗', color: '#6366f1' };
        const profile = profiles[platform];
        const newCard = document.createElement('div');
        newCard.innerHTML = this._renderCard(platform, meta, profile, isConnected);
        const newCardEl = newCard.firstElementChild;
        existing.replaceWith(newCardEl);
        this._wireCardListeners(platform, newCardEl, profile);
    },

    _wireCardListeners(platform, cardEl, profile) {
        // State 1: manual URL entry
        const manualBtn = cardEl.querySelector('.social-manual-fetch-btn');
        if (manualBtn) {
            manualBtn.addEventListener('click', () => {
                const input = cardEl.querySelector('input.social-manual-url-input');
                const url = input && input.value.trim();
                if (!url) { input && input.focus(); return; }
                if (!this.state.socialData) this.state.socialData = { profiles: {} };
                if (!this.state.socialData.profiles) this.state.socialData.profiles = {};
                this.state.socialData.profiles[platform] = { url, source: 'manual', handle: '', data: null };
                this._fetchOneProfile(platform, url, false);
            });
        }
        // State 3: fetch button reads URL from editable input
        const fetchBtn = cardEl.querySelector('.social-fetch-btn');
        if (fetchBtn) {
            fetchBtn.addEventListener('click', () => {
                const input = cardEl.querySelector('input.social-url-input');
                const url = (input ? input.value.trim() : null) || fetchBtn.getAttribute('data-url');
                if (!url) return;
                if (!this.state.socialData) this.state.socialData = { profiles: {} };
                if (!this.state.socialData.profiles) this.state.socialData.profiles = {};
                if (this.state.socialData.profiles[platform]) {
                    this.state.socialData.profiles[platform].url = url;
                } else {
                    this.state.socialData.profiles[platform] = { url, handle: '', data: null };
                }
                this._fetchOneProfile(platform, url, false);
            });
        }
        // State 2: re-fetch with updated URL
        const refetchBtn = cardEl.querySelector('.social-refetch-btn');
        if (refetchBtn) {
            refetchBtn.addEventListener('click', () => {
                const input = cardEl.querySelector('input.social-url-input');
                const url = input && input.value.trim();
                if (!url) return;
                if (this.state.socialData && this.state.socialData.profiles && this.state.socialData.profiles[platform]) {
                    this.state.socialData.profiles[platform].url = url;
                }
                this._fetchOneProfile(platform, url, true);
            });
        }
        // State 2: details toggle — dynamic, no re-render
        const detailsToggle = cardEl.querySelector('.social-details-toggle');
        if (detailsToggle) {
            detailsToggle.addEventListener('click', () => {
                const expanded = detailsToggle.getAttribute('data-expanded') === 'true';
                detailsToggle.setAttribute('data-expanded', String(!expanded));
                detailsToggle.textContent = !expanded ? '\u25b2 Hide details' : '\u25bc Profile details';
                const content = detailsToggle.nextElementSibling;
                if (content) content.style.display = !expanded ? 'block' : 'none';
            });
        }
    },

    _setCardLoading(platform, loading) {
        const card = this.container && this.container.querySelector('#social-card-' + platform);
        if (!card) return;
        const manualBtn  = card.querySelector('.social-manual-fetch-btn');
        const fetchBtn   = card.querySelector('.social-fetch-btn');
        const refetchBtn = card.querySelector('.social-refetch-btn');
        const btn = manualBtn || fetchBtn || refetchBtn;
        if (btn) {
            btn.disabled = loading;
            if (loading) {
                btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px">'
                    + '<span style="width:11px;height:11px;border:2px solid var(--border-standard);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0"></span>'
                    + 'Loading\u2026</span>';
            } else {
                btn.textContent = refetchBtn ? 'Re-fetch \u21ba' : 'Fetch';
            }
        }
        card.querySelectorAll('input').forEach(inp => { inp.disabled = loading; });
    },

    _getCrawledDomain() {
        try {
            const urls = this.state.currentData && this.state.currentData.urls;
            if (!urls || !urls.length) return '';
            return new URL(urls[0].url).hostname.replace(/^www\./, '');
        } catch (e) { return ''; }
    },

    _getEtld1(hostname) {
        if (!hostname) return hostname;
        const parts = hostname.replace(/^www\./, '').split('.');
        if (parts.length <= 2) return parts.join('.');
        const twoPartSld = new Set([
            'co.za','com.au','co.uk','co.nz','co.in','com.br','com.mx','com.ar',
            'org.uk','net.au','org.au','gov.au','ac.uk','net.za','org.za','edu.za','gov.za',
        ]);
        const lastTwo = parts.slice(-2).join('.');
        return twoPartSld.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
    },

    _domainsMatch(linkUrl, crawledHostname) {
        try {
            return this._getEtld1(new URL(linkUrl).hostname) === this._getEtld1(crawledHostname);
        } catch (e) { return false; }
    },

    _render(report) {
        if (!this.container) return;
        const profiles = report.profiles || {};
        const summary = report.summary || {};
        const businessName = report.business_name || '';

        const PLATFORMS = this._getPlatformsMap();

        // Search enrichment notice
        let searchNotice = '';
        if (summary.found_via_search && summary.found_via_search.length > 0) {
            const names = summary.found_via_search.map(p => PLATFORMS[p]?.name || p).join(', ');
            searchNotice = `
                <div style="background:var(--status-warning-bg);border:1px solid var(--status-warning-border);border-radius:8px;padding:14px 16px;margin-bottom:20px;color:var(--status-warning);display:flex;gap:10px;align-items:flex-start">
                    <span style="font-size:18px;flex-shrink:0">&#x26A0;&#xFE0F;</span>
                    <div style="color:var(--text-body)">
                        <strong>${this.utils.escapeHtml(names)}</strong> found via web search but not linked on the website.
                        Add these to your site's footer and Organization schema <code style="background:var(--bg-base);padding:2px 5px;border-radius:3px;color:var(--text-secondary)">sameAs</code> for better SEO.
                    </div>
                </div>`;
        }

        // Schema badge
        let schemaBadge = '';
        if (summary.has_schema_sameAs) {
            schemaBadge = `
                <div style="background:var(--status-success-bg);border:1px solid var(--status-success-border);border-radius:8px;padding:10px 16px;margin-bottom:20px;color:var(--status-success);display:flex;gap:8px;align-items:center">
                    <span>&#x2705;</span>
                    <span style="color:var(--text-body)">Site declares social profiles via schema.org <code style="background:var(--bg-base);padding:2px 5px;border-radius:3px;color:var(--text-secondary)">sameAs</code></span>
                </div>`;
        }

        const socialCookies = (window._userSettings && window._userSettings.social_cookies) || {};

        // Only show platforms that are connected OR have a discovered profile
        const visibleEntries = Object.entries(PLATFORMS).filter(([platform]) => {
            const isConnected = !!(socialCookies[platform] && socialCookies[platform].length > 0);
            const isFound = !!profiles[platform];
            return isConnected || isFound;
        });

        const cards = visibleEntries.map(([platform, meta]) => {
            const profile = profiles[platform];
            const isConnected = !!(socialCookies[platform] && socialCookies[platform].length > 0);
            return this._renderCard(platform, meta, profile, isConnected);
        }).join('');

        const emptyState = visibleEntries.length === 0 ? `
            <div style="text-align:center;padding:48px 20px;color:var(--text-muted)">
                <div style="font-size:40px;margin-bottom:12px">🔗</div>
                <div style="font-size:15px;font-weight:500;color:var(--text-body);margin-bottom:6px">No social profiles found</div>
                <div style="font-size:13px;margin-bottom:20px">Run a crawl to discover linked profiles, or connect accounts to enable authenticated data.</div>
                <button onclick="openSettings().then(()=>switchSettingsTab('social'))" style="background:#6366f1;color:#fff;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px">+ Connect an Account</button>
            </div>` : '';

        this.container.innerHTML = `
            <div class="plugin-content" style="padding:20px;overflow-y:auto;max-height:calc(100vh - 280px)">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;flex-wrap:wrap;gap:12px">
                    <div>
                        <h2 style="margin:0;color:var(--text-body);font-size:18px">Social Profiles</h2>
                        ${businessName ? `<div style="color:var(--text-muted);font-size:13px;margin-top:2px">${this.utils.escapeHtml(businessName)}</div>` : ''}
                    </div>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        <button id="social-load-all-btn" data-mode="load" style="background:#6366f1;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:6px">
                            🔍 Load Profile Data
                        </button>
                        <button onclick="openSettings().then(()=>switchSettingsTab('social'))" style="background:var(--bg-elevated);color:var(--text-muted);border:1px solid var(--border-alt);padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:5px" title="Manage connected accounts">
                            + Connect Account
                        </button>
                    </div>
                </div>
                ${searchNotice}
                ${schemaBadge}
                ${emptyState}
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:16px">
                    ${cards}
                </div>
            </div>`;

        const loadBtn = this.container.querySelector('#social-load-all-btn');
        if (loadBtn) {
            loadBtn.addEventListener('click', () => {
                const mode = loadBtn.getAttribute('data-mode');
                const isRefresh = mode === 'refresh';
                loadBtn.disabled = true;
                this._loadAllProfiles(isRefresh).finally(() => {
                    loadBtn.disabled = false;
                });
            });
        }

        // Wire all per-card listeners
        this.container.querySelectorAll('[id^="social-card-"]').forEach(card => {
            const plt = card.id.replace('social-card-', '');
            const prof = (this.state.socialData && this.state.socialData.profiles && this.state.socialData.profiles[plt]) || null;
            this._wireCardListeners(plt, card, prof);
        });
    },

    _renderCard(platform, meta, profile, isConnected) {
        const isFound = !!profile;
        const isSearch = profile && profile.source === 'web_search';
        const url = profile ? profile.url : null;
        const handle = profile ? (profile.handle || '') : '';
        const displayHandle = handle && !handle.includes('.') && !/^\@?\d+$/.test(handle) ? handle : '';
        const profileData = profile ? (profile.data || null) : null;

        const borderColor = isSearch ? '#fbbf24' : 'var(--border-alt)';

        const sourceLabel = profile ? ({
            sameAs: 'JSON-LD sameAs',
            link_rel_me: 'link rel=me',
            external_link: 'External link',
            web_search: 'Web search \u2014 not linked on site',
            manual: 'Manually entered',
        }[profile.source] || profile.source) : '';

        const authBadge = !isConnected
            ? `<span style="color:var(--text-dim);font-size:11px;display:inline-flex;align-items:center;gap:4px">🔑 <a href="#" onclick="event.preventDefault();openSettings().then(()=>switchSettingsTab('social'))" style="color:#6366f1;text-decoration:none">Connect for auth</a></span>`
            : `<span style="background:var(--status-success-bg);border:1px solid var(--status-success-border);color:var(--status-success);padding:2px 8px;border-radius:12px;font-size:11px;display:inline-flex;align-items:center;gap:3px">🔑 Authenticated</span>`;

        // Platform icon — coloured circle with SVG inside
        const iconHtml = `<div style="width:36px;height:36px;border-radius:50%;background:${meta.color};display:flex;align-items:center;justify-content:center;flex-shrink:0">${meta.svg}</div>`;

        const footer = (extraLeft = '') => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding-top:10px;border-top:1px solid var(--border-alt)">
                <div style="display:flex;align-items:center;gap:8px">${authBadge}${extraLeft}</div>
                ${url ? `<a href="${this.utils.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" style="color:#6366f1;font-size:12px;text-decoration:none;white-space:nowrap">View \u2192</a>` : ''}
            </div>`;

        // ── State 1: Not linked on site ──────────────────────────────────────
        if (!isFound) {
            const placeholder = {
                facebook: 'https://facebook.com/yourpage',
                instagram: 'https://instagram.com/handle',
                twitter: 'https://x.com/handle',
                linkedin: 'https://linkedin.com/company/name',
                youtube: 'https://youtube.com/@channel',
                tiktok: 'https://tiktok.com/@handle',
                pinterest: 'https://pinterest.com/handle',
                yelp: 'https://yelp.com/biz/name',
            }[platform] || 'https://...';

            return `
                <div id="social-card-${platform}" style="background:var(--bg-elevated);border:1px solid var(--border-alt);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px">
                    <div style="display:flex;align-items:center;gap:10px">
                        ${iconHtml}
                        <div style="flex:1">
                            <div style="font-weight:600;color:var(--text-body);font-size:14px">${meta.name}</div>
                            <div style="font-size:11px;color:var(--text-muted);margin-top:1px">Not linked on site</div>
                        </div>
                    </div>
                    <div style="color:var(--text-muted);font-size:12px;line-height:1.4">No ${meta.name} link found. Paste a URL to fetch profile data.</div>
                    <div style="display:flex;gap:6px;align-items:stretch">
                        <div class="setting-group" style="margin:0;flex:1;min-width:0">
                            <input class="social-manual-url-input" type="text" placeholder="${placeholder}"
                                data-platform="${this.utils.escapeHtml(platform)}">
                        </div>
                        <button class="social-manual-fetch-btn" data-platform="${this.utils.escapeHtml(platform)}"
                            style="background:#6366f1;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0;align-self:stretch">
                            Fetch
                        </button>
                    </div>
                    ${footer()}
                </div>`;
        }

        const sourceBadge = sourceLabel
            ? `<span style="background:var(--bg-base);padding:2px 6px;border-radius:4px;font-size:10px;color:var(--text-muted)">${this.utils.escapeHtml(sourceLabel)}</span>`
            : '';

        // ── State 2: Found, data loaded — rich layout ────────────────────────
        if (profileData && Object.keys(profileData).length > 0) {
            const ogImage = profileData.image || profileData['og:image'];
            const ogTitle = profileData.title || profileData['og:title'];
            const ogDesc  = profileData.description || profileData['og:description'];
            const bio = profileData.about || (ogDesc ? ogDesc.substring(0, 160) : '');
            const followers  = profileData.followers;
            const posts      = profileData.posts;
            const subscribers = profileData.subscribers;
            const phone      = profileData.phone;
            const address    = profileData.address;
            const category    = profileData.category;
            const email       = profileData.email;
            const website     = profileData.website;
            const intro       = profileData.intro;
            const rating      = profileData.rating;
            const ratingCount = profileData.rating_count;
            const priceRange  = profileData.price_range;
            const links       = Array.isArray(profileData.links) ? profileData.links : [];
            const crawledDomain = this._getCrawledDomain();

            const avatarHtml = ogImage
                ? `<img src="${this.utils.escapeHtml(ogImage)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid var(--border-alt)" onerror="this.replaceWith(this.nextSibling)">${iconHtml}`
                : iconHtml.replace('width:36px;height:36px', 'width:48px;height:48px');

            let statsHtml = '';
            if (followers)   statsHtml += `<span>👥 <strong>${this.utils.escapeHtml(String(followers))}</strong> followers</span>`;
            if (posts)       statsHtml += `<span>📸 <strong>${this.utils.escapeHtml(String(posts))}</strong> posts</span>`;
            if (subscribers) statsHtml += `<span>🔔 <strong>${this.utils.escapeHtml(String(subscribers))}</strong></span>`;
            if (rating) {
                const rLabel = ratingCount ? `⭐ ${rating} (${this.utils.escapeHtml(String(ratingCount))} reviews)` : `⭐ ${rating}`;
                statsHtml += `<span>${this.utils.escapeHtml(rLabel)}</span>`;
            }
            if (priceRange) statsHtml += `<span>${this.utils.escapeHtml(priceRange)}</span>`;

            return `
                <div id="social-card-${platform}" style="background:var(--bg-elevated);border:1px solid ${borderColor};border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px">
                    <div style="display:flex;gap:12px;align-items:flex-start">
                        ${avatarHtml}
                        <div style="flex:1;min-width:0">
                            <div style="font-weight:600;font-size:14px;color:var(--text-body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ogTitle ? this.utils.escapeHtml(ogTitle) : meta.name}</div>
                            <div style="color:var(--text-muted);font-size:12px;margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                                ${displayHandle ? `<span>@${this.utils.escapeHtml(displayHandle)}</span>` : ''}
                                ${sourceBadge}
                            </div>
                            ${category ? `<div style="color:var(--text-muted);font-size:11px;margin-top:1px">${this.utils.escapeHtml(category)}</div>` : ''}
                            ${bio ? `<div style="color:var(--text-secondary);font-size:12px;margin-top:5px;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${this.utils.escapeHtml(bio)}</div>` : ''}
                        </div>
                    </div>
                    ${statsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--text-secondary);padding:8px 0;border-top:1px solid var(--border-alt);border-bottom:1px solid var(--border-alt)">${statsHtml}</div>` : ''}
                    ${(() => {
                        const _linkBadge = (url) => {
                            if (!crawledDomain) return '';
                            return this._domainsMatch(url, crawledDomain)
                                ? `<span style="background:var(--status-success-bg);color:var(--status-success);padding:1px 6px;border-radius:10px;font-size:10px;margin-left:4px" title="Matches crawled site">✓ Match</span>`
                                : `<span style="background:var(--status-warning-bg);color:var(--status-warning);padding:1px 6px;border-radius:10px;font-size:10px;margin-left:4px" title="Domain does not match — verify manually">⚠ Verify</span>`;
                        };
                        const contactItems = [];
                        if (email)   contactItems.push(`<span>✉ <a href="mailto:${this.utils.escapeHtml(email)}" style="color:#6366f1;text-decoration:none">${this.utils.escapeHtml(email)}</a></span>`);
                        if (phone)   contactItems.push(`<span>📞 ${this.utils.escapeHtml(phone)}</span>`);
                        if (address) contactItems.push(`<span>📍 ${this.utils.escapeHtml(address)}</span>`);
                        if (intro)   contactItems.push(`<span style="color:var(--text-muted);font-style:italic">${this.utils.escapeHtml(intro.length>120?intro.substring(0,120)+'\u2026':intro)}</span>`);
                        if (website) {
                            const disp = website.length>50 ? website.substring(0,50)+'\u2026' : website;
                            contactItems.push(`<span>🌐 <a href="${this.utils.escapeHtml(website)}" target="_blank" rel="noopener noreferrer" style="color:#6366f1;text-decoration:none">${this.utils.escapeHtml(disp)}</a>${_linkBadge(website)}</span>`);
                        }
                        for (const lnk of links) {
                            if (lnk === website) continue;
                            const disp = lnk.replace(/^https?:\/\/(www\.)?/,'');
                            contactItems.push(`<span>🔗 <a href="${this.utils.escapeHtml(lnk)}" target="_blank" rel="noopener noreferrer" style="color:#6366f1;text-decoration:none">${this.utils.escapeHtml(disp.length>45?disp.substring(0,45)+'\u2026':disp)}</a>${_linkBadge(lnk)}</span>`);
                        }
                        return contactItems.length
                            ? `<div style="display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--text-secondary);padding:8px 0;border-top:1px solid var(--border-alt)">${contactItems.join('')}</div>`
                            : '';
                    })()}
                    <div style="display:flex;gap:6px;align-items:center">
                        <span style="color:var(--text-muted);font-size:12px;flex-shrink:0">URL:</span>
                        <div class="setting-group" style="margin:0;flex:1;min-width:0">
                            <input class="social-url-input" type="text" value="${this.utils.escapeHtml(url || '')}">
                        </div>
                        <button class="social-refetch-btn" data-platform="${this.utils.escapeHtml(platform)}"
                            style="background:var(--bg-base);color:#6366f1;border:1px solid #6366f1;padding:5px 14px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;flex-shrink:0">
                            Re-fetch &#x21ba;
                        </button>
                    </div>
                    <div>
                        <button class="social-details-toggle" data-expanded="false"
                            style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;padding:0;display:flex;align-items:center;gap:4px">
                            &#x25bc; Profile details
                        </button>
                        <div class="social-details-content" style="display:none;margin-top:6px">
                            <table style="width:100%;font-size:11px;border-collapse:collapse">
                                ${Object.entries(profileData).filter(([k, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => {
                                    const label = k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                                    let valHtml;
                                    if (Array.isArray(v)) {
                                        valHtml = v.map(item => {
                                            const s = String(item);
                                            return s.startsWith('http')
                                                ? `<a href="${this.utils.escapeHtml(s)}" target="_blank" rel="noopener noreferrer" style="color:#6366f1;display:block">${this.utils.escapeHtml(s.length>60?s.substring(0,60)+'\u2026':s)}</a>`
                                                : this.utils.escapeHtml(s);
                                        }).join('');
                                    } else {
                                        const vStr = String(v);
                                        valHtml = vStr.startsWith('http')
                                            ? `<a href="${this.utils.escapeHtml(vStr)}" target="_blank" rel="noopener noreferrer" style="color:#6366f1">${this.utils.escapeHtml(vStr.length > 60 ? vStr.substring(0, 60) + '\u2026' : vStr)}</a>`
                                            : this.utils.escapeHtml(vStr);
                                    }
                                    return `<tr>
                                        <td style="color:var(--text-muted);padding:3px 8px 3px 0;vertical-align:top;width:30%">${this.utils.escapeHtml(label)}</td>
                                        <td style="color:var(--text-body);padding:3px 0;word-break:break-all">${valHtml}</td>
                                    </tr>`;
                                }).join('')}
                            </table>
                        </div>
                    </div>
                    ${footer()}
                </div>`;
        }

        // ── State 3: Found, URL known, no data yet ───────────────────────────
        const statusBadge = isSearch
            ? `<span style="background:var(--status-warning-bg);color:var(--status-warning);padding:2px 8px;border-radius:12px;font-size:11px">Via search</span>`
            : `<span style="background:var(--status-success-bg);color:var(--status-success);padding:2px 8px;border-radius:12px;font-size:11px">Found</span>`;

        return `
            <div id="social-card-${platform}" style="background:var(--bg-elevated);border:1px solid ${borderColor};border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:10px">
                    ${iconHtml}
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;color:var(--text-body);font-size:14px;display:flex;align-items:center;gap:8px">
                            ${meta.name} ${statusBadge}
                        </div>
                        <div style="color:var(--text-muted);font-size:12px;margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                            ${displayHandle ? `<span>@${this.utils.escapeHtml(displayHandle)}</span>` : ''}
                            ${sourceBadge}
                        </div>
                    </div>
                </div>
                ${isSearch ? `<div style="color:#fbbf24;font-size:11px">Not linked directly on website</div>` : ''}
                <div style="display:flex;gap:6px;align-items:stretch">
                    <div class="setting-group" style="margin:0;flex:1;min-width:0">
                        <input class="social-url-input" type="text" value="${this.utils.escapeHtml(url || '')}" placeholder="https://...">
                    </div>
                    <button class="social-fetch-btn" data-platform="${this.utils.escapeHtml(platform)}"
                        style="background:#6366f1;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0;align-self:stretch">
                        Fetch
                    </button>
                </div>
                ${footer()}
            </div>`;
    },
});
