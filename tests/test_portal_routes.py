"""
test_portal_routes.py — Tests for Phase 7 portal/pipeline API routes in main.py.

Uses Flask test client with local mode auto-login.
Mocks DB calls so no real Postgres connection is needed.

Run with:
    cd ~/development/LibreCrawl
    .venv/bin/python -m pytest tests/test_portal_routes.py -v
"""

import os
import sys
import json
import types
import unittest
from unittest.mock import MagicMock, patch, call

# Force local mode and testing flag before importing main
os.environ['FLASK_TESTING'] = '1'
sys.argv = ['main.py', '--local']

import main as app_module
app = app_module.app
app.config['TESTING'] = True
app.config['SECRET_KEY'] = 'test-secret'


def _inject_session(client, user_id=1, username='local', tier='admin'):
    """Inject a valid session into the Flask test client."""
    with client.session_transaction() as sess:
        sess['user_id'] = user_id
        sess['username'] = username
        sess['tier'] = tier


# ── Helpers ────────────────────────────────────────────────────────

def _pipeline_row(**kwargs):
    defaults = {
        'client_id': 1, 'client_name': 'Acme Corp',
        'current_stage': 10, 'stage_name': 'Onboarding',
        'client_phase': 'Setup', 'stage_entered_at': None,
        'last_followup_at': None, 'next_action': None,
        'total_items': 8, 'completed_items': 4, 'overdue_items': 1,
    }
    defaults.update(kwargs)
    return defaults


def _history_row(**kwargs):
    defaults = {
        'client_id': 1, 'from_stage': 9, 'to_stage': 10,
        'changed_by': 'portal_client.py', 'notes': None, 'changed_at': None,
    }
    defaults.update(kwargs)
    return defaults


def _portal_record_row(**kwargs):
    defaults = {
        'portal_type': 'onboarding', 'is_active': True, 'created_at': None,
    }
    defaults.update(kwargs)
    return defaults


def _checklist_row(**kwargs):
    defaults = {
        'id': 10, 'status': 'pending', 'priority': 'critical',
        'due_date': None, 'submitted_at': None, 'rejection_reason': None,
        'name': 'Company logo', 'description': 'Upload your SVG logo',
        'category': 'files_assets', 'item_type': 'file_upload',
    }
    defaults.update(kwargs)
    return defaults


# ── GET /api/pipeline ──────────────────────────────────────────────

class TestGetPipeline(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_clients_list(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchall.return_value = [_pipeline_row()]

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/pipeline')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertIn('clients', data)
        self.assertEqual(len(data['clients']), 1)
        self.assertEqual(data['clients'][0]['client_phase'], 'Setup')

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_portal_completion_fields_present(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchall.return_value = [_pipeline_row()]

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/pipeline')

        data = resp.get_json()
        client_entry = data['clients'][0]
        self.assertIn('portal_completion', client_entry)
        self.assertIn('total', client_entry['portal_completion'])
        self.assertIn('completed', client_entry['portal_completion'])
        self.assertIn('overdue', client_entry['portal_completion'])

    def test_returns_200_with_empty_pipeline(self):
        # Verifies the endpoint is reachable and returns valid JSON shape with empty data
        with app.test_client() as client:
            _inject_session(client)
            with patch('src.db.get_db') as mock_get_db, \
                 patch('src.db.get_cursor') as mock_get_cursor:
                mock_conn = MagicMock()
                mock_cursor = MagicMock()
                mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
                mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
                mock_get_cursor.return_value = mock_cursor
                mock_cursor.fetchall.return_value = []
                resp = client.get('/api/pipeline')
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['clients'], [])


# ── GET /api/clients/<id>/pipeline ────────────────────────────────

class TestGetClientPipeline(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_pipeline_state(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        # fetchone for pipeline state, fetchall for history
        mock_cursor.fetchone.return_value = {
            'current_stage': 10, 'stage_name': 'Onboarding',
            'client_phase': 'Setup', 'client_phase_description': 'Setting up.',
            'stage_entered_at': None, 'last_followup_at': None, 'next_action': None,
        }
        mock_cursor.fetchall.return_value = [_history_row()]

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/clients/1/pipeline')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertIn('current', data)
        self.assertEqual(data['current']['stage_name'], 'Onboarding')
        self.assertIn('history', data)

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_404_when_no_pipeline_state(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchone.return_value = None

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/clients/999/pipeline')

        self.assertEqual(resp.status_code, 404)
        data = resp.get_json()
        self.assertFalse(data['success'])


# ── PUT /api/clients/<id>/pipeline ────────────────────────────────

class TestPutClientPipeline(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_advances_stage(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchone.return_value = {'id': 1}  # Client exists

        with app.test_client() as client:
            _inject_session(client)
            resp = client.put('/api/clients/1/pipeline',
                              json={'stage': 12, 'notes': 'Starting build'},
                              content_type='application/json')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertEqual(data['stage'], 12)
        self.assertEqual(data['stage_name'], 'Building')

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_400_if_stage_missing(self, mock_get_db, mock_get_cursor):
        with app.test_client() as client:
            _inject_session(client)
            resp = client.put('/api/clients/1/pipeline',
                              json={},
                              content_type='application/json')

        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertFalse(data['success'])
        self.assertIn('stage', data['error'])

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_404_when_client_not_found(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchone.return_value = None  # Client not found

        with app.test_client() as client:
            _inject_session(client)
            resp = client.put('/api/clients/999/pipeline',
                              json={'stage': 12},
                              content_type='application/json')

        self.assertEqual(resp.status_code, 404)


# ── GET /api/clients/<id>/portal ──────────────────────────────────

class TestGetClientPortal(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_portal_with_checklist(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        # fetchone: portal record; fetchall x2: checklist items, followup events; fetchone: cred count
        mock_cursor.fetchone.side_effect = [
            _portal_record_row(),   # portal record
            {'cnt': 2},             # credentials count
        ]
        mock_cursor.fetchall.side_effect = [
            [_checklist_row(status='verified'), _checklist_row(status='pending')],  # checklist
            [],  # followup events
        ]

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/clients/1/portal')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        portal = data['portal']
        self.assertIn('checklist', portal)
        self.assertEqual(portal['checklist']['total'], 2)
        self.assertEqual(portal['checklist']['completed'], 1)
        self.assertEqual(portal['credentials_submitted'], 2)

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_returns_empty_portal_when_no_record(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.fetchone.side_effect = [
            None,       # no portal record
            {'cnt': 0}, # no credentials
        ]
        mock_cursor.fetchall.side_effect = [[], []]

        with app.test_client() as client:
            _inject_session(client)
            resp = client.get('/api/clients/1/portal')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])
        self.assertIsNone(data['portal']['portal_type'])


# ── POST /api/clients/<id>/portal/verify/<item_id> ────────────────

class TestVerifyChecklistItem(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_verify_success(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.rowcount = 1

        with app.test_client() as client:
            _inject_session(client)
            resp = client.post('/api/clients/1/portal/verify/10')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_verify_item_not_found(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.rowcount = 0  # No rows updated

        with app.test_client() as client:
            _inject_session(client)
            resp = client.post('/api/clients/1/portal/verify/999')

        self.assertEqual(resp.status_code, 404)
        data = resp.get_json()
        self.assertFalse(data['success'])


# ── POST /api/clients/<id>/portal/reject/<item_id> ────────────────

class TestRejectChecklistItem(unittest.TestCase):

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_reject_success(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.rowcount = 1

        with app.test_client() as client:
            _inject_session(client)
            resp = client.post('/api/clients/1/portal/reject/10',
                               json={'reason': 'Need SVG format'},
                               content_type='application/json')

        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data['success'])

    def test_reject_requires_reason(self):
        with app.test_client() as client:
            _inject_session(client)
            resp = client.post('/api/clients/1/portal/reject/10',
                               json={},
                               content_type='application/json')

        self.assertEqual(resp.status_code, 400)
        data = resp.get_json()
        self.assertFalse(data['success'])
        self.assertIn('reason', data['error'])

    @patch('src.db.get_cursor')
    @patch('src.db.get_db')
    def test_reject_item_not_found(self, mock_get_db, mock_get_cursor):
        mock_conn = MagicMock()
        mock_cursor = MagicMock()
        mock_get_db.return_value.__enter__ = MagicMock(return_value=mock_conn)
        mock_get_db.return_value.__exit__ = MagicMock(return_value=False)
        mock_get_cursor.return_value = mock_cursor
        mock_cursor.rowcount = 0

        with app.test_client() as client:
            _inject_session(client)
            resp = client.post('/api/clients/1/portal/reject/999',
                               json={'reason': 'Bad format'},
                               content_type='application/json')

        self.assertEqual(resp.status_code, 404)


if __name__ == '__main__':
    unittest.main()
