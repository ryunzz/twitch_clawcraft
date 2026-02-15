# twitch-clawcraft

Standalone Twitch tool service for OpenClaw bot runtimes.

## What it does

- Exposes `POST /tools/execute` for tool actions.
- Exposes `GET /tools/jobs/:id` for async job state.
- Accepts request shape:
  - `request_id`
  - `agent_id`
  - `action`
  - `args`
  - `mission_id`
  - `correlation_id`
- Supports `twitch.start_stream`, `twitch.stop_stream`, `twitch.set_title`, `twitch.set_game`, optional `twitch.post_chat_message`, `twitch.create_clip`.
- Returns immediate job IDs for async actions (`start_stream`, `stop_stream`).
- Maintains job state (`queued`, `running`, `done`, `failed`).
- Supports token auth and optional request signing.
- Includes per-action rate limiting and request schema validation.
- Adds real OBS websocket stream control for `start_stream` and `stop_stream`.

## Quick start

```bash
npm install
npm start
```

Set environment values before starting:

```bash
cp .env.example .env
```

Install OBS and enable websocket server access.
- Default port is `4455` on OBS v5.
- Set OBS scene and stream profile in OBS manually.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | HTTP port (default `3040`). |
| `TOOL_SERVICE_TOKEN` | no | Bearer token for `/tools/execute` and job routes. |
| `TOOL_SERVICE_SIGNATURE_SECRET` | no | If set, requires `x-tool-signature` HMAC for each execute request. |
| `TOOL_ACTION_RATE_LIMIT_PER_MIN` | no | Requests per minute per action (default `60`). |
| `TOOL_SERVICE_TIMEOUT_MS` | no | Stream action timeout before marking failed (default `25000`). |
| `OBS_STREAM_OPERATION_TIMEOUT_MS` | no | OBS state wait timeout for start/stop (default `20000`). |
| `TOOL_JOB_TTL_MS` | no | Time jobs are retained (default `7200000`). |
| `OBS_WS_URL` | no | OBS websocket URL (for example `ws://127.0.0.1:4455`). |
| `OBS_WS_PASSWORD` | no | OBS websocket password. |
| `OBS_CONNECT_TIMEOUT_MS` | no | OBS websocket connect timeout (default `12000`). |
| `OBS_STREAM_POLL_MS` | no | Poll interval for stream state checks (default `700`). |
| `OBS_OPERATION_RETRIES` | no | Retry count for OBS start/stop commands (default `2`). |
| `OBS_STREAM_SCENE` | no | Optional default scene name before stream start. |
| `TWITCH_CLIENT_ID` | optional | Twitch Helix API client id. |
| `TWITCH_OAUTH_TOKEN` | optional | Twitch OAuth token for metadata/chat/clip calls. |
| `TWITCH_BROADCASTER_ID` | optional | Preferred broadcaster numeric user id fallback. |
| `TWITCH_BROADCASTER_LOGIN` | optional | Preferred broadcaster login fallback. |
| `TWITCH_API_TIMEOUT_MS` | no | Twitch API timeout (default `10000`). |
| `TWITCH_API_RETRIES` | no | Twitch API retry count (default `2`). |
 

> Note: this service currently targets OBS websocket control for real streaming.
> Twitch chat and clip behavior depends on the exact scopes for your token.

## API examples

### Start stream

`POST /tools/execute`

```json
{
  "request_id": "startstream-mission-1",
  "agent_id": "openclaw-operator-01",
  "action": "twitch.start_stream",
  "args": {
    "channel": "clawcraft",
    "title": "OpenClaw on the mine",
    "game": "Minecraft"
  },
  "mission_id": "mission-123",
  "correlation_id": "corr-abc"
}
```

Response:

```json
{
  "ok": true,
  "action": "twitch.start_stream",
  "result": {
    "job_id": "tool_xxx",
    "status": "queued",
    "progress": {
      "percent": 5,
      "message": "queued"
    },
    "request_id": "startstream-mission-1"
  }
}
```

## How authentication is handled (important)

- OpenClaw does **not** need Twitch username/password or OAuth session credentials.
- Twitch session credentials live only in this service via `TWITCH_CLIENT_ID` and `TWITCH_OAUTH_TOKEN`.
- Your OpenClaw bot only needs `TOOL_SERVICE_TOKEN` access to this service endpoint.
- `start_stream`/`stop_stream` failures are surfaced through job status and do not crash the mission by default.

## Quick validation steps

1. Start OBS, enable its websocket, and verify a manual start/stop stream works in OBS.
2. Start this service with valid env vars and a bearer token.
3. Run:

```bash
curl -X POST http://localhost:3040/tools/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOOL_SERVICE_TOKEN>" \
  -d '{
    "request_id":"stream-test-1",
    "agent_id":"bot-01",
    "action":"twitch.start_stream",
    "args":{"channel":"your_channel","title":"OpenClaw bot stream"}
  }'
```

4. Poll `/tools/jobs/<job_id>` until status is `done`.
5. Validate in Twitch that the stream appears live and metadata matches expected title/game.

### Set title

`POST /tools/execute`

```json
{
  "request_id": "set-title-mission-2",
  "agent_id": "openclaw-operator-01",
  "action": "twitch.set_title",
  "args": {
    "title": "Building in the Nether"
  }
}
```

### Poll job status

`GET /tools/jobs/{job_id}`

```json
{
  "ok": true,
  "job": {
    "id": "tool_xxx",
    "action": "twitch.start_stream",
    "status": "running",
    "progress": {
      "percent": 45,
      "message": "twitch.start_stream in progress"
    }
  }
}
```

## Contract

See `openapi/tools-api.yaml` for full contract.

## Security notes

- Keep `TOOL_SERVICE_TOKEN` strong.
- If using signing, runtime must include `x-tool-signature` with:

```js
hmacSha256(secret, rawBodyJson)
```

- Validate mission allowlists in runtime `tool_policy` before allowing these actions.
