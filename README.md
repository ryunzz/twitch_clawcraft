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

## Quick start

```bash
npm install
npm start
```

Set environment values before starting:

```bash
cp .env.example .env
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | no | HTTP port (default `3040`). |
| `TOOL_SERVICE_TOKEN` | no | Bearer token for `/tools/execute` and job routes. |
| `TOOL_SERVICE_SIGNATURE_SECRET` | no | If set, requires `x-tool-signature` HMAC for each execute request. |
| `TOOL_ACTION_RATE_LIMIT_PER_MIN` | no | Requests per minute per action (default `60`). |
| `TOOL_SERVICE_TIMEOUT_MS` | no | Stream action timeout before marking failed (default `20000`). |
| `TOOL_JOB_TTL_MS` | no | Time jobs are retained (default `3600000`). |
| `TOOL_OPERATION_STEP_MS` | no | Simulation step delay used by placeholder stream runtime (default `600`). |
| `TWITCH_CLIENT_ID` | optional | Reserved for OBS/Twitch integration wiring. |
| `TWITCH_OAUTH_TOKEN` | optional | Reserved for OBS/Twitch integration wiring. |
| `TWITCH_CHANNEL` | optional | Reserved for OBS/Twitch integration wiring. |
| `OBS_WS_URL` | optional | Reserved for OBS websocket integration. |
| `OBS_WS_PASSWORD` | optional | Reserved for OBS websocket integration. |

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
