#!/usr/bin/env python3
"""Isolated, credential-free Claude Code wire compatibility probe.

The provider and financial services are fixtures, never external services. The
macOS network sandbox allows loopback only; inherited login/provider variables
are not copied into the child. This is not provider or settlement acceptance.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import http.client
import http.server
import json
from pathlib import Path
import select
import shlex
import socket
import socketserver
import subprocess
import tempfile
import threading


TOKEN = "claude-code-fixture-inference-token-0001"
MODEL = "claude-sonnet-4-20250514"


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--claude", type=Path, default=Path.home() / ".local/bin/claude")
    parser.add_argument("--output", type=Path, default=Path("target/claude-code-acceptance"))
    parser.add_argument("--go", type=Path, default=Path("target/toolchains/go/bin/go"))
    args = parser.parse_args()
    args.claude = args.claude.resolve(strict=True)
    args.go = args.go.resolve(strict=True)
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    if (output / "results.json").exists():
        raise SystemExit("Choose a new output directory; prior observations are preserved.")
    sandbox = Path("/usr/bin/sandbox-exec")
    if not sandbox.is_file():
        raise SystemExit("This probe requires the macOS loopback-only network sandbox.")
    with tempfile.TemporaryDirectory(prefix="zkapi-claude-") as temporary:
        directory = Path(temporary).resolve()
        work = directory / "work"
        work.mkdir()
        (work / "probe.txt").write_text("CLAUDE_CODE_TOOL_FIXTURE_OK\n")
        config = directory / "config"
        config.mkdir()
        token = directory / "fixture-token"
        token.write_text(TOKEN + "\n")
        token.chmod(0o600)
        settings = directory / "settings.json"
        settings.write_text(json.dumps({"apiKeyHelper": "cat " + shlex.quote(str(token)), "alwaysThinkingEnabled": False}))
        policy = directory / "network.sb"
        policy.write_text('(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n')
        requests: list[dict] = []
        bodies: list[dict] = []
        case = "plain"

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_HEAD(self):
                self.send_response(404)
                self.end_headers()

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw)
                bodies.append(body)
                requests.append({"case": case, "method": "POST", "path": self.path,
                    "authorizationMatchesFixtureToken": self.headers.get("Authorization") == "Bearer " + TOKEN,
                    "anthropicVersion": self.headers.get("anthropic-version"),
                    "anthropicBeta": self.headers.get("anthropic-beta"),
                    "idempotencyKeyPresent": self.headers.get("Idempotency-Key") is not None,
                    "bodySha256": sha(raw), "bodyBytes": len(raw), "bodyKeys": sorted(body),
                    "model": body.get("model"), "stream": body.get("stream"),
                    "metadataKeys": sorted(body.get("metadata", {})),
                    "toolNames": [item.get("name") for item in body.get("tools", [])],
                    "toolFieldNames": sorted({key for item in body.get("tools", []) for key in item}),
                    "toolResultObserved": any(isinstance(message.get("content"), list) and any(block.get("type") == "tool_result" and "CLAUDE_CODE_TOOL_FIXTURE_OK" in json.dumps(block) for block in message["content"]) for message in body.get("messages", []))})
                if case == "http503":
                    response = json.dumps({"type": "error", "error": {"type": "api_error", "message": "Fixture error; no request was replayed."}}).encode()
                    self.send_response(503)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
                    return
                message = {"id": "msg_fixture", "type": "message", "role": "assistant", "model": MODEL,
                    "content": [], "stop_reason": None, "stop_sequence": None,
                    "usage": {"input_tokens": 1, "output_tokens": 0}}
                tool_call = case == "tool" and not requests[-1]["toolResultObserved"]
                if tool_call:
                    events = [("message_start", {"type": "message_start", "message": message}),
                        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_fixture", "name": "Read", "input": {}}}),
                        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"file_path": str(work / "probe.txt")})}}),
                        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                        ("message_stop", {"type": "message_stop"})]
                else:
                    events = [("message_start", {"type": "message_start", "message": message}),
                    ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
                    ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "CLAUDE_CODE_TOOL_FIXTURE_OK" if case == "tool" else "CLAUDE_CODE_FIXTURE_OK"}}),
                    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                    ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
                    ("message_stop", {"type": "message_stop"})]
                response = "".join(f"event: {event}\ndata: {json.dumps(data)}\n\n" for event, data in events).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        env = {"PATH": "/usr/bin:/bin", "HOME": str(directory), "TMPDIR": str(directory),
            "CLAUDE_CONFIG_DIR": str(config), "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
            "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1", "CLAUDE_CODE_DISABLE_THINKING": "1",
            "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK": "1", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "512", "MAX_THINKING_TOKENS": "0", "DISABLE_PROMPT_CACHING": "1",
            "ENABLE_TOOL_SEARCH": "false", "CLAUDE_CODE_MAX_RETRIES": "0", "TERM": "dumb"}
        prefix = [str(sandbox), "-f", str(policy), str(args.claude)]
        version = subprocess.run(prefix + ["--version"], cwd=work, env=env, capture_output=True, text=True, timeout=15, check=True).stdout.strip()
        if version != "2.1.220 (Claude Code)":
            raise SystemExit("This saved compatibility contract is pinned to Claude Code 2.1.220; review a different version before changing the probe.")
        outcomes = []
        frontend = None
        unix_server = None
        production_frontend_response = None
        try:
            for name in ("plain", "tool", "http503", "production_frontend"):
                case = name
                before = len(requests)
                if name == "production_frontend":
                    class UnixHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
                        address_family = socket.AF_UNIX

                        def server_bind(self):
                            socketserver.TCPServer.server_bind(self)
                            self.server_name = "fixture"
                            self.server_port = 0

                    unix_socket = directory / "fixture.sock"
                    unix_server = UnixHTTPServer(str(unix_socket), Handler)
                    threading.Thread(target=unix_server.serve_forever, daemon=True).start()
                    binary = directory / "frontend"
                    source = Path("apps/clientd/testdata/openclaw-frontend.go").resolve()
                    subprocess.run([str(args.go), "build", "-o", str(binary), str(source)], cwd=source.parent.parent, capture_output=True, check=True, timeout=60)
                    with socket.socket() as reservation:
                        reservation.bind(("127.0.0.1", 0))
                        port = reservation.getsockname()[1]
                    frontend = subprocess.Popen([str(binary), str(unix_socket), str(port)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    frontend.stdin.write(json.dumps({"inference_token": TOKEN, "management_token": "claude-code-fixture-management-token-0001"}))
                    frontend.stdin.close()
                    if not select.select([frontend.stdout], [], [], 10)[0] or frontend.stdout.readline().strip() != "READY":
                        raise RuntimeError("production frontend did not start")
                    env["ANTHROPIC_BASE_URL"] = f"http://127.0.0.1:{port}"
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                    connection.request("POST", "/v1/messages?beta=true", json.dumps(bodies[0]), {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json", "anthropic-version": "2023-06-01"})
                    response = connection.getresponse()
                    production_frontend_response = {"status": response.status, "body": json.loads(response.read())}
                    connection.close()
                command = prefix + ["--bare", "--print", "--model", MODEL, "--system-prompt", "Return the provided fixture response.",
                    "--tools", "Read" if name == "tool" else "", "--permission-mode", "dontAsk", "--allowedTools", "Read", "--disable-slash-commands", "--no-session-persistence", "--no-chrome", "--strict-mcp-config",
                    "--setting-sources", "", "--settings", str(settings), "--output-format", "json", "Reply with fixture text."]
                try:
                    result = subprocess.run(command, cwd=work, env=env, capture_output=True, text=True, timeout=30)
                    stdout, stderr, code, timed_out = result.stdout, result.stderr, result.returncode, False
                except subprocess.TimeoutExpired as error:
                    stdout, stderr, code, timed_out = error.stdout or b"", error.stderr or b"", None, True
                    stdout = stdout.decode() if isinstance(stdout, bytes) else stdout
                    stderr = stderr.decode() if isinstance(stderr, bytes) else stderr
                # Logs contain only this isolated fixture's prompts and temp paths.
                (output / f"{name}.log").write_text(stdout + stderr)
                outcomes.append({"name": name, "exitCode": code, "timedOut": timed_out,
                    "fixtureBackendPackets": len(requests) - before, "fixtureTextReceived": "CLAUDE_CODE_FIXTURE_OK" in stdout,
                    "toolResultReceived": "CLAUDE_CODE_TOOL_FIXTURE_OK" in stdout,
                    "apiErrorStatus": json.loads(stdout).get("api_error_status") if stdout.lstrip().startswith("{") else None})
        finally:
            if frontend is not None:
                frontend.terminate()
                frontend.wait(timeout=10)
            if unix_server is not None:
                unix_server.shutdown()
                unix_server.server_close()
            server.shutdown()
            server.server_close()
        # Do not persist generated metadata identifiers or prompts. The complete
        # body is retained only while constructing this structural report.
        report = {"schema": 1, "recordedAt": datetime.now(timezone.utc).isoformat(), "claudeVersion": version,
            "scope": "actual installed Claude Code CLI to localhost Anthropic SSE/tool/error fixture and production Go route rejection; no shared SDK, financial service or provider",
            "externalNetworkBlocked": True, "realCredentialsUsed": False, "publicDevnet": False, "liveProvider": False,
            "outcomes": outcomes, "requests": requests,
            "productionFrontendResponse": production_frontend_response,
            "probeChecksPassed": (len(outcomes) == 4 and all(not item["timedOut"] for item in outcomes)
                and outcomes[0]["exitCode"] == 0 and outcomes[0]["fixtureTextReceived"] and outcomes[0]["fixtureBackendPackets"] == 1
                and outcomes[1]["exitCode"] == 0 and outcomes[1]["toolResultReceived"] and outcomes[1]["fixtureBackendPackets"] == 2
                and outcomes[2]["exitCode"] == 1 and outcomes[2]["fixtureBackendPackets"] == 1
                and outcomes[3]["exitCode"] == 1 and outcomes[3]["apiErrorStatus"] == 400 and outcomes[3]["fixtureBackendPackets"] == 0
                and production_frontend_response == {"status": 400, "body": {"error": {"type": "zkapi_client_error", "code": "unsupported_route", "message": "Request was not replayed. Inspect local status before retrying."}}}
                and all(item["authorizationMatchesFixtureToken"] for item in requests)
                and all(item["path"] == "/v1/messages?beta=true" and item["metadataKeys"] == ["user_id"]
                    and item["anthropicBeta"] == "claude-code-20250219,interleaved-thinking-2025-05-14" for item in requests)
                and any(item["toolResultObserved"] for item in requests)),
            "compatibilityPassed": False,
            "blockingObservations": ["production frontend rejects the observed ?beta=true query before reaching its backend", "observed metadata.user_id is outside the existing Anthropic proxy body allowlist", "observed beta header remains despite disabling experimental betas; no reviewed proxy pass-through exists"],
            "authRequests": 0, "providerInferenceRequests": 0,
            "sourceSha256": {"scripts/run_claude_code_clientd_acceptance.py": sha(Path(__file__).read_bytes()),
                "apps/clientd/internal/daemon/server.go": sha(Path("apps/clientd/internal/daemon/server.go").read_bytes()),
                "services/control/src/proxy/request.rs": sha(Path("services/control/src/proxy/request.rs").read_bytes()),
                "apps/clientd/testdata/openclaw-frontend.go": sha(Path("apps/clientd/testdata/openclaw-frontend.go").read_bytes())}}
        (output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        return 0 if report["probeChecksPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
