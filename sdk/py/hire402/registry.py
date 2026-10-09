"""Registry HTTP client — EIP-712 authenticated (spec §10), TS-compatible."""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

from .eip712 import keccak_text, sign_registry_request


class RegistryClient:
    def __init__(self, registry_url: str, sender, w3):
        self.url = registry_url.rstrip("/")
        self.sender = sender
        self.chain_id = w3.eth.chain_id

    def post(self, path: str, body: dict) -> Any:
        raw = json.dumps(body).encode()
        headers = sign_registry_request(self.sender, self.chain_id,
                                        keccak_text(raw.decode()))
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=raw, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            raise RuntimeError(f"registry POST {path} → {e.code}: {detail}") from e

    def get(self, path: str) -> Any:
        req = urllib.request.Request(self.url + path, method="GET")
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read())
