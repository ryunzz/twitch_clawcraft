# Twitch streaming service implementation notes

## Assumptions before shipping

1. **OpenClaw does not hold Twitch credentials.** OpenClaw sends tool actions only (`request_id`, `agent_id`, `action`, `args`, `mission_id`, `correlation_id`).
2. **Streaming is delegated to OBS on the tool host.** This service calls OBS WebSocket `StartStream` / `StopStream`; OBS is responsible for RTMP target, encoder, bitrate, key, and Twitch ingest settings.
3. **OBS and stream profiles are pre-configured.** This service only switches scene (optional) and toggles streaming state.
4. **`channel` is resolved server-side.** `channel` is optional for metadata/chat/clip actions when `TWITCH_BROADCASTER_*` is set or token identity is valid.
5. **OAuth scope is owned by this service only.** OpenClaw does not need Twitch OAuth.

## Twitch auth model for this repo

- OpenClaw runtime calls:
  - `POST /tools/execute`
  - `GET /tools/jobs/:id`
- This service requires `TOOL_SERVICE_TOKEN` and optional `x-tool-signature`.
- OBS stream state is controlled by `OBS_WS_URL` / `OBS_WS_PASSWORD`.
- Twitch API calls for metadata/chat/clip use:
  - `TWITCH_CLIENT_ID`
  - `TWITCH_OAUTH_TOKEN`
- For user-owned calls (`set_title`, `set_game`, `post_chat_message`, `create_clip`), the token must be a Twitch user token with scopes that match each endpoint.

### Minimal required Twitch token scopes

- Channel metadata: `channel:manage:broadcast`
- Chat messages: `user:write:chat` (legacy/modern chat endpoint requirements vary by API version)
- Clip creation: `clips:edit`

If these scopes are missing, calls fail with explicit Twitch API errors; streaming start/stop still works if OBS is healthy.

## Why this creates a real live output

- `twitch.start_stream` calls `OBS.startStream`.
- `twitch.stop_stream` calls `OBS.stopStream`.
- Job APIs return `queued -> running -> done/failed` with percent/progress updates so OpenClaw can poll.
- `title`/`game` are applied through Twitch Helix metadata updates before stream start when provided.

This is still not a bot RTMP/ffmpeg implementation; it is controller-only and expects OBS to own encoding/transmission.

## Contract-first and allowlist enforcement

Local action handlers are replaced by a strict dispatch map:

- Allowed actions:
  - `twitch.start_stream`
  - `twitch.stop_stream`
  - `twitch.set_title`
  - `twitch.set_game`
  - `twitch.post_chat_message` (optional)
  - `twitch.create_clip` (optional)
- Unknown actions are rejected before execution.
- Each action has a hard schema (`allowlist + type/size constraints`), so arbitrary shell arguments are impossible.
- Async actions are executed in background jobs with idempotency keys.

## Runtime behavior details

- Sync actions return inline errors instead of being hidden behind job success.
- Async actions use request-level idempotency:
  - Primary key: `request_id` (if provided)
  - Fallback key: action + agent + mission/correlation to avoid duplicate fan-out from retried callers.
- OBS and Twitch calls are retried with bounded backoff.
- Per-action rate limit remains enforced server-side.

## Local dry-run and rollout

### 1) Local dry-run
- Run with OBS + Twitch creds disabled.
- Verify:
  - request validation (required fields, allowlist, request shape)
  - job creation/polling
  - deterministic failure responses for missing stream/Twitch env.
- Then add OBS + Twitch creds in a non-production environment.

### 2) Staging integration test (simulated executor)
- Keep OpenClaw mission tool bridge pointed at staging `twitch-clawcraft`.
- Use an instrumentation mission that emits:
  - `start_stream` (job polling)
  - `set_title`
  - `stop_stream` (job polling)
- Assertions:
  - 202 for async actions
  - final job status transitions
  - idempotency on repeated `request_id`
  - no core-mission crash when tool call fails.

### 3) Production hardening checklist
- Run OBS and token creds from a secret store, not `.env` checked into VCS.
- Restrict `TWITCH_OAUTH_TOKEN` to least-privilege scopes.
- Lock service token to private network / service mesh rules.
- Enable request signing (`TOOL_SERVICE_SIGNATURE_SECRET`) for every tool POST.
- Add observability (structured logs for action, request_id, mission_id, correlation_id, duration, status).
- Enforce stricter egress/network ACLs for Twitch API and OBS websocket.
- Add alerting on `failed`/timeout job spike.
