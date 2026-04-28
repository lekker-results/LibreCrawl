"""
Database abstraction layer for LibreCrawl.
Supports PostgreSQL (via DATABASE_URL) with SQLite fallback.
"""
import os
import sqlite3
import sys
from contextlib import contextmanager

DATABASE_URL = os.getenv('DATABASE_URL', '')

# Determine database type
if DATABASE_URL and DATABASE_URL.startswith('postgresql'):
    DB_TYPE = 'postgres'
    import psycopg2
    import psycopg2.extras
    import psycopg2.pool

    _pool = None

    def _get_pool():
        global _pool
        if _pool is None:
            _pool = psycopg2.pool.ThreadedConnectionPool(
                minconn=2,
                maxconn=10,
                dsn=DATABASE_URL,
                # Keepalives keep idle connections alive through Supabase's
                # pooler and intermediate NATs. Without these, connections
                # silently die and the pool hands out broken handles.
                keepalives=1,
                keepalives_idle=30,
                keepalives_interval=10,
                keepalives_count=3,
            )
        return _pool

    def _connection_is_healthy(conn):
        """Ping the connection with a cheap query. Returns True if usable.

        Leaves the connection in a clean, idle, non-transaction state so the
        caller can freely set autocommit and start a fresh transaction.
        """
        if conn.closed:
            return False
        try:
            # Reset any aborted transaction state before the ping.
            conn.rollback()
            with conn.cursor() as cur:
                cur.execute('SELECT 1')
                cur.fetchone()
            # Close the implicit transaction started by SELECT so the caller
            # can set autocommit without "cannot be used inside a transaction".
            conn.rollback()
            return True
        except (psycopg2.InterfaceError, psycopg2.OperationalError, psycopg2.DatabaseError):
            return False

    @contextmanager
    def get_db():
        """Context manager for PostgreSQL connections using connection pool.

        Validates the connection before yielding so that stale / idle-killed
        pool entries (common with Supabase's transaction pooler dropping
        idle connections) are transparently recycled instead of handing
        out broken handles that fail silently.
        """
        pool = _get_pool()
        conn = pool.getconn()
        # Up to two attempts: if the first conn is dead, discard and retry once.
        if not _connection_is_healthy(conn):
            print('[db] stale connection from pool — recycling', flush=True, file=sys.stderr)
            try:
                pool.putconn(conn, close=True)
            except Exception:
                pass
            conn = pool.getconn()
            if not _connection_is_healthy(conn):
                # Second dead conn — surface it rather than silently failing.
                try:
                    pool.putconn(conn, close=True)
                except Exception:
                    pass
                raise psycopg2.OperationalError(
                    'Unable to obtain a healthy database connection from the pool'
                )
        conn.autocommit = False
        close_on_release = False
        try:
            yield conn
            conn.commit()
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                # Rollback itself failed — connection is toast, close on release.
                close_on_release = True
            raise e
        finally:
            try:
                pool.putconn(conn, close=close_on_release)
            except Exception:
                pass

    def get_cursor(conn):
        """Get a cursor that returns dict-like rows."""
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def IntegrityError():
        """Return the appropriate IntegrityError class."""
        return psycopg2.IntegrityError

else:
    DB_TYPE = 'sqlite'

    # Database file location - stored in data/ for Docker volume persistence
    _DB_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
    DB_FILE = os.path.join(_DB_DIR, 'users.db')

    @contextmanager
    def get_db():
        """Context manager for SQLite connections."""
        os.makedirs(_DB_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_FILE)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        except Exception as e:
            conn.rollback()
            raise e
        finally:
            conn.close()

    def get_cursor(conn):
        """Get a cursor (SQLite rows already act as dicts via row_factory)."""
        return conn.cursor()

    def IntegrityError():
        """Return the appropriate IntegrityError class."""
        return sqlite3.IntegrityError


# SQL dialect helpers

def ph(count=1):
    """Return placeholder string(s) for parameterized queries.
    ph() -> '%s' or '?'
    ph(3) -> '%s, %s, %s' or '?, ?, ?'
    """
    p = '%s' if DB_TYPE == 'postgres' else '?'
    return ', '.join([p] * count)


def returning_id():
    """Return SQL fragment to get the inserted row's ID.
    For Postgres: ' RETURNING id'
    For SQLite: '' (use cursor.lastrowid instead)
    """
    return ' RETURNING id' if DB_TYPE == 'postgres' else ''


def get_last_id(cursor):
    """Get the ID of the last inserted row.
    For Postgres: fetches from RETURNING clause
    For SQLite: uses cursor.lastrowid
    """
    if DB_TYPE == 'postgres':
        row = cursor.fetchone()
        return row['id'] if row else None
    return cursor.lastrowid


def now_minus_interval(value, unit='hours'):
    """Return SQL for 'NOW() - interval'.
    now_minus_interval(24, 'hours') ->
      Postgres: "NOW() - INTERVAL '24 hours'"
      SQLite:   "datetime('now', '-24 hours')"
    """
    if DB_TYPE == 'postgres':
        return f"NOW() - INTERVAL '{value} {unit}'"
    return f"datetime('now', '-{value} {unit}')"


def now_minus_interval_param(unit='days'):
    """Return SQL for dynamic interval with a parameter placeholder.
    For cleanup queries like 'older than ? days'.

    Postgres: "NOW() - (CAST(%s AS TEXT) || ' days')::INTERVAL"
    SQLite:   "datetime('now', '-' || ? || ' days')"
    """
    p = '%s' if DB_TYPE == 'postgres' else '?'
    if DB_TYPE == 'postgres':
        return f"NOW() - (CAST({p} AS TEXT) || ' {unit}')::INTERVAL"
    return f"datetime('now', '-' || {p} || ' {unit}')"


def serial_pk():
    """Return SQL for auto-incrementing primary key.
    Postgres: 'SERIAL PRIMARY KEY'
    SQLite:   'INTEGER PRIMARY KEY AUTOINCREMENT'
    """
    return 'SERIAL PRIMARY KEY' if DB_TYPE == 'postgres' else 'INTEGER PRIMARY KEY AUTOINCREMENT'


def upsert_conflict(conflict_cols, update_cols):
    """Return SQL for ON CONFLICT ... DO UPDATE.
    conflict_cols: list of column names for the conflict target
    update_cols: list of column names to update

    Returns: 'ON CONFLICT(col1, col2) DO UPDATE SET col1 = excluded.col1, ...'
    """
    conflict = ', '.join(conflict_cols)
    updates = ', '.join(f'{col} = excluded.{col}' for col in update_cols)
    return f'ON CONFLICT({conflict}) DO UPDATE SET {updates}'


def insert_or_ignore():
    """Return SQL prefix for insert-or-ignore.
    Postgres: 'INSERT INTO ... ON CONFLICT DO NOTHING' (append separately)
    SQLite:   'INSERT OR IGNORE INTO'
    """
    return 'INSERT OR IGNORE INTO' if DB_TYPE == 'sqlite' else 'INSERT INTO'


def on_conflict_ignore():
    """Return SQL suffix for ignoring conflicts.
    Postgres: 'ON CONFLICT DO NOTHING'
    SQLite:   '' (handled by INSERT OR IGNORE prefix)
    """
    return '' if DB_TYPE == 'sqlite' else 'ON CONFLICT DO NOTHING'


def table_columns(conn, table_name):
    """Get column names for a table.
    Returns list of column name strings.
    """
    cursor = get_cursor(conn)
    if DB_TYPE == 'postgres':
        cursor.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
            (table_name,)
        )
        return [row['column_name'] for row in cursor.fetchall()]
    else:
        cursor.execute(f"PRAGMA table_info({table_name})")
        return [row['name'] for row in cursor.fetchall()]


def get_database_size_mb():
    """Get total database size in MB."""
    try:
        if DB_TYPE == 'postgres':
            with get_db() as conn:
                cursor = get_cursor(conn)
                cursor.execute("SELECT pg_database_size(current_database()) as size")
                row = cursor.fetchone()
                return round(row['size'] / (1024 * 1024), 2)
        else:
            if os.path.exists(DB_FILE):
                size_bytes = os.path.getsize(DB_FILE)
                return round(size_bytes / (1024 * 1024), 2)
            return 0
    except Exception as e:
        print(f"Error getting database size: {e}")
        return 0
