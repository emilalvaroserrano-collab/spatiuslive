# Nadia LiveKit agent worker

Vercel hosts the web app and `/api/token`. The long-running LiveKit agent worker must run on LiveKit Agents Cloud, a VPS, or another persistent Python runtime.

## Local worker

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env
# fill the server-side keys
lk agent dev agent.py
```

Deploy with the LiveKit CLI workflow supported by your account, for example `lk agent deploy agent.py`.

The explicit dispatch name is `nadia-seller`; keep `LIVEKIT_AGENT_NAME=nadia-seller` in Vercel unless you intentionally rename the worker.
