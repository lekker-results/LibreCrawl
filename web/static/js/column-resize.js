/**
 * Column Resizing for Tables
 * Allows users to drag column borders to resize
 * Persists column widths to localStorage
 */

class ColumnResizer {
    constructor(table) {
        this.table = table;
        this.tableId = table.id || '';
        this.activeGrip = null;
        this.activeColumn = null;
        this.activeColumnIndex = -1;
        this.startX = 0;
        this.startWidth = 0;

        this.restoreWidths();
        this.initializeResizers();
    }

    getStorageKey() {
        return `lc_col_widths_${this.tableId}`;
    }

    saveWidths() {
        if (!this.tableId) return;
        const headerCells = this.table.querySelectorAll('thead th');
        const widths = {};
        headerCells.forEach((th, index) => {
            if (th.style.width) {
                widths[index] = parseInt(th.style.width, 10);
            }
        });
        if (Object.keys(widths).length > 0) {
            localStorage.setItem(this.getStorageKey(), JSON.stringify(widths));
        }
    }

    restoreWidths() {
        if (!this.tableId) return;
        try {
            const saved = localStorage.getItem(this.getStorageKey());
            if (!saved) return;
            const widths = JSON.parse(saved);
            const headerCells = this.table.querySelectorAll('thead th');
            for (const [index, width] of Object.entries(widths)) {
                const th = headerCells[parseInt(index, 10)];
                if (th) {
                    th.style.width = width + 'px';
                    th.style.minWidth = width + 'px';
                    th.style.maxWidth = width + 'px';
                }
            }
        } catch (e) {
            // Ignore corrupt data
        }
    }

    initializeResizers() {
        const headerCells = this.table.querySelectorAll('thead th');

        headerCells.forEach((th, index) => {
            // Don't add resizer to last column
            if (index === headerCells.length - 1) return;

            // Make the header cell positioned
            th.style.position = 'relative';

            // Create resize grip
            const grip = document.createElement('div');
            grip.className = 'column-resize-grip';
            grip.style.cssText = `
                position: absolute;
                top: 0;
                right: -4px;
                width: 8px;
                height: 100%;
                cursor: col-resize;
                z-index: 100;
                user-select: none;
                background: transparent;
            `;

            // Add hover indicator
            grip.addEventListener('mouseenter', () => {
                grip.style.background = 'rgba(139, 92, 246, 0.2)';
            });

            grip.addEventListener('mouseleave', () => {
                if (this.activeGrip !== grip) {
                    grip.style.background = 'transparent';
                }
            });

            // Mouse events for dragging
            grip.addEventListener('mousedown', (e) => this.onMouseDown(e, th, grip, index));

            th.appendChild(grip);
        });

        // Global mouse events
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('mouseup', () => this.onMouseUp());
    }

    onMouseDown(e, th, grip, index) {
        e.preventDefault();
        e.stopPropagation();

        this.activeGrip = grip;
        this.activeColumn = th;
        this.activeColumnIndex = index;
        this.startX = e.pageX;
        this.startWidth = th.offsetWidth;

        grip.style.background = 'rgba(139, 92, 246, 0.5)';
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }

    onMouseMove(e) {
        if (!this.activeColumn) return;

        const diff = e.pageX - this.startX;
        const newWidth = Math.max(50, this.startWidth + diff); // Min width 50px

        this.activeColumn.style.width = newWidth + 'px';
        this.activeColumn.style.minWidth = newWidth + 'px';
        this.activeColumn.style.maxWidth = newWidth + 'px';
    }

    onMouseUp() {
        if (this.activeGrip) {
            this.activeGrip.style.background = 'transparent';
            // Save widths when user finishes resizing
            this.saveWidths();
        }

        this.activeGrip = null;
        this.activeColumn = null;
        this.activeColumnIndex = -1;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }
}

// Initialize column resizers for all tables when DOM is ready
function initializeColumnResizers() {
    const tables = document.querySelectorAll('.data-table');
    tables.forEach(table => {
        new ColumnResizer(table);
    });
}

// Export for use in app.js
window.ColumnResizer = ColumnResizer;
window.initializeColumnResizers = initializeColumnResizers;
