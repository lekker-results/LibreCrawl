/**
 * SEO Images Analyzer Plugin for LibreCrawl
 * Aggregates and displays image SEO data from crawled pages
 *
 * @author LibreCrawl Community
 * @version 1.0.0
 */

LibreCrawlPlugin.register({
    id: 'seo-images',
    name: 'SEO Images',
    version: '1.0.0',
    author: 'LibreCrawl Community',
    description: 'Analyzes image SEO: alt text coverage, duplicates, previews, and per-page breakdown',

    tab: {
        label: 'Images',
        icon: '\uD83D\uDDBC\uFE0F',
        position: 'end'
    },

    // State
    imagesData: null,
    sortColumn: 'page',
    sortDirection: 'asc',
    seoSummaryOpen: false,
    activeFilter: 'all',

    onLoad() {
        console.log('\uD83D\uDDBC\uFE0F SEO Images plugin loaded');
    },

    onTabActivate(container, data) {
        this.container = container;
        this.currentData = data;
        this.imagesData = this.extractAllImages(data.urls || []);
        this.render(container);
    },

    onCrawlComplete(data) {
        this.currentData = data;
        this.imagesData = this.extractAllImages(data.urls || []);
        if (this.isActive && this.container) {
            this.render(this.container);
        }
    },

    onDataUpdate(data) {
        const prevUrls = this.currentData && this.currentData.urls ? this.currentData.urls.length : 0;
        const newUrls = data && data.urls ? data.urls.length : 0;
        this.currentData = data;

        if (this.isActive && this.container && newUrls > 0 && (prevUrls === 0 || Math.abs(newUrls - prevUrls) > prevUrls * 0.5)) {
            this.imagesData = this.extractAllImages(data.urls || []);
            this.render(this.container);
        }
    },

    /**
     * Flatten all url.images[] arrays into a single list with page context
     */
    extractAllImages(urls) {
        const images = [];
        const allowedExts = /\.(png|jpe?g|webp|gif|bmp|tiff?|ico|avif)(\?|#|$)/i;
        urls.forEach(urlData => {
            const pageUrl = urlData.url || '';
            (urlData.images || []).forEach(img => {
                const src = img.src || '';
                // Skip SVGs and other non-raster image types
                if (!src || /\.svg(\?|#|$)/i.test(src) || /svg\+xml/i.test(src)) return;
                // If URL has a recognizable extension, it must be an allowed one;
                // otherwise allow it (e.g. dynamic image URLs with no extension)
                const hasExt = /\.\w{2,5}(\?|#|$)/.test(src);
                if (hasExt && !allowedExts.test(src)) return;

                images.push({
                    src: src,
                    alt: img.alt || '',
                    width: img.width || '',
                    height: img.height || '',
                    page: pageUrl,
                    filename: this._extractFilename(src)
                });
            });
        });
        return images;
    },

    _extractFilename(src) {
        try {
            const pathname = new URL(src, 'https://placeholder.invalid').pathname;
            const parts = pathname.split('/');
            return parts[parts.length - 1] || src;
        } catch {
            const parts = src.split('/');
            return parts[parts.length - 1] || src;
        }
    },

    _shortPageUrl(fullUrl) {
        try {
            const u = new URL(fullUrl);
            return u.pathname + u.search || '/';
        } catch {
            return fullUrl;
        }
    },

    render(container) {
        const images = this.imagesData || [];

        if (images.length === 0) {
            container.innerHTML = this.renderEmptyState();
            return;
        }

        const filteredImages = this._getFilteredImages();

        container.innerHTML = `
            <div class="plugin-content" style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">
                ${this.renderHeader(images)}
                ${this.renderStatCards(images)}
                ${this.renderImagesTable(filteredImages)}
                ${this.renderSEOSummary(images)}
            </div>
        `;

        this.bindEvents(container);

        // Initialize column resizers (same as overview tables)
        const imgTable = container.querySelector('#img-table');
        if (imgTable && window.ColumnResizer) {
            new ColumnResizer(imgTable);
        }
    },

    _getFilteredImages() {
        const images = this.imagesData || [];
        if (this.activeFilter === 'missing-alt') return images.filter(img => !img.alt.trim());
        if (this.activeFilter === 'has-alt') return images.filter(img => img.alt.trim() !== '');
        if (this.activeFilter === 'long-alt') return images.filter(img => img.alt.trim().length > 80);
        return images;
    },

    renderHeader(images) {
        const total = images.length;
        const missingCount = images.filter(img => !img.alt.trim()).length;
        const hasAltCount = total - missingCount;
        const longAltCount = images.filter(img => img.alt.trim().length > 80).length;

        const btnBase = 'border: 1px solid; padding: 8px 16px; border-radius: 6px; cursor: pointer; transition: all 0.2s; font-size: 14px; font-weight: 500; min-width: 100px;';
        const isActive = (f) => this.activeFilter === f;

        return `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
                <div>
                    <h2 style="font-size: 28px; font-weight: 700; margin-bottom: 8px; color: var(--text-body);">
                        \uD83D\uDDBC\uFE0F SEO Images
                    </h2>
                    <p style="color: var(--text-muted); font-size: 14px;">
                        Image analysis from ${total} discovered images
                    </p>
                </div>
                <button id="img-export-csv" style="background: var(--bg-elevated); border: 1px solid var(--border-standard); color: var(--text-body); padding: 8px 16px; border-radius: 8px; cursor: pointer; font-size: 14px;">
                    Export CSV
                </button>
            </div>
            <div class="filter-bar" style="margin-bottom: 20px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap;">
                <button class="img-filter-btn ${isActive('all') ? 'active' : ''}" data-img-filter="all"
                    style="${btnBase} background: ${isActive('all') ? 'var(--bg-elevated)' : 'transparent'}; border-color: var(--border-standard); color: var(--text-primary);">
                    All Images <span style="opacity: 0.7;">(${total})</span>
                </button>
                <button class="img-filter-btn ${isActive('missing-alt') ? 'active' : ''}" data-img-filter="missing-alt"
                    style="${btnBase} background: var(--status-error-bg); border-color: var(--status-error-border); color: var(--status-error);">
                    Missing Alt <span style="opacity: 0.7;">(${missingCount})</span>
                </button>
                <button class="img-filter-btn ${isActive('has-alt') ? 'active' : ''}" data-img-filter="has-alt"
                    style="${btnBase} background: var(--status-success-bg); border-color: var(--status-success-border); color: var(--status-success);">
                    Has Alt <span style="opacity: 0.7;">(${hasAltCount})</span>
                </button>
                <button class="img-filter-btn ${isActive('long-alt') ? 'active' : ''}" data-img-filter="long-alt"
                    style="${btnBase} background: var(--status-warning-bg); border-color: var(--status-warning-border); color: var(--status-warning);">
                    Long Alt (&gt;80) <span style="opacity: 0.7;">(${longAltCount})</span>
                </button>
            </div>
        `;
    },

    renderStatCards(images) {
        const total = images.length;
        const missingAlt = images.filter(img => !img.alt.trim()).length;
        const pagesWithImages = new Set(images.map(img => img.page)).size;
        const avgPerPage = pagesWithImages > 0 ? (total / pagesWithImages).toFixed(1) : '0';

        const cards = [
            { label: 'Total Images', value: total, sub: 'across all pages', color: 'var(--status-info)' },
            { label: 'Missing Alt Text', value: missingAlt, sub: `${total > 0 ? Math.round(missingAlt / total * 100) : 0}% of images`, color: missingAlt > 0 ? 'var(--status-error)' : 'var(--status-success)' },
            { label: 'Pages with Images', value: pagesWithImages, sub: 'unique pages', color: 'var(--accent-2)' },
            { label: 'Avg Images/Page', value: avgPerPage, sub: 'per page with images', color: 'var(--status-warning)' },
        ];

        return `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">
                ${cards.map(c => `
                    <div style="background: var(--bg-elevated); padding: 20px; border-radius: 12px; border: 1px solid var(--border-alt);">
                        <div style="font-size: 13px; color: var(--text-muted); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px;">${c.label}</div>
                        <div style="font-size: 36px; font-weight: 700; color: ${c.color}; margin-bottom: 6px;">${c.value}</div>
                        <div style="font-size: 12px; color: var(--text-dim);">${c.sub}</div>
                    </div>
                `).join('')}
            </div>
        `;
    },

    renderImagesTable(images) {
        const sorted = this._sortImages(images);
        const arrow = (col) => this.sortColumn === col ? (this.sortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';

        const thBase = 'padding: 10px 8px; text-align: left; color: var(--text-muted); font-size: 13px; font-weight: 600; cursor: pointer; user-select: none;';
        const tdBase = 'padding: 8px; color: var(--text-secondary); font-size: 13px;';

        const rows = sorted.map((img, i) => {
            const hasAlt = img.alt.trim() !== '';
            const altDisplay = hasAlt
                ? this.utils.escapeHtml(img.alt)
                : '<span style="background: var(--status-error-bg); color: var(--status-error); padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">Missing</span>';
            const shortPage = this._shortPageUrl(img.page);

            return `
                <tr style="border-bottom: 1px solid var(--border-alt);" data-index="${i}">
                    <td style="${tdBase} width: 56px; min-width: 56px;">
                        <span class="img-preview-placeholder" data-src="${this.utils.escapeHtml(img.src)}" data-alt="${this.utils.escapeHtml(img.alt)}"
                            title="Click to load preview"
                            style="display: inline-block; width: 40px; height: 40px; line-height: 40px; text-align: center; background: var(--bg-elevated); border-radius: 4px; border: 1px solid var(--border-standard); cursor: pointer; font-size: 14px; color: var(--text-muted);">
                            &#128247;
                        </span>
                    </td>
                    <td style="${tdBase} overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.utils.escapeHtml(img.filename)}">${this.utils.escapeHtml(img.filename)}</td>
                    <td style="${tdBase} overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${this.utils.escapeHtml(img.page)}">
                        <a href="${this.utils.escapeHtml(img.page)}" target="_blank" rel="noopener noreferrer" style="color: var(--status-info); text-decoration: none;">${this.utils.escapeHtml(shortPage)}</a>
                    </td>
                    <td style="${tdBase} word-break: break-word; white-space: normal; line-height: 1.4;">${altDisplay}</td>
                    <td style="${tdBase} text-align: center;">${this.utils.escapeHtml(String(img.width))}</td>
                    <td style="${tdBase} text-align: center;">${this.utils.escapeHtml(String(img.height))}</td>
                </tr>
            `;
        }).join('');

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt); margin-bottom: 24px;">
                <h3 style="font-size: 18px; font-weight: 600; color: var(--text-body); margin-bottom: 16px;">Images Table</h3>
                <div style="overflow-x: auto;">
                    <table id="img-table" class="data-table" style="width: 100%; border-collapse: collapse; table-layout: fixed;">
                        <colgroup>
                            <col style="width: 56px;" />
                            <col style="width: 25%;" />
                            <col style="width: 20%;" />
                            <col style="width: 30%;" />
                            <col style="width: 55px;" />
                            <col style="width: 55px;" />
                        </colgroup>
                        <thead>
                            <tr style="border-bottom: 1px solid var(--border-alt);">
                                <th style="${thBase}">Preview</th>
                                <th style="${thBase}" data-sort="filename">Image Name${arrow('filename')}</th>
                                <th style="${thBase}" data-sort="page">Page${arrow('page')}</th>
                                <th style="${thBase}" data-sort="alt">Alt Text${arrow('alt')}</th>
                                <th style="${thBase} text-align: center;" data-sort="width">W${arrow('width')}</th>
                                <th style="${thBase} text-align: center;" data-sort="height">H${arrow('height')}</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        `;
    },

    _sortImages(images) {
        return [...images].sort((a, b) => {
            let aVal = a[this.sortColumn];
            let bVal = b[this.sortColumn];
            if (typeof aVal === 'string') aVal = aVal.toLowerCase();
            if (typeof bVal === 'string') bVal = bVal.toLowerCase();
            // Numeric sort for width/height
            if (this.sortColumn === 'width' || this.sortColumn === 'height') {
                aVal = parseInt(aVal) || 0;
                bVal = parseInt(bVal) || 0;
            }
            if (this.sortDirection === 'asc') return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
            return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
        });
    },

    renderSEOSummary(images) {
        const arrow = this.seoSummaryOpen ? '\u25BC' : '\u25B6';

        if (!this.seoSummaryOpen) {
            return `
                <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt);">
                    <h3 id="img-seo-toggle" style="font-size: 18px; font-weight: 600; color: var(--text-body); cursor: pointer; user-select: none; margin: 0;">
                        ${arrow} SEO Summary
                    </h3>
                </div>
            `;
        }

        // Missing alt text
        const missingAlt = images.filter(img => !img.alt.trim());
        // Long alt text (> 80 chars)
        const longAlt = images.filter(img => img.alt.trim().length > 80);
        // Duplicate images (same src on multiple pages)
        const srcCounts = {};
        images.forEach(img => {
            if (!srcCounts[img.src]) srcCounts[img.src] = [];
            srcCounts[img.src].push(img.page);
        });
        const duplicates = Object.entries(srcCounts).filter(([, pages]) => {
            const unique = new Set(pages);
            return unique.size > 1;
        });

        return `
            <div style="background: var(--bg-elevated); padding: 24px; border-radius: 12px; border: 1px solid var(--border-alt);">
                <h3 id="img-seo-toggle" style="font-size: 18px; font-weight: 600; color: var(--text-body); cursor: pointer; user-select: none; margin: 0 0 20px 0;">
                    ${arrow} SEO Summary
                </h3>

                ${this._renderSEOIssueBlock('Missing Alt Text', missingAlt.length, 'var(--status-error)',
                    'Images without alt text hurt accessibility and SEO.',
                    missingAlt.length > 0
                        ? missingAlt.slice(0, 50).map(img => `
                            <div style="background: var(--bg-base); padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-alt); font-size: 13px; color: var(--text-secondary);">
                                <span style="color: var(--text-dim);">on</span> <span style="color: var(--status-info);">${this.utils.escapeHtml(this._shortPageUrl(img.page))}</span>
                                <span style="color: var(--text-dim); margin: 0 4px;">&rarr;</span>
                                <span>${this.utils.escapeHtml(img.filename)}</span>
                            </div>
                        `).join('')
                        + (missingAlt.length > 50 ? `<div style="color: var(--text-dim); font-size: 12px; padding: 8px 0;">...and ${missingAlt.length - 50} more</div>` : '')
                        : null
                )}

                ${this._renderSEOIssueBlock('Long Alt Text (>80 chars)', longAlt.length, 'var(--status-warning)',
                    'Alt text over 80 characters may be truncated by search engines.',
                    longAlt.length > 0
                        ? longAlt.slice(0, 30).map(img => `
                            <div style="background: var(--bg-base); padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-alt); font-size: 13px; color: var(--text-secondary);">
                                <div style="margin-bottom: 4px;">
                                    <span style="color: var(--status-warning); font-weight: 600;">${this.utils.escapeHtml(img.filename)}</span>
                                    <span style="color: var(--text-dim); margin-left: 6px;">(${img.alt.trim().length} chars)</span>
                                </div>
                                <div style="color: var(--text-muted); font-size: 12px; word-break: break-word;">${this.utils.escapeHtml(img.alt)}</div>
                            </div>
                        `).join('')
                        : null
                )}

                ${this._renderSEOIssueBlock('Duplicate Images', duplicates.length, 'var(--accent-2)',
                    'Same image found on multiple pages.',
                    duplicates.length > 0
                        ? duplicates.slice(0, 20).map(([src, pages]) => {
                            const uniquePages = [...new Set(pages)];
                            const filename = this._extractFilename(src);
                            return `
                                <div style="background: var(--bg-base); padding: 10px 14px; border-radius: 6px; border: 1px solid var(--border-alt); font-size: 13px; color: var(--text-secondary);">
                                    <div style="font-weight: 600; margin-bottom: 6px;">
                                        ${this.utils.escapeHtml(filename)}
                                        <span style="color: var(--text-dim); font-weight: 400; margin-left: 6px;">(${uniquePages.length} pages)</span>
                                    </div>
                                    ${uniquePages.slice(0, 5).map(p => `
                                        <div style="color: var(--text-muted); font-size: 12px; padding: 2px 0;">${this.utils.escapeHtml(this._shortPageUrl(p))}</div>
                                    `).join('')}
                                    ${uniquePages.length > 5 ? `<div style="color: var(--border-standard); font-size: 12px; padding: 2px 0;">...and ${uniquePages.length - 5} more</div>` : ''}
                                </div>
                            `;
                        }).join('')
                        : null
                )}
            </div>
        `;
    },

    _renderSEOIssueBlock(title, count, color, description, itemsHtml) {
        const statusText = count === 0
            ? '<span style="color: var(--status-success); font-size: 13px;">No issues found.</span>'
            : '';

        return `
            <div style="margin-bottom: 24px;">
                <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                    <span style="font-size: 15px; font-weight: 600; color: var(--text-body);">${title}</span>
                    <span style="background: ${color}22; color: ${color}; padding: 3px 12px; border-radius: 12px; font-size: 12px; font-weight: 600;">${count}</span>
                </div>
                <p style="color: var(--text-muted); font-size: 13px; margin: 0 0 12px 0;">${description}</p>
                ${itemsHtml
                    ? `<div style="display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; padding-right: 4px;">${itemsHtml}</div>`
                    : statusText
                }
            </div>
        `;
    },

    bindEvents(container) {
        const self = this;

        // Table sorting
        const table = container.querySelector('#img-table');
        if (table) {
            table.querySelectorAll('th[data-sort]').forEach(th => {
                th.addEventListener('click', () => {
                    const col = th.dataset.sort;
                    if (self.sortColumn === col) {
                        self.sortDirection = self.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        self.sortColumn = col;
                        self.sortDirection = 'asc';
                    }
                    self.render(self.container);
                });
            });
        }

        // SEO summary toggle
        const seoToggle = container.querySelector('#img-seo-toggle');
        if (seoToggle) {
            seoToggle.addEventListener('click', () => {
                self.seoSummaryOpen = !self.seoSummaryOpen;
                self.render(self.container);
            });
        }

        // Export CSV
        const csvBtn = container.querySelector('#img-export-csv');
        if (csvBtn) {
            csvBtn.addEventListener('click', () => self.exportCSV());
        }

        // Preview placeholders — load image on click
        container.querySelectorAll('.img-preview-placeholder').forEach(placeholder => {
            placeholder.addEventListener('click', () => {
                const src = placeholder.dataset.src;
                const alt = placeholder.dataset.alt;
                const img = document.createElement('img');
                img.src = src;
                img.alt = alt;
                img.style.cssText = 'width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border-alt); background: var(--bg-base); cursor: pointer;';
                img.onerror = () => { img.style.display = 'none'; placeholder.textContent = '?'; placeholder.style.display = 'inline-block'; };
                img.addEventListener('click', () => window.open(src, '_blank'));
                placeholder.replaceWith(img);
            });
        });

        // Filter buttons
        container.querySelectorAll('.img-filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                self.activeFilter = btn.dataset.imgFilter;
                self.render(self.container);
            });
        });
    },

    exportCSV() {
        if (!this.imagesData || this.imagesData.length === 0) return;
        const headers = ['Image Name', 'Source URL', 'Page URL', 'Alt Text', 'Width', 'Height'];
        const rows = this.imagesData.map(img => [
            img.filename,
            img.src,
            img.page,
            img.alt,
            img.width,
            img.height
        ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

        const csv = [headers.join(','), ...rows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `images-seo-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        this.utils.showNotification('CSV exported', 'success');
    },

    renderEmptyState() {
        return `
            <div style="padding: 20px; overflow-y: auto; max-height: calc(100vh - 280px);">
                <div style="text-align: center; padding: 60px 20px;">
                    <div style="font-size: 64px; margin-bottom: 20px;">\uD83D\uDDBC\uFE0F</div>
                    <h3 style="font-size: 24px; font-weight: 600; color: var(--text-body); margin-bottom: 12px;">
                        No Images Found
                    </h3>
                    <p style="color: var(--text-muted); font-size: 14px;">
                        Start a crawl to discover and analyze images from the target site
                    </p>
                </div>
            </div>
        `;
    }
});

console.log('\u2705 SEO Images plugin registered');
