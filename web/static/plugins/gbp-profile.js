/**
 * Google Business Profile Plugin for LibreCrawl
 *
 * Extracts business contact info from crawled pages, looks up Google Business
 * Profile data via the Places API, and displays ratings, reviews, hours,
 * photos, and a NAP consistency audit.
 */
LibreCrawlPlugin.register({
    id: 'gbp-profile',
    name: 'Google Business Profile',
    version: '1.0.0',
    author: 'LibreCrawl',
    description: 'Find and display Google Business Profile data for crawled domains',
    tab: {
        label: 'GBP',
        icon: '\uD83D\uDCCD',
        position: 'end'
    },

    // --- State ---
    gbpData: null,
    currentData: null,
    selectedBranchIndex: 0,
    photosLoaded: {},
    reviewsOpen: false,
    hoursOpen: false,
    loading: false,
    apiKey: '',

    // --- Lifecycle ---

    onLoad() {
        console.log('[GBP] Plugin loaded');
    },

    _extractDomain(urls) {
        if (!urls || urls.length === 0) return '';
        try { return new URL(urls[0].url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
    },

    onTabActivate(container, data) {
        this.currentData = data;
        this.container = container;
        // Clear stale state if domain has changed
        const newDomain = this._extractDomain(data && data.urls);
        if (this.gbpData && this.gbpData.domain !== newDomain) {
            this.gbpData = null;
            this.selectedBranchIndex = 0;
            this.photosLoaded = {};
            this.reviewsOpen = false;
            this.hoursOpen = false;
        }
        this.loadSettings().then(() => {
            if (this.gbpData) {
                this.render(container);
            } else {
                this.fetchGBPData(data).then(() => this.render(container));
            }
        });
    },

    onTabDeactivate() {},

    onDataUpdate(data) {
        this.currentData = data;
        // Clear stale state if domain has changed
        const newDomain = this._extractDomain(data && data.urls);
        if (this.gbpData && this.gbpData.domain !== newDomain) {
            this.gbpData = null;
            this.selectedBranchIndex = 0;
            this.photosLoaded = {};
            this.reviewsOpen = false;
            this.hoursOpen = false;
            if (this.isActive) {
                this.fetchGBPData(data).then(gbp => this.render(this.container, data, gbp));
            }
        }
    },

    onCrawlComplete(data) {
        this.currentData = data;
        this.gbpData = null;
        if (this.isActive) {
            this.fetchGBPData(data).then(() => this.render(this.container));
        }
    },

    // --- Settings ---

    async loadSettings() {
        try {
            const resp = await fetch('/api/get_settings');
            if (resp.ok) {
                const result = await resp.json();
                if (result.success && result.settings) {
                    this.apiKey = result.settings.google_places_api_key || '';
                }
            }
        } catch (e) {
            console.error('[GBP] Failed to load settings:', e);
        }
    },


    // --- Data Fetching ---

    async fetchGBPData(data, forceRefresh = false) {
        this.loading = true;
        if (this.isActive) this.renderLoading(this.container);

        try {
            // Try GET first (active crawl session)
            const gbpUrl = forceRefresh ? '/api/gbp?refresh=1' : '/api/gbp';
            let resp = await fetch(gbpUrl);
            if (resp.ok) {
                const result = await resp.json();
                if (!result.error) {
                    this.gbpData = result;
                    this.loading = false;
                    return;
                }
            }

            // Fallback: POST with local data (for saved crawls)
            if (data && data.urls && data.urls.length > 0) {
                resp = await fetch('/api/gbp', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ urls: data.urls })
                });
                if (resp.ok) {
                    this.gbpData = await resp.json();
                }
            }
        } catch (e) {
            console.error('[GBP] Fetch error:', e);
            this.gbpData = { error: e.message };
        }

        this.loading = false;
    },

    async fetchPhoto(photoName, imgEl) {
        if (this.photosLoaded[photoName]) {
            imgEl.src = this.photosLoaded[photoName];
            return;
        }
        try {
            const resp = await fetch(`/api/gbp/photo?name=${encodeURIComponent(photoName)}&max_width=400`);
            if (resp.ok) {
                const data = await resp.json();
                if (data.url) {
                    this.photosLoaded[photoName] = data.url;
                    imgEl.src = data.url;
                    imgEl.style.display = 'block';
                }
            }
        } catch (e) {
            console.error('[GBP] Photo fetch error:', e);
        }
    },

    // --- Rendering ---

    renderLoading(container) {
        container.innerHTML = `
            <div class="plugin-content" style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">
                <div style="text-align: center; padding: 60px 20px; color: var(--text-muted);">
                    <div style="font-size: 24px; margin-bottom: 12px;">Loading GBP data...</div>
                    <div style="font-size: 14px;">Searching Google Places API</div>
                </div>
            </div>`;
    },

    render(container) {
        const esc = this.utils.escapeHtml.bind(this.utils);
        const data = this.gbpData;

        let html = '<div class="plugin-content" style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">';

        // Build last-fetched label
        const ts = data && (data._fetched_at || data.analyzed_at);
        const fetchedLabel = ts
            ? `<span style="color: var(--text-dim); font-size: 12px;">Last fetched: ${esc(new Date(ts).toLocaleString())}</span>`
            : '';

        // Header
        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <div>
                    <h2 style="font-size: 22px; font-weight: 700; color: var(--text-body); margin: 0;">
                        Google Business Profile
                    </h2>
                    <p style="color: var(--text-muted); font-size: 13px; margin: 4px 0 0 0;">
                        Business listing data from Google Places API
                    </p>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    ${fetchedLabel}
                    <button id="gbp-refresh-btn" style="padding: 8px 16px; background: var(--accent-1); color: var(--text-primary); border: none; border-radius: 8px; cursor: pointer; font-size: 13px;">
                        Refresh
                    </button>
                </div>
            </div>`;

        if (!data) {
            html += this.renderEmptyState();
        } else if (data.error) {
            html += this.renderError(esc(data.error));
        } else if (data.no_api_key) {
            html += this.renderExtractedInfo(data, esc);
            html += this.renderNoKeyBanner();
        } else {
            html += this.renderExtractedInfo(data, esc);

            const branches = data.branches || [];
            if (branches.length > 1) {
                html += this.renderBranchOverview(branches, esc);
                html += this.renderBranchSelector(branches, esc);
            }

            if (branches.length > 0) {
                const branch = branches[this.selectedBranchIndex] || branches[0];
                html += '<div id="gbp-branch-detail">';
                html += this.renderBranchDetail(branch, esc);
                html += '</div>';
            } else {
                html += `<div style="background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center; color: var(--text-muted);">
                    No matching Google Business Profile found for the search query.
                </div>`;
            }
        }

        html += '</div>';
        container.innerHTML = html;
        this.bindEvents(container);
    },


    renderEmptyState() {
        return `
            <div style="background: var(--bg-elevated); padding: 40px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center;">
                <div style="font-size: 48px; margin-bottom: 16px;">📍</div>
                <h3 style="color: var(--text-body); font-size: 18px; margin: 0 0 8px 0;">No Data Available</h3>
                <p style="color: var(--text-muted); font-size: 14px; margin: 0;">
                    Start a crawl or load a saved crawl to see Google Business Profile data.
                </p>
            </div>`;
    },

    renderError(message) {
        return `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--status-error); margin-bottom: 20px;">
                <div style="color: var(--status-error); font-size: 14px; font-weight: 600; margin-bottom: 4px;">Error</div>
                <div style="color: var(--text-secondary); font-size: 13px;">${message}</div>
            </div>`;
    },

    renderNoKeyBanner() {
        return `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--status-warning); margin-bottom: 20px;">
                <div style="color: var(--status-warning); font-size: 14px; font-weight: 600; margin-bottom: 4px;">API Key Required</div>
                <div style="color: var(--text-secondary); font-size: 13px;">
                    Set a Google Places API key in the global <strong>Settings &gt; Requests</strong> tab to fetch full GBP data including ratings, reviews, and hours.
                </div>
            </div>`;
    },

    renderExtractedInfo(data, esc) {
        const branches = data.branches || [];
        if (branches.length === 0) return '';

        const extracted = branches.map(b => b.extracted).filter(e => e && e.from_structured_data);
        if (extracted.length === 0 && data.brand_name) {
            return `
                <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                    <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 12px 0;">Extracted from Website</h3>
                    <div style="color: var(--text-secondary); font-size: 13px;">Brand: ${esc(data.brand_name)}</div>
                    <div style="color: var(--text-dim); font-size: 12px; margin-top: 4px;">No structured data (JSON-LD) found on the site.</div>
                </div>`;
        }

        if (extracted.length === 0) return '';

        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 12px 0;">
                    Extracted from Website ${extracted.length > 1 ? `(${extracted.length} locations)` : ''}
                </h3>
                <div style="display: flex; flex-wrap: wrap; gap: 12px;">`;

        for (const e of extracted.slice(0, 6)) {
            const addr = e.address || {};
            const addrStr = [addr.street, addr.city, addr.region, addr.postal].filter(Boolean).join(', ');
            html += `
                <div style="background: var(--bg-base); padding: 12px; border-radius: 8px; border: 1px solid var(--border-alt); min-width: 220px; flex: 1;">
                    <div style="color: var(--text-body); font-size: 14px; font-weight: 600;">${esc(e.name)}</div>
                    ${addrStr ? `<div style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">${esc(addrStr)}</div>` : ''}
                    ${e.telephone ? `<div style="color: var(--text-muted); font-size: 12px; margin-top: 2px;">${esc(e.telephone)}</div>` : ''}
                </div>`;
        }

        html += '</div></div>';
        return html;
    },

    renderBranchOverview(branches, esc) {
        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 12px 0;">
                    ${branches.length} Locations Found
                </h3>
                <table style="width: 100%; border-collapse: collapse;">
                    <thead>
                        <tr style="border-bottom: 1px solid var(--border-alt);">
                            <th style="padding: 8px; text-align: left; color: var(--text-muted); font-size: 12px; font-weight: 600;">Location</th>
                            <th style="padding: 8px; text-align: left; color: var(--text-muted); font-size: 12px; font-weight: 600;">Rating</th>
                            <th style="padding: 8px; text-align: left; color: var(--text-muted); font-size: 12px; font-weight: 600;">Reviews</th>
                            <th style="padding: 8px; text-align: left; color: var(--text-muted); font-size: 12px; font-weight: 600;">Status</th>
                            <th style="padding: 8px; text-align: left; color: var(--text-muted); font-size: 12px; font-weight: 600;">Match</th>
                        </tr>
                    </thead>
                    <tbody>`;

        for (let i = 0; i < branches.length; i++) {
            const b = branches[i];
            const gbp = b.gbp;
            const name = gbp ? (gbp.displayName?.text || '') : (b.extracted?.name || '');
            const addr = gbp ? (gbp.shortFormattedAddress || '') : (b.extracted?.address?.city || '');
            const rating = gbp ? (gbp.rating || '-') : '-';
            const reviews = gbp ? (gbp.userRatingCount || 0) : '-';
            const status = gbp ? this.formatStatus(gbp.businessStatus) : '-';
            const confidence = b.match_confidence || 0;

            html += `
                <tr class="gbp-branch-row" data-index="${i}" style="border-bottom: 1px solid var(--border-alt); cursor: pointer;${i === this.selectedBranchIndex ? ' background: var(--bg-base);' : ''}">
                    <td style="padding: 8px; color: var(--text-secondary); font-size: 13px;">
                        <div>${esc(name)}</div>
                        <div style="color: var(--text-dim); font-size: 11px;">${esc(addr)}</div>
                    </td>
                    <td style="padding: 8px; color: #fbbf24; font-size: 13px;">${rating !== '-' ? '★ ' + rating : '-'}</td>
                    <td style="padding: 8px; color: var(--text-secondary); font-size: 13px;">${reviews}</td>
                    <td style="padding: 8px; font-size: 13px;">${status}</td>
                    <td style="padding: 8px; font-size: 13px;">
                        <span style="color: ${confidence >= 50 ? '#10b981' : confidence >= 20 ? '#f59e0b' : '#ef4444'};">
                            ${confidence}%
                        </span>
                    </td>
                </tr>`;
        }

        html += '</tbody></table></div>';
        return html;
    },

    renderBranchSelector(branches, esc) {
        let html = `
            <div style="margin-bottom: 20px; display: flex; align-items: center; gap: 12px;">
                <label style="color: var(--text-dim); font-size: 13px;">Location:</label>
                <select id="gbp-branch-select" style="background: var(--bg-card); border: 1px solid var(--border-standard); color: var(--text-body); padding: 8px 12px; border-radius: 8px; font-size: 13px; cursor: pointer;">`;

        for (let i = 0; i < branches.length; i++) {
            const b = branches[i];
            const gbp = b.gbp;
            const name = gbp ? (gbp.displayName?.text || '') : (b.extracted?.name || '');
            const city = gbp ? (gbp.shortFormattedAddress || '') : (b.extracted?.address?.city || '');
            const selected = i === this.selectedBranchIndex ? ' selected' : '';

            html += `<option value="${i}"${selected}>${esc(name)}${city ? ' \u2014 ' + esc(city) : ''}</option>`;
        }

        html += '</select></div>';
        return html;
    },

    renderBranchDetail(branch, esc) {
        if (!branch) return '';
        const gbp = branch.gbp;

        let html = '';

        if (branch.error) {
            html += this.renderError(esc(branch.error));
        }

        if (gbp) {
            html += this.renderStatCards(gbp, esc);
            html += this.renderBusinessDetails(gbp, esc);
            html += this.renderHours(gbp, esc);
            html += this.renderPhotos(gbp, esc);
            html += this.renderReviews(gbp, esc);
        } else if (!branch.error) {
            html += `
                <div style="background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center; color: var(--text-muted); margin-bottom: 20px;">
                    No matching Google Business Profile found.<br>
                    <span style="font-size: 12px;">Search query: "${esc(branch.search_query || '')}"</span>
                </div>`;
        }

        // NAP Audit
        html += this.renderNAPAudit(branch, esc);

        return html;
    },

    renderStatCards(gbp, esc) {
        const rating = gbp.rating || 0;
        const reviews = gbp.userRatingCount || 0;
        const status = gbp.businessStatus || 'UNKNOWN';
        const price = gbp.priceLevel || '';

        const statusColor = status === 'OPERATIONAL' ? '#10b981' : status === 'CLOSED_PERMANENTLY' ? '#ef4444' : '#f59e0b';
        const statusLabel = status.replace(/_/g, ' ');

        const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));

        return `
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px;">
                <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center;">
                    <div style="color: #fbbf24; font-size: 20px; letter-spacing: 2px;">${stars}</div>
                    <div style="color: var(--text-body); font-size: 24px; font-weight: 700; margin-top: 4px;">${rating || '-'}</div>
                    <div style="color: var(--text-muted); font-size: 12px;">Rating</div>
                </div>
                <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center;">
                    <div style="color: var(--text-body); font-size: 24px; font-weight: 700;">${reviews.toLocaleString()}</div>
                    <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">Reviews</div>
                </div>
                <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center;">
                    <div style="color: ${statusColor}; font-size: 16px; font-weight: 600;">${esc(statusLabel)}</div>
                    <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">Status</div>
                </div>
                <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); text-align: center;">
                    <div style="color: var(--text-body); font-size: 24px; font-weight: 700;">${price ? esc(price) : '-'}</div>
                    <div style="color: var(--text-muted); font-size: 12px; margin-top: 4px;">Price Level</div>
                </div>
            </div>`;
    },

    renderBusinessDetails(gbp, esc) {
        const name = gbp.displayName?.text || '';
        const address = gbp.formattedAddress || '';
        const phone = gbp.nationalPhoneNumber || gbp.internationalPhoneNumber || '';
        const website = gbp.websiteUri || '';
        const mapsUrl = gbp.googleMapsUri || '';
        const types = (gbp.types || []).slice(0, 8);
        const summary = gbp.editorialSummary?.text || '';

        let html = `
            <div style="background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <h3 style="font-size: 16px; font-weight: 600; color: var(--text-body); margin: 0 0 16px 0;">Business Details</h3>
                <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; font-size: 13px;">`;

        if (name) html += `<div style="color: var(--text-muted);">Name</div><div style="color: var(--text-body); font-weight: 600;">${esc(name)}</div>`;
        if (address) html += `<div style="color: var(--text-muted);">Address</div><div style="color: var(--text-secondary);">${esc(address)}</div>`;
        if (phone) html += `<div style="color: var(--text-muted);">Phone</div><div><a href="tel:${esc(phone)}" style="color: var(--status-info); text-decoration: none;">${esc(phone)}</a></div>`;
        if (website) html += `<div style="color: var(--text-muted);">Website</div><div><a href="${esc(website)}" target="_blank" style="color: var(--status-info); text-decoration: none;">${esc(website)}</a></div>`;
        if (mapsUrl) html += `<div style="color: var(--text-muted);">Google Maps</div><div><a href="${esc(mapsUrl)}" target="_blank" style="color: var(--status-info); text-decoration: none;">View on Maps</a></div>`;

        html += '</div>';

        if (summary) {
            html += `<div style="color: var(--text-muted); font-size: 13px; margin-top: 12px; font-style: italic;">${esc(summary)}</div>`;
        }

        if (types.length > 0) {
            html += '<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px;">';
            for (const t of types) {
                const label = t.replace(/_/g, ' ');
                html += `<span style="padding: 4px 10px; background: var(--bg-base); border: 1px solid var(--border-alt); border-radius: 12px; color: var(--text-muted); font-size: 11px;">${esc(label)}</span>`;
            }
            html += '</div>';
        }

        html += '</div>';
        return html;
    },

    renderHours(gbp, esc) {
        const hours = gbp.regularOpeningHours;
        if (!hours || !hours.weekdayDescriptions || hours.weekdayDescriptions.length === 0) return '';

        const isOpen = gbp.currentOpeningHours?.openNow;
        const openLabel = isOpen === true ? '<span style="color: var(--status-success);">Open Now</span>' :
                          isOpen === false ? '<span style="color: var(--status-error);">Closed</span>' : '';

        const display = this.hoursOpen ? 'block' : 'none';
        const arrow = this.hoursOpen ? '▼' : '▶';

        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <div id="gbp-hours-toggle" style="display: flex; justify-content: space-between; align-items: center; cursor: pointer;">
                    <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0;">
                        <span id="gbp-hours-arrow">${arrow}</span> Opening Hours ${openLabel}
                    </h3>
                </div>
                <div id="gbp-hours-content" style="display: ${display}; margin-top: 12px;">
                    <table style="width: 100%; border-collapse: collapse;">`;

        for (const day of hours.weekdayDescriptions) {
            const parts = day.split(/:\s*(.+)/);
            const dayName = parts[0] || day;
            const time = parts[1] || '';
            html += `
                <tr style="border-bottom: 1px solid var(--border-alt);">
                    <td style="padding: 6px 8px; color: var(--text-secondary); font-size: 13px; font-weight: 500; width: 120px;">${esc(dayName)}</td>
                    <td style="padding: 6px 8px; color: var(--text-muted); font-size: 13px;">${esc(time)}</td>
                </tr>`;
        }

        html += '</table></div></div>';
        return html;
    },

    renderPhotos(gbp, esc) {
        const photos = gbp.photos;
        if (!photos || photos.length === 0) return '';

        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 12px 0;">Photos</h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px;">`;

        for (const photo of photos.slice(0, 10)) {
            const name = photo.name || '';
            html += `
                <div class="gbp-photo-tile" data-photo-name="${esc(name)}"
                    style="aspect-ratio: 4/3; background: var(--bg-base); border-radius: 8px; border: 1px solid var(--border-alt); overflow: hidden; cursor: pointer; display: flex; align-items: center; justify-content: center;">
                    <img class="gbp-photo-img" style="width: 100%; height: 100%; object-fit: cover; display: none;" alt="Business photo">
                    <span class="gbp-photo-placeholder" style="color: var(--border-standard); font-size: 24px;">📷</span>
                </div>`;
        }

        html += '</div></div>';
        return html;
    },

    renderReviews(gbp, esc) {
        const reviews = gbp.reviews;
        if (!reviews || reviews.length === 0) return '';

        const display = this.reviewsOpen ? 'block' : 'none';
        const arrow = this.reviewsOpen ? '▼' : '▶';

        const mapsUri = gbp.googleMapsUri || '';

        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <div id="gbp-reviews-toggle" style="cursor: pointer;">
                    <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 2px 0;">
                        <span id="gbp-reviews-arrow">${arrow}</span> Reviews (${reviews.length} shown)
                    </h3>
                    <div style="color: var(--text-dim); font-size: 12px; margin-left: 18px;">Google provides up to 5 most relevant reviews via their API</div>
                </div>
                <div id="gbp-reviews-content" style="display: ${display}; margin-top: 12px;">`;

        for (const review of reviews) {
            const author = review.authorAttribution?.displayName || 'Anonymous';
            const rating = review.rating || 0;
            const text = review.text?.text || '';
            const time = review.relativePublishTimeDescription || '';
            const stars = '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating));

            html += `
                <div style="background: var(--bg-base); padding: 14px; border-radius: 8px; border: 1px solid var(--border-alt); margin-bottom: 8px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <span style="color: var(--text-body); font-size: 13px; font-weight: 600;">${esc(author)}</span>
                        <span style="color: var(--text-dim); font-size: 11px;">${esc(time)}</span>
                    </div>
                    <div style="color: #fbbf24; font-size: 14px; margin-bottom: 6px;">${stars}</div>
                    ${text ? `<div style="color: var(--text-muted); font-size: 13px; line-height: 1.5; border-left: 2px solid var(--border-alt); padding-left: 12px;">${esc(text)}</div>` : ''}
                </div>`;
        }

        if (mapsUri) {
            html += `
                <div style="margin-top: 12px; text-align: right;">
                    <a href="${esc(mapsUri)}" target="_blank" rel="noopener" style="color: var(--status-info); font-size: 13px; text-decoration: none;">View all reviews on Google Maps →</a>
                </div>`;
        }

        html += '</div></div>';
        return html;
    },

    renderNAPAudit(branch, esc) {
        const extracted = branch.extracted;
        const gbp = branch.gbp;
        if (!extracted || !gbp) return '';

        const issues = [];
        const matches = [];

        // Name comparison
        const siteName = (extracted.name || '').toLowerCase().trim();
        const gbpName = (gbp.displayName?.text || '').toLowerCase().trim();
        if (siteName && gbpName) {
            if (siteName === gbpName) {
                matches.push('Business name matches');
            } else {
                issues.push({ severity: 'warning', text: `Name mismatch: site has "${esc(extracted.name)}" vs GBP "${esc(gbp.displayName?.text || '')}"` });
            }
        }

        // Phone comparison
        const sitePhone = (extracted.telephone || '').replace(/\D/g, '');
        const gbpPhone = (gbp.nationalPhoneNumber || gbp.internationalPhoneNumber || '').replace(/\D/g, '');
        if (sitePhone && gbpPhone) {
            if (sitePhone === gbpPhone || sitePhone.endsWith(gbpPhone) || gbpPhone.endsWith(sitePhone)) {
                matches.push('Phone number matches');
            } else {
                issues.push({ severity: 'error', text: `Phone mismatch: site has "${esc(extracted.telephone)}" vs GBP "${esc(gbp.nationalPhoneNumber || gbp.internationalPhoneNumber || '')}"` });
            }
        } else if (!sitePhone && gbpPhone) {
            issues.push({ severity: 'warning', text: 'Phone number not found on website' });
        }

        // Address comparison
        const siteCity = (extracted.address?.city || '').toLowerCase();
        const gbpAddress = (gbp.formattedAddress || '').toLowerCase();
        if (siteCity && gbpAddress) {
            if (gbpAddress.includes(siteCity)) {
                matches.push('City matches in address');
            } else {
                issues.push({ severity: 'warning', text: `Address city mismatch: site has "${esc(extracted.address.city)}"` });
            }
        }

        // Website URL check
        const gbpWebsite = gbp.websiteUri || '';
        if (gbpWebsite) {
            try {
                const gbpDomain = new URL(gbpWebsite).hostname.replace('www.', '');
                const siteDomain = (this.gbpData?.domain || '').replace('www.', '');
                if (gbpDomain === siteDomain) {
                    matches.push('Website URL matches');
                } else {
                    issues.push({ severity: 'warning', text: `GBP website (${esc(gbpWebsite)}) does not match crawled domain` });
                }
            } catch (e) { /* ignore */ }
        }

        // Structured data check
        if (!extracted.from_structured_data) {
            issues.push({ severity: 'info', text: 'No LocalBusiness JSON-LD schema found on website — adding structured data improves local SEO' });
        }

        if (issues.length === 0 && matches.length === 0) return '';

        const severityIcon = { error: '🔴', warning: '🟡', info: '🔵' };

        let html = `
            <div style="background: var(--bg-elevated); padding: 16px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 20px;">
                <h3 style="font-size: 15px; font-weight: 600; color: var(--text-body); margin: 0 0 12px 0;">NAP Consistency Audit</h3>`;

        if (matches.length > 0) {
            for (const m of matches) {
                html += `<div style="color: var(--status-success); font-size: 13px; margin-bottom: 4px;">✅ ${m}</div>`;
            }
        }
        if (issues.length > 0) {
            for (const issue of issues) {
                html += `<div style="color: ${issue.severity === 'error' ? 'var(--status-error)' : issue.severity === 'warning' ? 'var(--status-warning)' : 'var(--status-info)'}; font-size: 13px; margin-bottom: 4px;">
                    ${severityIcon[issue.severity]} ${issue.text}
                </div>`;
            }
        }

        html += '</div>';
        return html;
    },

    formatStatus(status) {
        if (!status) return '-';
        const color = status === 'OPERATIONAL' ? '#10b981' : status === 'CLOSED_PERMANENTLY' ? '#ef4444' : '#f59e0b';
        const label = status.replace(/_/g, ' ');
        return `<span style="color: ${color};">${label}</span>`;
    },

    // --- Event Binding ---

    bindEvents(container) {
        const self = this;

        // Refresh button
        const refreshBtn = container.querySelector('#gbp-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                self.gbpData = null;
                self.photosLoaded = {};
                self.selectedBranchIndex = 0;
                self.fetchGBPData(self.currentData, true).then(() => self.render(container));
            });
        }

        // Branch selector dropdown
        const branchSelect = container.querySelector('#gbp-branch-select');
        if (branchSelect) {
            branchSelect.addEventListener('change', () => {
                const idx = parseInt(branchSelect.value, 10);
                if (idx !== self.selectedBranchIndex) {
                    self.selectedBranchIndex = idx;
                    self.photosLoaded = {};
                    // Update overview table highlight
                    container.querySelectorAll('.gbp-branch-row').forEach((row, i) => {
                        row.style.background = i === idx ? 'var(--bg-base)' : '';
                    });
                    // Update detail section
                    const detailEl = container.querySelector('#gbp-branch-detail');
                    if (detailEl && self.gbpData) {
                        const branch = self.gbpData.branches[idx];
                        detailEl.innerHTML = self.renderBranchDetail(branch, self.utils.escapeHtml.bind(self.utils));
                        self.bindDetailEvents(container);
                    }
                }
            });
        }

        // Branch overview row clicks — sync to select dropdown
        container.querySelectorAll('.gbp-branch-row').forEach(row => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.index, 10);
                const selectEl = container.querySelector('#gbp-branch-select');
                if (selectEl) {
                    selectEl.selectedIndex = idx;
                    selectEl.dispatchEvent(new Event('change'));
                }
            });
        });

        // Detail events
        this.bindDetailEvents(container);
    },

    bindDetailEvents(container) {
        const self = this;

        // Hours accordion
        const hoursToggle = container.querySelector('#gbp-hours-toggle');
        if (hoursToggle) {
            hoursToggle.addEventListener('click', () => {
                self.hoursOpen = !self.hoursOpen;
                const content = container.querySelector('#gbp-hours-content');
                const arrow = container.querySelector('#gbp-hours-arrow');
                if (content) content.style.display = self.hoursOpen ? 'block' : 'none';
                if (arrow) arrow.textContent = self.hoursOpen ? '▼' : '▶';
            });
        }

        // Reviews accordion
        const reviewsToggle = container.querySelector('#gbp-reviews-toggle');
        if (reviewsToggle) {
            reviewsToggle.addEventListener('click', () => {
                self.reviewsOpen = !self.reviewsOpen;
                const content = container.querySelector('#gbp-reviews-content');
                const arrow = container.querySelector('#gbp-reviews-arrow');
                if (content) content.style.display = self.reviewsOpen ? 'block' : 'none';
                if (arrow) arrow.textContent = self.reviewsOpen ? '▼' : '▶';
            });
        }

        // Photo tiles - lazy load on click
        container.querySelectorAll('.gbp-photo-tile').forEach(tile => {
            tile.addEventListener('click', () => {
                const photoName = tile.dataset.photoName;
                const img = tile.querySelector('.gbp-photo-img');
                const placeholder = tile.querySelector('.gbp-photo-placeholder');
                if (img && photoName) {
                    if (placeholder) placeholder.style.display = 'none';
                    img.style.display = 'block';
                    self.fetchPhoto(photoName, img);
                }
            });
        });
    },
});
