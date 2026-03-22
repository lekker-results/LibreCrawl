"""
Crawl data persistence module
Handles database operations for storing and retrieving crawl data
Enables crash recovery and historical crawl access
"""
import json
import time
from datetime import datetime

from src.db import (
    get_db, get_cursor, get_last_id, returning_id,
    ph, serial_pk, now_minus_interval_param,
    upsert_conflict, insert_or_ignore, on_conflict_ignore,
    table_columns, get_database_size_mb as _get_database_size_mb,
    DB_TYPE
)


def init_crawl_tables():
    """Initialize crawl persistence tables"""
    with get_db() as conn:
        cursor = get_cursor(conn)

        # Main crawls table
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawls (
                id {serial_pk()},
                user_id INTEGER,
                session_id TEXT NOT NULL,
                base_url TEXT NOT NULL,
                base_domain TEXT,
                status TEXT DEFAULT 'running',

                config_snapshot TEXT,

                urls_discovered INTEGER DEFAULT 0,
                urls_crawled INTEGER DEFAULT 0,
                max_depth_reached INTEGER DEFAULT 0,

                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                last_saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                peak_memory_mb REAL,
                estimated_size_mb REAL,

                can_resume BOOLEAN DEFAULT TRUE,
                resume_checkpoint TEXT,

                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        ''')

        # Crawled URLs table
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawled_urls (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,
                url TEXT NOT NULL,

                status_code INTEGER,
                content_type TEXT,
                size INTEGER,
                is_internal BOOLEAN,
                depth INTEGER,

                title TEXT,
                meta_description TEXT,
                h1 TEXT,
                h2 TEXT,
                h3 TEXT,
                word_count INTEGER,

                canonical_url TEXT,
                lang TEXT,
                charset TEXT,
                viewport TEXT,
                robots TEXT,

                meta_tags TEXT,
                og_tags TEXT,
                twitter_tags TEXT,
                json_ld TEXT,
                analytics TEXT,
                images TEXT,
                hreflang TEXT,
                schema_org TEXT,
                redirects TEXT,
                linked_from TEXT,

                external_links INTEGER,
                internal_links INTEGER,

                response_time REAL,
                javascript_rendered BOOLEAN DEFAULT FALSE,

                crawled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE
            )
        ''')

        # Add unique constraint on (crawl_id, url) to prevent duplicate URLs per crawl
        if DB_TYPE == 'postgres':
            # Use savepoint so a failure doesn't abort the whole transaction
            cursor.execute('SAVEPOINT idx_unique_check')
            try:
                cursor.execute('''
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_crawled_urls_unique
                    ON crawled_urls(crawl_id, url)
                ''')
                cursor.execute('RELEASE SAVEPOINT idx_unique_check')
            except Exception:
                cursor.execute('ROLLBACK TO SAVEPOINT idx_unique_check')
                print("Cleaning up duplicate URLs in crawled_urls...")
                cursor.execute('''
                    DELETE FROM crawled_urls WHERE id NOT IN (
                        SELECT MAX(id) FROM crawled_urls GROUP BY crawl_id, url
                    )
                ''')
                deleted = cursor.rowcount
                print(f"Removed {deleted} duplicate URL entries")
                cursor.execute('''
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_crawled_urls_unique
                    ON crawled_urls(crawl_id, url)
                ''')
        else:
            try:
                cursor.execute('''
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_crawled_urls_unique
                    ON crawled_urls(crawl_id, url)
                ''')
            except Exception:
                print("Cleaning up duplicate URLs in crawled_urls...")
                cursor.execute('''
                    DELETE FROM crawled_urls WHERE id NOT IN (
                        SELECT MAX(id) FROM crawled_urls GROUP BY crawl_id, url
                    )
                ''')
                deleted = cursor.rowcount
                print(f"Removed {deleted} duplicate URL entries")
                conn.commit()
                cursor.execute('''
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_crawled_urls_unique
                    ON crawled_urls(crawl_id, url)
                ''')

        # Links table
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_links (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,

                source_url TEXT NOT NULL,
                target_url TEXT NOT NULL,
                anchor_text TEXT,

                is_internal BOOLEAN,
                target_domain TEXT,
                target_status INTEGER,
                placement TEXT,

                discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE
            )
        ''')

        # Issues table
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_issues (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,

                url TEXT NOT NULL,
                type TEXT,
                category TEXT,
                issue TEXT,
                details TEXT,

                detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE
            )
        ''')

        # Queue table for crash recovery
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_queue (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,

                url TEXT NOT NULL,
                depth INTEGER,
                priority INTEGER DEFAULT 0,

                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE,
                UNIQUE(crawl_id, url)
            )
        ''')

        # AI keyword analysis results
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_ai_keywords (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,
                scope TEXT NOT NULL DEFAULT 'site',
                page_url TEXT,

                keyword TEXT NOT NULL,
                score REAL,
                category TEXT,
                relevance TEXT,
                rank INTEGER,

                provider TEXT,
                model TEXT,
                analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE
            )
        ''')

        # Create indexes for performance
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawls_user_status ON crawls(user_id, status)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawls_session ON crawls(session_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawled_urls_crawl ON crawled_urls(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawled_urls_url ON crawled_urls(crawl_id, url)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawled_urls_status ON crawled_urls(crawl_id, status_code)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_links_crawl ON crawl_links(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_links_source ON crawl_links(crawl_id, source_url)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_links_target ON crawl_links(crawl_id, target_url)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_issues_crawl ON crawl_issues(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_issues_url ON crawl_issues(crawl_id, url)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_issues_category ON crawl_issues(crawl_id, category)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_queue_crawl ON crawl_queue(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_ai_keywords_crawl ON crawl_ai_keywords(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_crawl_ai_keywords_scope ON crawl_ai_keywords(crawl_id, scope)')

        # GBP (Google Business Profile) cache table — keyed by domain, not crawl
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_gbp_data (
                id {serial_pk()},
                domain TEXT NOT NULL UNIQUE,
                data_json TEXT NOT NULL,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Migration: if old crawl_id-keyed schema is present, migrate to domain-keyed
        cols = table_columns(conn, 'crawl_gbp_data')
        if 'crawl_id' in cols and 'domain' not in cols:
            migrate_cursor = get_cursor(conn)
            migrate_cursor.execute('''
                SELECT c.base_domain AS domain, g.data_json, MAX(g.fetched_at) AS fetched_at
                FROM crawl_gbp_data g
                JOIN crawls c ON g.crawl_id = c.id
                WHERE c.base_domain IS NOT NULL AND c.base_domain != ''
                GROUP BY c.base_domain
            ''')
            rows = migrate_cursor.fetchall()
            migrate_cursor.execute('DROP TABLE crawl_gbp_data')
            migrate_cursor.execute(f'''
                CREATE TABLE crawl_gbp_data (
                    id {serial_pk()},
                    domain TEXT NOT NULL UNIQUE,
                    data_json TEXT NOT NULL,
                    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            for row in rows:
                _prefix = insert_or_ignore()
                _suffix = on_conflict_ignore()
                migrate_cursor.execute(
                    f'{_prefix} crawl_gbp_data (domain, data_json, fetched_at) VALUES ({ph(3)}) {_suffix}',
                    (row['domain'], row['data_json'], row['fetched_at'])
                )
            print(f"[GBP] Migrated {len(rows)} domain-level cache records")

        # SEO Audit results — stores AI-generated audit data linked to a crawl
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_audit_results (
                id {serial_pk()},
                crawl_id INTEGER NOT NULL,
                domain TEXT NOT NULL,
                client_name TEXT,

                total_pages INTEGER DEFAULT 0,
                total_checks INTEGER DEFAULT 0,
                checks_passed INTEGER DEFAULT 0,
                checks_failed INTEGER DEFAULT 0,
                critical_count INTEGER DEFAULT 0,
                warning_count INTEGER DEFAULT 0,
                info_count INTEGER DEFAULT 0,
                overall_score_percent INTEGER DEFAULT 0,

                business_context TEXT,
                audit_data TEXT NOT NULL,

                version INTEGER DEFAULT 1,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE CASCADE
            )
        ''')

        # SEO Audit progress — server-side checkbox state
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_audit_progress (
                id {serial_pk()},
                audit_id INTEGER NOT NULL UNIQUE,
                progress_data TEXT NOT NULL DEFAULT '{json.dumps({})}',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (audit_id) REFERENCES crawl_audit_results(id) ON DELETE CASCADE
            )
        ''')

        # Off-page SEO results — stores off-page audit data by domain
        cursor.execute(f'''
            CREATE TABLE IF NOT EXISTS crawl_offpage_results (
                id {serial_pk()},
                domain TEXT NOT NULL,
                crawl_id INTEGER,
                category TEXT NOT NULL,
                data_json TEXT NOT NULL,
                version INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (crawl_id) REFERENCES crawls(id) ON DELETE SET NULL
            )
        ''')

        # Indexes for audit tables
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_results_crawl ON crawl_audit_results(crawl_id)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_audit_results_domain ON crawl_audit_results(domain)')
        cursor.execute('CREATE INDEX IF NOT EXISTS idx_offpage_results_domain ON crawl_offpage_results(domain)')

        print("Crawl persistence tables initialized successfully")

def create_crawl(user_id, session_id, base_url, base_domain, config_snapshot):
    """
    Create a new crawl record
    Returns the crawl_id
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'''
                INSERT INTO crawls (user_id, session_id, base_url, base_domain, config_snapshot, status)
                VALUES ({ph(5)}, 'running'){returning_id()}
            ''', (user_id, session_id, base_url, base_domain, json.dumps(config_snapshot)))

            crawl_id = get_last_id(cursor)
            print(f"Created new crawl record: ID={crawl_id}, URL={base_url}")
            return crawl_id
    except Exception as e:
        print(f"Error creating crawl: {e}")
        return None

def update_crawl_stats(crawl_id, discovered=None, crawled=None, max_depth=None, peak_memory_mb=None, estimated_size_mb=None):
    """Update crawl statistics"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            updates = []
            params = []

            _p = '%s' if DB_TYPE == 'postgres' else '?'

            if discovered is not None:
                updates.append(f"urls_discovered = {_p}")
                params.append(discovered)
            if crawled is not None:
                updates.append(f"urls_crawled = {_p}")
                params.append(crawled)
            if max_depth is not None:
                updates.append(f"max_depth_reached = {_p}")
                params.append(max_depth)
            if peak_memory_mb is not None:
                updates.append(f"peak_memory_mb = {_p}")
                params.append(peak_memory_mb)
            if estimated_size_mb is not None:
                updates.append(f"estimated_size_mb = {_p}")
                params.append(estimated_size_mb)

            updates.append("last_saved_at = CURRENT_TIMESTAMP")
            params.append(crawl_id)

            query = f"UPDATE crawls SET {', '.join(updates)} WHERE id = {_p}"
            cursor.execute(query, params)

            return True
    except Exception as e:
        print(f"Error updating crawl stats: {e}")
        return False

def save_url_batch(crawl_id, urls):
    """
    Batch save crawled URLs
    urls: list of URL result dictionaries from crawler
    """
    if not urls:
        return True

    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            # Prepare batch insert
            cols = (
                'crawl_id, url, status_code, content_type, size, is_internal, depth, '
                'title, meta_description, h1, h2, h3, word_count, '
                'canonical_url, lang, charset, viewport, robots, '
                'meta_tags, og_tags, twitter_tags, json_ld, analytics, images, '
                'hreflang, schema_org, redirects, linked_from, '
                'external_links, internal_links, response_time, javascript_rendered'
            )
            placeholders = ph(32)

            # Build the upsert query
            update_cols = [
                'status_code', 'content_type', 'size', 'is_internal', 'depth',
                'title', 'meta_description', 'h1', 'h2', 'h3', 'word_count',
                'canonical_url', 'lang', 'charset', 'viewport', 'robots',
                'meta_tags', 'og_tags', 'twitter_tags', 'json_ld', 'analytics', 'images',
                'hreflang', 'schema_org', 'redirects', 'linked_from',
                'external_links', 'internal_links', 'response_time', 'javascript_rendered'
            ]
            conflict_clause = upsert_conflict(['crawl_id', 'url'], update_cols)

            query = f'''
                INSERT INTO crawled_urls ({cols})
                VALUES ({placeholders})
                {conflict_clause}
            '''

            for url_data in urls:
                row = (
                    crawl_id,
                    url_data.get('url'),
                    url_data.get('status_code'),
                    url_data.get('content_type'),
                    url_data.get('size'),
                    url_data.get('is_internal'),
                    url_data.get('depth'),
                    url_data.get('title'),
                    url_data.get('meta_description'),
                    url_data.get('h1'),
                    json.dumps(url_data.get('h2', [])),
                    json.dumps(url_data.get('h3', [])),
                    url_data.get('word_count'),
                    url_data.get('canonical_url'),
                    url_data.get('lang'),
                    url_data.get('charset'),
                    url_data.get('viewport'),
                    url_data.get('robots'),
                    json.dumps(url_data.get('meta_tags', {})),
                    json.dumps(url_data.get('og_tags', {})),
                    json.dumps(url_data.get('twitter_tags', {})),
                    json.dumps(url_data.get('json_ld', [])),
                    json.dumps(url_data.get('analytics', {})),
                    json.dumps(url_data.get('images', [])),
                    json.dumps(url_data.get('hreflang', [])),
                    json.dumps(url_data.get('schema_org', [])),
                    json.dumps(url_data.get('redirects', [])),
                    json.dumps(url_data.get('linked_from', [])),
                    url_data.get('external_links'),
                    url_data.get('internal_links'),
                    url_data.get('response_time'),
                    url_data.get('javascript_rendered', False)
                )
                cursor.execute(query, row)

            print(f"Saved {len(urls)} URLs to database for crawl {crawl_id}")
            return True

    except Exception as e:
        print(f"Error saving URL batch: {e}")
        import traceback
        traceback.print_exc()
        return False

def save_links_batch(crawl_id, links):
    """Batch save links"""
    if not links:
        return True

    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            query = f'''
                INSERT INTO crawl_links (
                    crawl_id, source_url, target_url, anchor_text,
                    is_internal, target_domain, target_status, placement
                ) VALUES ({ph(8)})
            '''

            for link in links:
                row = (
                    crawl_id,
                    link.get('source_url'),
                    link.get('target_url'),
                    link.get('anchor_text'),
                    link.get('is_internal'),
                    link.get('target_domain'),
                    link.get('target_status'),
                    link.get('placement', 'body')
                )
                cursor.execute(query, row)

            print(f"Saved {len(links)} links to database for crawl {crawl_id}")
            return True

    except Exception as e:
        print(f"Error saving links batch: {e}")
        return False

def save_issues_batch(crawl_id, issues):
    """Batch save SEO issues"""
    if not issues:
        return True

    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            query = f'''
                INSERT INTO crawl_issues (
                    crawl_id, url, type, category, issue, details
                ) VALUES ({ph(6)})
            '''

            for issue in issues:
                row = (
                    crawl_id,
                    issue.get('url'),
                    issue.get('type'),
                    issue.get('category'),
                    issue.get('issue'),
                    issue.get('details')
                )
                cursor.execute(query, row)

            print(f"Saved {len(issues)} issues to database for crawl {crawl_id}")
            return True

    except Exception as e:
        print(f"Error saving issues batch: {e}")
        return False

def save_checkpoint(crawl_id, checkpoint_data):
    """Save queue checkpoint for crash recovery"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'''
                UPDATE crawls
                SET resume_checkpoint = {ph()}, last_saved_at = CURRENT_TIMESTAMP
                WHERE id = {ph()}
            ''', (json.dumps(checkpoint_data), crawl_id))

            return True
    except Exception as e:
        print(f"Error saving checkpoint: {e}")
        return False

def set_crawl_status(crawl_id, status):
    """
    Update crawl status
    status: 'running', 'paused', 'completed', 'failed', 'stopped', 'archived'
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            if status in ['completed', 'failed', 'stopped']:
                cursor.execute(f'''
                    UPDATE crawls
                    SET status = {ph()}, completed_at = CURRENT_TIMESTAMP
                    WHERE id = {ph()}
                ''', (status, crawl_id))
            else:
                cursor.execute(f'''
                    UPDATE crawls
                    SET status = {ph()}
                    WHERE id = {ph()}
                ''', (status, crawl_id))

            print(f"Updated crawl {crawl_id} status to: {status}")
            return True

    except Exception as e:
        print(f"Error setting crawl status: {e}")
        return False

def get_crawl_by_id(crawl_id):
    """Get crawl metadata by ID"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'''
                SELECT * FROM crawls WHERE id = {ph()}
            ''', (crawl_id,))

            row = cursor.fetchone()
            if row:
                crawl = dict(row)
                # Parse JSON fields
                if crawl.get('config_snapshot'):
                    crawl['config_snapshot'] = json.loads(crawl['config_snapshot'])
                if crawl.get('resume_checkpoint'):
                    crawl['resume_checkpoint'] = json.loads(crawl['resume_checkpoint'])
                return crawl
            return None

    except Exception as e:
        print(f"Error fetching crawl: {e}")
        return None

def get_user_crawls(user_id, limit=50, offset=0, status_filter=None):
    """Get all crawls for a user"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            _p = '%s' if DB_TYPE == 'postgres' else '?'
            query = f'SELECT * FROM crawls WHERE user_id = {_p}'
            params = [user_id]

            if status_filter:
                query += f' AND status = {_p}'
                params.append(status_filter)

            query += f' ORDER BY started_at DESC LIMIT {_p} OFFSET {_p}'
            params.extend([limit, offset])

            cursor.execute(query, params)

            crawls = []
            for row in cursor.fetchall():
                crawl = dict(row)
                # Don't parse full config for list view
                crawl['config_snapshot'] = None  # Save bandwidth
                crawls.append(crawl)

            return crawls

    except Exception as e:
        print(f"Error fetching user crawls: {e}")
        return []

def load_crawled_urls(crawl_id, limit=None, offset=0):
    """Load all crawled URLs for a crawl"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            _p = '%s' if DB_TYPE == 'postgres' else '?'
            query = f'SELECT * FROM crawled_urls WHERE crawl_id = {_p} ORDER BY crawled_at'
            params = [crawl_id]

            if limit:
                query += f' LIMIT {_p} OFFSET {_p}'
                params.extend([limit, offset])

            cursor.execute(query, params)

            urls = []
            for row in cursor.fetchall():
                url_data = dict(row)
                # Parse JSON fields
                for field in ['h2', 'h3', 'meta_tags', 'og_tags', 'twitter_tags',
                             'json_ld', 'analytics', 'images', 'hreflang',
                             'schema_org', 'redirects', 'linked_from']:
                    if url_data.get(field):
                        try:
                            url_data[field] = json.loads(url_data[field])
                        except:
                            url_data[field] = []

                urls.append(url_data)

            return urls

    except Exception as e:
        print(f"Error loading crawled URLs: {e}")
        return []

def load_crawl_links(crawl_id, limit=None, offset=0):
    """Load all links for a crawl"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            _p = '%s' if DB_TYPE == 'postgres' else '?'
            query = f'SELECT * FROM crawl_links WHERE crawl_id = {_p}'
            params = [crawl_id]

            if limit:
                query += f' LIMIT {_p} OFFSET {_p}'
                params.extend([limit, offset])

            cursor.execute(query, params)

            return [dict(row) for row in cursor.fetchall()]

    except Exception as e:
        print(f"Error loading links: {e}")
        return []

def load_crawl_issues(crawl_id, limit=None, offset=0):
    """Load all issues for a crawl"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            _p = '%s' if DB_TYPE == 'postgres' else '?'
            query = f'SELECT * FROM crawl_issues WHERE crawl_id = {_p}'
            params = [crawl_id]

            if limit:
                query += f' LIMIT {_p} OFFSET {_p}'
                params.extend([limit, offset])

            cursor.execute(query, params)

            return [dict(row) for row in cursor.fetchall()]

    except Exception as e:
        print(f"Error loading issues: {e}")
        return []

def get_resume_data(crawl_id):
    """Get all data needed to resume a crawl"""
    crawl = get_crawl_by_id(crawl_id)
    if not crawl:
        return None

    # Only allow resume for paused/failed/running crawls
    if crawl['status'] not in ['paused', 'failed', 'running']:
        return None

    return crawl

def delete_crawl(crawl_id):
    """Delete a crawl and all associated data (CASCADE handles related tables)"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'DELETE FROM crawls WHERE id = {ph()}', (crawl_id,))
            print(f"Deleted crawl {crawl_id} and all associated data")
            return True
    except Exception as e:
        print(f"Error deleting crawl: {e}")
        return False

def get_crashed_crawls():
    """Find crawls that were running when server crashed"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute('''
                SELECT * FROM crawls
                WHERE status = 'running'
                ORDER BY started_at DESC
            ''')

            crawls = []
            for row in cursor.fetchall():
                crawl = dict(row)
                crawls.append(crawl)

            return crawls

    except Exception as e:
        print(f"Error finding crashed crawls: {e}")
        return []

def cleanup_old_crawls(days=90):
    """Delete crawls older than specified days (optional maintenance)"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'''
                DELETE FROM crawls
                WHERE started_at < {now_minus_interval_param('days')}
                AND status IN ('completed', 'failed', 'stopped')
            ''', (days,))

            deleted = cursor.rowcount
            print(f"Cleaned up {deleted} old crawls")
            return deleted

    except Exception as e:
        print(f"Error cleaning up old crawls: {e}")
        return 0

def find_recent_crawl_by_domain(base_domain, max_age_hours=24):
    """Find the most recent completed crawl for a domain within max_age_hours.
    Returns (crawl_dict, total_crawl_count) or (None, 0)."""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            # Count all completed crawls for this domain
            cursor.execute(f'''
                SELECT COUNT(*) as count FROM crawls
                WHERE base_domain = {ph()} AND status = 'completed'
            ''', (base_domain,))
            total_count = cursor.fetchone()['count']

            # Get most recent within age limit
            cursor.execute(f'''
                SELECT * FROM crawls
                WHERE base_domain = {ph()}
                  AND status = 'completed'
                  AND completed_at >= {now_minus_interval_param('hours')}
                ORDER BY completed_at DESC
                LIMIT 1
            ''', (base_domain, max_age_hours))

            row = cursor.fetchone()
            if row:
                crawl = dict(row)
                if crawl.get('config_snapshot'):
                    crawl['config_snapshot'] = json.loads(crawl['config_snapshot'])
                return crawl, total_count
            return None, total_count
    except Exception as e:
        print(f"Error finding crawl by domain: {e}")
        return None, 0


def get_crawl_count(user_id):
    """Get total number of crawls for a user"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'SELECT COUNT(*) as count FROM crawls WHERE user_id = {ph()}', (user_id,))
            result = cursor.fetchone()
            return result['count'] if result else 0
    except Exception as e:
        print(f"Error getting crawl count: {e}")
        return 0

def save_ai_keywords(crawl_id, keywords, provider, model, scope='site', page_url=None):
    """Save AI-analyzed keywords for a crawl (site-wide or per-page)"""
    if not keywords:
        return True

    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            # Clear previous results for this scope/page
            if scope == 'page' and page_url:
                cursor.execute(
                    f'DELETE FROM crawl_ai_keywords WHERE crawl_id = {ph()} AND scope = {ph()} AND page_url = {ph()}',
                    (crawl_id, scope, page_url)
                )
            elif scope == 'site':
                cursor.execute(
                    f'DELETE FROM crawl_ai_keywords WHERE crawl_id = {ph()} AND scope = {ph()}',
                    (crawl_id, scope)
                )

            query = f'''
                INSERT INTO crawl_ai_keywords (
                    crawl_id, scope, page_url, keyword, score, category, relevance, rank, provider, model
                ) VALUES ({ph(10)})
            '''

            for kw in keywords:
                row = (
                    crawl_id, scope, page_url,
                    kw.get('keyword', ''),
                    kw.get('score', 0),
                    kw.get('category', ''),
                    kw.get('relevance', ''),
                    kw.get('rank', 0),
                    provider, model
                )
                cursor.execute(query, row)

            print(f"Saved {len(keywords)} AI keywords for crawl {crawl_id} (scope={scope})")
            return True
    except Exception as e:
        print(f"Error saving AI keywords: {e}")
        return False


def load_ai_keywords(crawl_id, scope='site', page_url=None):
    """Load AI-analyzed keywords for a crawl"""
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            if scope == 'page' and page_url:
                cursor.execute(
                    f'SELECT * FROM crawl_ai_keywords WHERE crawl_id = {ph()} AND scope = {ph()} AND page_url = {ph()} ORDER BY rank',
                    (crawl_id, scope, page_url)
                )
            elif scope == 'site':
                cursor.execute(
                    f'SELECT * FROM crawl_ai_keywords WHERE crawl_id = {ph()} AND scope = {ph()} ORDER BY rank',
                    (crawl_id, scope)
                )
            else:
                cursor.execute(
                    f'SELECT * FROM crawl_ai_keywords WHERE crawl_id = {ph()} ORDER BY scope, rank',
                    (crawl_id,)
                )

            return [dict(row) for row in cursor.fetchall()]
    except Exception as e:
        print(f"Error loading AI keywords: {e}")
        return []


def save_gbp_data(domain, report):
    """Cache GBP report keyed by domain (one record per domain, upserted)."""
    if not domain:
        return False
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(f'''
                INSERT INTO crawl_gbp_data (domain, data_json, fetched_at)
                VALUES ({ph(2)}, CURRENT_TIMESTAMP)
                ON CONFLICT(domain) DO UPDATE SET
                    data_json = excluded.data_json,
                    fetched_at = CURRENT_TIMESTAMP
            ''', (domain, json.dumps(report)))
        return True
    except Exception as e:
        print(f"Error saving GBP data: {e}")
        return False


def load_gbp_data(domain):
    """Load cached GBP report for a domain. Returns dict or None."""
    if not domain:
        return None
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)
            cursor.execute(
                f'SELECT data_json, fetched_at FROM crawl_gbp_data WHERE domain = {ph()}',
                (domain,)
            )
            row = cursor.fetchone()
            if row:
                data = json.loads(row['data_json'])
                data['_fetched_at'] = row['fetched_at']
                return data
        return None
    except Exception as e:
        print(f"Error loading GBP data: {e}")
        return None


def get_database_size_mb():
    """Get total database size in MB"""
    return _get_database_size_mb()


# ── SEO Audit Results ──────────────────────────────────────────────

def save_audit_result(crawl_id, domain, client_name, business_context, audit_data, summary):
    """
    Save an AI-generated SEO audit result linked to a crawl.
    Deletes any previous results for this domain first (progress cascade-deletes).
    Returns the audit_id or None on error.
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            # Delete previous audit results for this domain (progress rows cascade-delete)
            cursor.execute(
                f'DELETE FROM crawl_audit_results WHERE domain = {ph()}',
                (domain,)
            )

            cursor.execute(f'''
                INSERT INTO crawl_audit_results (
                    crawl_id, domain, client_name,
                    total_pages, total_checks, checks_passed, checks_failed,
                    critical_count, warning_count, info_count, overall_score_percent,
                    business_context, audit_data, version
                ) VALUES ({ph(14)}){returning_id()}
            ''', (
                crawl_id, domain, client_name,
                summary.get('total_pages', 0),
                summary.get('total_checks', 0),
                summary.get('checks_passed', 0),
                summary.get('checks_failed', 0),
                summary.get('critical_count', 0),
                summary.get('warning_count', 0),
                summary.get('info_count', 0),
                summary.get('overall_score_percent', 0),
                json.dumps(business_context) if isinstance(business_context, dict) else business_context,
                json.dumps(audit_data) if isinstance(audit_data, dict) else audit_data,
                1
            ))

            audit_id = get_last_id(cursor)

            # Create empty progress row
            cursor.execute(f'''
                INSERT INTO crawl_audit_progress (audit_id, progress_data)
                VALUES ({ph(2)})
            ''', (audit_id, json.dumps({})))

            print(f"Saved audit result for crawl {crawl_id} (audit_id={audit_id}, version={next_version})")
            return audit_id

    except Exception as e:
        print(f"Error saving audit result: {e}")
        import traceback
        traceback.print_exc()
        return None


def get_audit_result(crawl_id, version=None):
    """
    Get audit result for a crawl. Returns latest version by default.
    Includes progress data. Returns dict or None.
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            if version:
                cursor.execute(f'''
                    SELECT * FROM crawl_audit_results
                    WHERE crawl_id = {ph()} AND version = {ph()}
                ''', (crawl_id, version))
            else:
                cursor.execute(f'''
                    SELECT * FROM crawl_audit_results
                    WHERE crawl_id = {ph()}
                    ORDER BY version DESC LIMIT 1
                ''', (crawl_id,))

            row = cursor.fetchone()
            if not row:
                return None

            audit = dict(row)
            audit['audit_data'] = json.loads(audit['audit_data']) if audit.get('audit_data') else {}
            audit['business_context'] = json.loads(audit['business_context']) if audit.get('business_context') else {}

            # Fetch progress
            cursor.execute(
                f'SELECT progress_data FROM crawl_audit_progress WHERE audit_id = {ph()}',
                (audit['id'],)
            )
            progress_row = cursor.fetchone()
            audit['progress'] = json.loads(progress_row['progress_data']) if progress_row and progress_row['progress_data'] else {}

            return audit

    except Exception as e:
        print(f"Error getting audit result: {e}")
        return None


def get_latest_audit_by_domain(domain):
    """
    Get the most recent audit result for a domain (any crawl).
    Returns dict with progress or None.
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            cursor.execute(f'''
                SELECT * FROM crawl_audit_results
                WHERE domain = {ph()}
                ORDER BY created_at DESC LIMIT 1
            ''', (domain,))

            row = cursor.fetchone()
            if not row:
                return None

            audit = dict(row)
            audit['audit_data'] = json.loads(audit['audit_data']) if audit.get('audit_data') else {}
            audit['business_context'] = json.loads(audit['business_context']) if audit.get('business_context') else {}

            # Fetch progress
            cursor.execute(
                f'SELECT progress_data FROM crawl_audit_progress WHERE audit_id = {ph()}',
                (audit['id'],)
            )
            progress_row = cursor.fetchone()
            audit['progress'] = json.loads(progress_row['progress_data']) if progress_row and progress_row['progress_data'] else {}

            return audit

    except Exception as e:
        print(f"Error getting audit by domain: {e}")
        return None


def update_audit_progress(audit_id, progress_data):
    """
    Update checkbox/progress state for an audit. Idempotent UPSERT.
    progress_data: dict like {"checked": {"/page": ["check_id1", ...]}}
    Returns True on success.
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            progress_json = json.dumps(progress_data) if isinstance(progress_data, dict) else progress_data

            cursor.execute(f'''
                INSERT INTO crawl_audit_progress (audit_id, progress_data, updated_at)
                VALUES ({ph(2)}, CURRENT_TIMESTAMP)
                {upsert_conflict(['audit_id'], ['progress_data', 'updated_at'])}
            ''', (audit_id, progress_json))

            return True

    except Exception as e:
        print(f"Error updating audit progress: {e}")
        return False


def list_audits(limit=50):
    """
    List all audit results (summary only, no full audit_data).
    Returns list of dicts.
    """
    try:
        with get_db() as conn:
            cursor = get_cursor(conn)

            cursor.execute(f'''
                SELECT id, crawl_id, domain, client_name,
                       total_pages, total_checks, checks_passed, checks_failed,
                       critical_count, warning_count, info_count, overall_score_percent,
                       version, created_at
                FROM crawl_audit_results
                ORDER BY created_at DESC
                LIMIT {ph()}
            ''', (limit,))

            return [dict(row) for row in cursor.fetchall()]

    except Exception as e:
        print(f"Error listing audits: {e}")
        return []
