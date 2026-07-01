#!/usr/bin/env python3
# Bio 305 LOCAL deep-grade daemon.  On-demand, synchronous: the app's "Deep grade" button POSTs
# one answer, this runs `claude -p` right here and returns the verdict INLINE. No job queue, no
# polling, no Cloudflare KV — this replaces the old 30s-poll relay that blew the KV list cap ~4am.
# Laptop-only by design: the browser button and this daemon are the same machine (localhost), so
# they talk directly. Security boundary = origin-locked CORS + 127.0.0.1 bind (a cross-site page
# can't forge the Origin header, so it can't reach us; the live HTTPS site can't either — mixed
# content). Grading prompt is byte-identical to the retired relay/grade.py.
import json, os, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST, PORT = "127.0.0.1", 8457
CLAUDE = os.environ.get("CLAUDE", "/Users/christian/.npm-global/bin/claude")
ALLOWED_ORIGINS = {"http://localhost:8456", "http://127.0.0.1:8456"}

def grade(question, model_answer, student_answer):
    # Built exactly like the retired grade.py: the example-JSON braces sit in a PLAIN string (no
    # f-string, no .format()), so they stay literal; only Q/M/S interpolate. Using .format() on the
    # whole thing would choke on the literal braces in the {"verdict":...} example.
    prompt = ("You are grading a college Genetics short-answer question. Be fair but rigorous. "
        'Respond with ONLY compact JSON, no prose: {"verdict":"correct|partial|incorrect","score":<0..1>,"note":"<=1 sentence why"}.\n\n'
        f"QUESTION:\n{question or ''}\n\nMODEL ANSWER:\n{model_answer or ''}\n\nSTUDENT ANSWER:\n{student_answer or ''}\n")
    out = subprocess.run([CLAUDE, "-p", prompt], capture_output=True, text=True, timeout=150).stdout.strip()
    frag = out[out.find("{"): out.rfind("}") + 1]
    v = json.loads(frag)
    return {"verdict": v.get("verdict"), "score": v.get("score"), "note": v.get("note")}

class H(BaseHTTPRequestHandler):
    def _cors(self, origin):
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "POST,GET,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
    def _send(self, code, obj, origin):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self._cors(origin)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        self.send_response(204); self._cors(origin); self.end_headers()
    def do_GET(self):
        origin = self.headers.get("Origin", "")
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "service": "bio305-grade-daemon"}, origin)
        self._send(404, {"error": "not found"}, origin)
    def do_POST(self):
        origin = self.headers.get("Origin", "")
        if not self.path.startswith("/grade"):
            return self._send(404, {"error": "not found"}, origin)
        # Origin lock IS the gate: the browser sets Origin honestly, so a cross-site page can't reach us.
        if origin not in ALLOWED_ORIGINS:
            return self._send(403, {"error": "bad origin"}, origin)
        if "application/json" not in self.headers.get("content-type", ""):
            return self._send(415, {"error": "json only"}, origin)
        try:
            n = int(self.headers.get("content-length", "0"))
            b = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"}, origin)
        try:
            self._send(200, grade(b.get("question"), b.get("model_answer"), b.get("student_answer")), origin)
        except subprocess.TimeoutExpired:
            self._send(200, {"error": True, "note": "grader timed out (claude -p > 150s)"}, origin)
        except Exception as e:
            self._send(200, {"error": True, "note": str(e)[:160]}, origin)
    def log_message(self, format, *args):  # keep the log quiet; launchd captures prints below
        pass

if __name__ == "__main__":
    print(f"bio305 grade daemon → http://{HOST}:{PORT}  (claude={CLAUDE})", flush=True)
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
