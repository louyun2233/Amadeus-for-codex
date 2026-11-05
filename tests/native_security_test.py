"""Transport regressions against local synthetic HTTP servers; no account or audio use."""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native'))
from panel import Api


class NativeTransportTest(unittest.TestCase):
    def setUp(self):
        self.hits = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.hits.append((self.server.server_port, self.path,
                                   self.headers.get('Authorization'), self.headers.get('X-Amadeus-Client')))
                if self.path.endswith('/redirect'):
                    self.send_response(302)
                    self.send_header('Location', f'http://127.0.0.1:{owner.sink.server_port}/sink')
                    self.end_headers()
                else:
                    data = json.dumps({'ok': True}).encode()
                    self.send_response(200)
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)

        self.servers = [ThreadingHTTPServer(('127.0.0.1', 0), Handler) for _ in range(3)]
        self.source, self.sink, self.proxy = self.servers
        self.threads = [threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
                        for server in self.servers]
        for thread in self.threads:
            thread.start()
        self.api = Api(f'http://127.0.0.1:{self.source.server_port}/?token=synthetic_native_token')

    def tearDown(self):
        for server in self.servers:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)

    def test_system_proxy_cannot_receive_the_daemon_bearer(self):
        proxy_url = f'http://127.0.0.1:{self.proxy.server_port}'
        env = {name: proxy_url for name in ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'ALL_PROXY']}
        env.update({'no_proxy': '', 'NO_PROXY': ''})
        with patch.dict(os.environ, env):
            self.assertEqual(self.api.request('/amadeus/health'), {'ok': True})
        self.assertEqual(len(self.hits), 1)
        port, _, auth, client = self.hits[0]
        self.assertEqual(port, self.source.server_port)
        self.assertEqual(auth, 'Bearer synthetic_native_token')
        self.assertEqual(client, self.api.client)

    def test_redirect_cannot_forward_bearer_to_another_service(self):
        with self.assertRaisesRegex(RuntimeError, 'HTTP 302'):
            self.api.request('/amadeus/redirect')
        self.assertEqual(len(self.hits), 1)
        self.assertEqual(self.hits[0][0], self.source.server_port)

    def test_external_daemon_urls_and_non_api_paths_are_rejected(self):
        for url in ['https://127.0.0.1:1234/?token=x', 'http://example.com:1234/?token=x',
                    '@'.join(['http://name:secret', '127.0.0.1:1234/?token=x']), 'http://127.0.0.1:1234/']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                Api(url)
        for path in ['http://example.com/', '//example.com/', '/amadeus\\status', '/not-an-api']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.api.request(path)
        self.assertEqual(self.hits, [])


if __name__ == '__main__':
    unittest.main()
