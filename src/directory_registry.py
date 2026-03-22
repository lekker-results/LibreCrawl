"""
Auto-discovery registry for directory playbooks.

Scans src/playbooks/ for .py files with METADATA dict + verify()/register() functions.
Adding a new directory = dropping a single .py file into src/playbooks/.
"""

import importlib
import importlib.util
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

PLAYBOOKS_DIR = Path(__file__).parent / 'playbooks'

_registry_cache = {}
_cache_mtime = 0


def _scan_playbooks():
    """Scan the playbooks directory and import all valid playbook modules."""
    global _registry_cache, _cache_mtime

    registry = {}
    playbooks_path = PLAYBOOKS_DIR

    if not playbooks_path.exists():
        logger.warning(f"Playbooks directory not found: {playbooks_path}")
        return registry

    for py_file in playbooks_path.glob('*.py'):
        if py_file.name.startswith('_'):
            continue

        module_name = py_file.stem
        try:
            spec = importlib.util.spec_from_file_location(
                f"src.playbooks.{module_name}", py_file
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            metadata = getattr(module, 'METADATA', None)
            verify_fn = getattr(module, 'verify', None)
            register_fn = getattr(module, 'register', None)

            if metadata and isinstance(metadata, dict) and verify_fn:
                registry[module_name] = {
                    **metadata,
                    'key': module_name,
                    'module': module,
                    'has_verify': verify_fn is not None,
                    'has_register': register_fn is not None,
                }
                logger.info(f"Loaded directory playbook: {module_name} ({metadata.get('name', '?')})")
            else:
                logger.debug(f"Skipping {py_file.name}: missing METADATA or verify()")
        except Exception as e:
            logger.error(f"Failed to load playbook {py_file.name}: {e}")

    _registry_cache = registry
    _cache_mtime = max(
        (f.stat().st_mtime for f in playbooks_path.glob('*.py') if not f.name.startswith('_')),
        default=0
    )
    return registry


def get_registry(force_reload=False):
    """Get the directory registry, reloading if playbooks have changed."""
    global _registry_cache, _cache_mtime

    if force_reload or not _registry_cache:
        return _scan_playbooks()

    # Check if any file has been modified since last scan
    try:
        current_mtime = max(
            (f.stat().st_mtime for f in PLAYBOOKS_DIR.glob('*.py') if not f.name.startswith('_')),
            default=0
        )
        if current_mtime > _cache_mtime:
            return _scan_playbooks()
    except Exception:
        pass

    return _registry_cache


def get_playbook(directory_key):
    """Get a specific playbook by its key (filename without .py)."""
    registry = get_registry()
    return registry.get(directory_key)


def list_directories():
    """List all available directories with their metadata."""
    registry = get_registry()
    return [
        {
            'key': key,
            'name': entry.get('name', key),
            'domain': entry.get('domain', ''),
            'tier': entry.get('tier', 99),
            'has_verify': entry.get('has_verify', False),
            'has_register': entry.get('has_register', False),
            'has_captcha': entry.get('has_captcha', False),
            'requires_email_verification': entry.get('requires_email_verification', False),
            'category': entry.get('category', 'general'),
            'last_tested': entry.get('last_tested', ''),
        }
        for key, entry in sorted(registry.items(), key=lambda x: x[1].get('tier', 99))
    ]
