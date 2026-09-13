#!/usr/bin/env python3
"""Private deterministic OpenAI-compatible provider for Bodhi restart acceptance.

Only synthetic request metadata is persisted. Authorization values and request
bodies are intentionally never written to stdout, stderr, or the observation
file.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


MODEL = "gpt-4o-mini"
MAX_REQUEST_BYTES = 4 * 1024 * 1024


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"required environment variable is missing: {name}")
    return value


def contains(value: Any, marker: str) -> bool:
    if isinstance(value, str):
        return marker in value
    if isinstance(value, list):
        return any(contains(item, marker) for item in value)
    if isinstance(value, dict):
        return any(contains(item, marker) for item in value.values())
    return False


def has_tool_result(body: Any, tool_call_id: str) -> bool:
    if not isinstance(body, dict):
        return False
    messages = body.get("messages")
    if not isinstance(messages, list):
        return False
    return any(
        isinstance(message, dict)
        and message.get("role") == "tool"
        and message.get("tool_call_id") == tool_call_id
        for message in messages
    )


class Observations:
    def __init__(self, path: Path, markers: dict[str, str]) -> None:
        self._path = path
        self._markers = markers
        self._requests: list[dict[str, object]] = []
        self._lock = threading.Lock()

    def initialize(self) -> None:
        with self._lock:
            self._persist()

    def append(
        self,
        *,
        phase: str | None,
        model: str | None,
        stream: bool,
        response_action: str,
    ) -> None:
        with self._lock:
            self._requests.append(
                {
                    "sequence": len(self._requests) + 1,
                    "method": "POST",
                    "path": "/v1/chat/completions",
                    "model": MODEL if model == MODEL else None,
                    "stream": stream,
                    "syntheticPhase": phase,
                    "responseAction": response_action,
                }
            )
            self._persist()

    def _persist(self) -> None:
        document = {
            "schemaVersion": 1,
            "syntheticPhases": sorted(self._markers),
            "requestCount": len(self._requests),
            "requests": self._requests,
        }
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(
            f".{self._path.name}.tmp-{os.getpid()}-{threading.get_ident()}"
        )
        descriptor = -1
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                descriptor = -1
                json.dump(document, output, ensure_ascii=False, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self._path)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def handle_error(self, request: object, client_address: object) -> None:
        del request, client_address
        print("provider request handler failed", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "BodhiManagedRestartProvider/1"
    sys_version = ""

    api_key: str
    assistant_marker: str
    markers: dict[str, str]
    observations: Observations
    session_note_marker: str

    def log_message(self, format: str, *args: object) -> None:
        del format, args

    def _json(self, status: int, value: object) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        actual = self.headers.get("Authorization", "")
        return hmac.compare_digest(actual, f"Bearer {self.api_key}")

    def _require_authorized(self) -> bool:
        if self._authorized():
            return True
        self._json(401, {"error": {"message": "invalid synthetic credential"}})
        return False

    def do_GET(self) -> None:
        if not self._require_authorized():
            return
        if urlsplit(self.path).path != "/v1/models":
            self._json(404, {"error": {"message": "unsupported provider path"}})
            return
        self._json(
            200,
            {
                "object": "list",
                "data": [
                    {
                        "id": MODEL,
                        "object": "model",
                        "created": 0,
                        "owned_by": "bodhi-managed-restart-acceptance",
                    }
                ],
            },
        )

    def do_POST(self) -> None:
        if not self._require_authorized():
            return
        if urlsplit(self.path).path != "/v1/chat/completions":
            self._json(404, {"error": {"message": "unsupported provider path"}})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
            if length < 0 or length > MAX_REQUEST_BYTES:
                raise ValueError("request length outside acceptance bound")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
            self._json(400, {"error": {"message": "invalid provider request"}})
            return

        model = body.get("model") if isinstance(body, dict) else None
        model = model if isinstance(model, str) else None
        stream = isinstance(body, dict) and body.get("stream") is True
        phase = next(
            (name for name, marker in self.markers.items() if contains(body, marker)),
            None,
        )
        tool_call_id = "call_bodhi_session_note"
        response_action = (
            "final"
            if phase != "child" or has_tool_result(body, tool_call_id)
            else "session_note"
        )
        self.observations.append(
            phase=phase,
            model=model,
            stream=stream,
            response_action=response_action,
        )
        if model != MODEL or not stream or phase is None:
            self._json(
                422,
                {"error": {"message": "request did not satisfy the acceptance contract"}},
            )
            return

        base = {
            "id": "chatcmpl-bodhi-managed-restart",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": MODEL,
        }
        if response_action == "session_note":
            arguments = json.dumps(
                {
                    "action": "replace",
                    "content": self.session_note_marker,
                    "topic": "acceptance",
                },
                separators=(",", ":"),
            )
            frames = [
                {
                    **base,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": tool_call_id,
                                        "type": "function",
                                        "function": {
                                            "name": "session_note",
                                            "arguments": arguments,
                                        },
                                    }
                                ],
                            },
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    **base,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "tool_calls"}
                    ],
                },
            ]
        else:
            frames = [
                {
                    **base,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": f"{self.assistant_marker}:{phase}",
                            },
                            "finish_reason": None,
                        }
                    ],
                },
                {
                    **base,
                    "choices": [
                        {"index": 0, "delta": {}, "finish_reason": "stop"}
                    ],
                },
            ]
        frames.append(
            {
                **base,
                "choices": [],
                "usage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                    "prompt_tokens_details": {"cached_tokens": 0},
                    "completion_tokens_details": {"reasoning_tokens": 0},
                },
            }
        )
        self.send_response(200)
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Connection", "close")
        self.end_headers()
        for frame in frames:
            encoded = json.dumps(frame, separators=(",", ":"))
            self.wfile.write(f"data: {encoded}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        self.close_connection = True


def main() -> None:
    port = int(required("BODHI_ACCEPTANCE_PROVIDER_PORT"))
    if port < 1 or port > 65_535:
        raise RuntimeError("provider port is outside the TCP range")
    Handler.api_key = required("BODHI_ACCEPTANCE_PROVIDER_KEY")
    Handler.assistant_marker = required("BODHI_ACCEPTANCE_ASSISTANT_MARKER")
    Handler.session_note_marker = required("BODHI_ACCEPTANCE_SESSION_NOTE_MARKER")
    Handler.markers = {
        "child": required("BODHI_ACCEPTANCE_CHILD_MARKER"),
        "restart": required("BODHI_ACCEPTANCE_RESTART_MARKER"),
        "root": required("BODHI_ACCEPTANCE_ROOT_MARKER"),
    }
    Handler.observations = Observations(
        Path(required("BODHI_ACCEPTANCE_PROVIDER_OBSERVATIONS")),
        Handler.markers,
    )
    Handler.observations.initialize()
    server = Server(("127.0.0.1", port), Handler)
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
