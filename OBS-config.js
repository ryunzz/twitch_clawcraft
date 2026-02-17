const express = require('express');
const crypto = require('crypto');
const { setTimeout: wait } = require('timers/promises');

let obsLibrary;
try {
  obsLibrary = require('obs-websocket-js');
} catch (error) {
  obsLibrary = null;
}

const OBSWebSocket = obsLibrary?.OBSWebSocket || obsLibrary?.default || null;
const app = express();

const PORT = Number(process.env.PORT || 3040);
const TOOL_SERVICE_TOKEN = process.env.TOOL_SERVICE_TOKEN || '';
const TOOL_SIGNING_SECRET = process.env.TOOL_SERVICE_SIGNATURE_SECRET || '';
const ACTION_RATE_LIMIT_PER_MIN = Number(process.env.TOOL_ACTION_RATE_LIMIT_PER_MIN || 60);
const TOOL_SERVICE_TIMEOUT_MS = Number(process.env.TOOL_SERVICE_TIMEOUT_MS || 25000);
const JOB_TTL_MS = Number(process.env.TOOL_JOB_TTL_MS || 120 * 60 * 1000);
const OBS_CONNECT_TIMEOUT_MS = Number(process.env.OBS_CONNECT_TIMEOUT_MS || 12000);
const OBS_OPERATION_TIMEOUT_MS = Number(process.env.OBS_STREAM_OPERATION_TIMEOUT_MS || 20000);
const OBS_STREAM_POLL_MS = Number(process.env.OBS_STREAM_POLL_MS || 700);
const OBS_OPERATION_RETRIES = Number(process.env.OBS_OPERATION_RETRIES || 2);
const OBS_WS_URL = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const OBS_STREAM_SCENE = process.env.OBS_STREAM_SCENE || '';

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_OAUTH_TOKEN = process.env.TWITCH_OAUTH_TOKEN || '';
const TWITCH_BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID || '';
const TWITCH_BROADCASTER_LOGIN = process.env.TWITCH_BROADCASTER_LOGIN || '';
const TWITCH_API_TIMEOUT_MS = Number(process.env.TWITCH_API_TIMEOUT_MS || 10000);
const TWITCH_API_RETRIES = Number(process.env.TWITCH_API_RETRIES || 2);

const TWITCH_TOOL_ACTIONS = Object.freeze([
  'twitch.start_stream',
  'twitch.stop_stream',
  'twitch.set_title',
  'twitch.set_game',
  'twitch.post_chat_message',
  'twitch.create_clip'
]);

const ASYNC_TOOL_ACTIONS = new Set([
  'twitch.start_stream',
  'twitch.stop_stream'
]);

const TWITCH_TOOL_SCHEMAS = {
  'twitch.start_stream': {
    required: ['channel'],
    allow: ['channel', 'title', 'game', 'game_id', 'obs_scene', 'quality'],
    fields: {
      channel: { type: 'string', minLength: 2, maxLength: 64 },
      title: { type: 'string', minLength: 1, maxLength: 160 },
      game: { type: 'string', minLength: 1, maxLength: 120 },
      game_id: { type: 'string', minLength: 1, maxLength: 80 },
      obs_scene: { type: 'string', minLength: 1, maxLength: 120 },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'source'] }
    }
  },
  'twitch.stop_stream': {
    required: [],
    allow: ['reason', 'channel'],
    fields: {
      reason: { type: 'string', minLength: 1, maxLength: 160 },
      channel: { type: 'string', minLength: 2, maxLength: 64 }
    }
  },
  'twitch.set_title': {
    required: ['title'],
    allow: ['title', 'channel'],
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 140 },
      channel: { type: 'string', minLength: 2, maxLength: 64 }
    }
  },
  'twitch.set_game': {
    required: [],
    allow: ['game', 'game_id', 'channel'],
    fields: {
      game: { type: 'string', minLength: 1, maxLength: 120 },
      game_id: { type: 'string', minLength: 1, maxLength: 80 },
      channel: { type: 'string', minLength: 2, maxLength: 64 }
    }
  },
  'twitch.post_chat_message': {
    required: ['message'],
    allow: ['message', 'channel', 'reply_parent_message_id'],
    fields: {
      message: { type: 'string', minLength: 1, maxLength: 500 },
      channel: { type: 'string', minLength: 2, maxLength: 64 },
      reply_parent_message_id: { type: 'string', minLength: 8, maxLength: 60 }
    }
  },
  'twitch.create_clip': {
    required: [],
    allow: ['title', 'channel'],
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      channel: { type: 'string', minLength: 2, maxLength: 64 }
    }
  }
};

const ACTION_TO_HANDLER = {
  'twitch.start_stream': 'startStream',
  'twitch.stop_stream': 'stopStream',
  'twitch.set_title': 'setTitle',
  'twitch.set_game': 'setGame',
  'twitch.post_chat_message': 'postChatMessage',
  'twitch.create_clip': 'createClip'
};

const jobs = new Map();
const idempotency = new Map();
const rateLimitByAction = new Map();

function nowIso() {
  return new Date().toISOString();
}

function normalizeBody(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

function isFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

async function withTimeout(label, fn, timeoutMs = TOOL_SERVICE_TIMEOUT_MS) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
  });
  const result = await Promise.race([fn(), timeoutPromise]);
  clearTimeout(timer);
  return result;
}

async function withRetry(fn, { retries = 0, delayMs = 250, label = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt + 1);
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }
      const waitMs = delayMs * Math.pow(2, attempt);
      await wait(waitMs);
    }
  }
  throw lastError;
}

function safeCompareHex(a = '', b = '') {
  const left = String(a).trim();
  const right = String(b).trim();
  if (left.length !== right.length || left.length < 16) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function requireToken(req, res, next) {
  if (!TOOL_SERVICE_TOKEN) return next();
  const token = req.get('authorization') || '';
  if (token !== `Bearer ${TOOL_SERVICE_TOKEN}`) {
    return res.status(401).json({ ok: false, error: 'missing or invalid bearer token' });
  }
  return next();
}

function requireSignature(req, res, next) {
  if (!TOOL_SIGNING_SECRET) return next();
  const header = req.get('x-tool-signature') || '';
  const expected = crypto.createHmac('sha256', TOOL_SIGNING_SECRET)
    .update(req.rawBody || Buffer.from('{}'))
    .digest('hex');
  const provided = String(header).replace(/^sha256=/, '');
  if (!safeCompareHex(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'invalid request signature' });
  }
  return next();
}

function canRunAction(action) {
  const now = Date.now();
  const limit = isFiniteNumber(ACTION_RATE_LIMIT_PER_MIN, 60);
  const bucket = rateLimitByAction.get(action) || { start: now, count: 0 };

  if (now - bucket.start >= 60_000) {
    bucket.start = now;
    bucket.count = 0;
  }

  if (bucket.count >= limit) {
    rateLimitByAction.set(action, bucket);
    return false;
  }

  bucket.count += 1;
  rateLimitByAction.set(action, bucket);
  return true;
}

function validateActionPayload(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'request body must be JSON object' };
  }

  const requestId = String(payload.request_id || '').trim() || null;
  const agentId = String(payload.agent_id || '').trim();
  const action = String(payload.action || '').trim();
  const args = normalizeBody(payload.args);
  const missionId = String(payload.mission_id || '').trim();
  const correlationId = String(payload.correlation_id || '').trim();

  if (!agentId || !/^[A-Za-z0-9._-]{2,120}$/.test(agentId)) {
    return { ok: false, error: 'agent_id must be 2-120 chars' };
  }
  if (!TWITCH_TOOL_ACTIONS.includes(action)) {
    return { ok: false, error: `Unsupported action "${action}"` };
  }

  const schema = TWITCH_TOOL_SCHEMAS[action];
  if (!schema) {
    return { ok: false, error: `Missing action schema for "${action}"` };
  }

  if (ASYNC_TOOL_ACTIONS.has(action) && !requestId && !(missionId || correlationId)) {
    return {
      ok: false,
      error: `request_id required for async action "${action}" when mission_id/correlation_id is missing`
    };
  }

  for (const key of Object.keys(args)) {
    if (!schema.allow.includes(key)) {
      return { ok: false, error: `Unexpected field "${key}" for action ${action}` };
    }
  }

  for (const required of schema.required) {
    const value = args[required];
    if (value === undefined || value === null || String(value).trim().length === 0) {
      return { ok: false, error: `Field "${required}" is required for action "${action}"` };
    }
  }

  for (const [field, constraints] of Object.entries(schema.fields)) {
    if (args[field] === undefined) continue;
    if (constraints.type === 'string') {
      if (typeof args[field] !== 'string') {
        return { ok: false, error: `Field "${field}" must be string` };
      }
      const value = args[field].trim();
      if (constraints.minLength && value.length < constraints.minLength) {
        return { ok: false, error: `Field "${field}" too short` };
      }
      if (constraints.maxLength && value.length > constraints.maxLength) {
        return { ok: false, error: `Field "${field}" too long` };
      }
      args[field] = value;
    }

    if (constraints.enum && !constraints.enum.includes(args[field])) {
      return { ok: false, error: `Field "${field}" has invalid value` };
    }
  }

  if (action === 'twitch.set_game' && !args.game && !args.game_id) {
    return { ok: false, error: 'twitch.set_game requires game or game_id' };
  }

  const normalized = {
    request_id: requestId || null,
    agent_id: agentId,
    action,
    args,
    mission_id: missionId || null,
    correlation_id: correlationId || null
  };

  return { ok: true, normalized };
}

function jobSummary(job) {
  return {
    id: job.id,
    action: job.action,
    status: job.status,
    progress: job.progress,
    request_id: job.request_id,
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

class JobStore {
  static buildProgress(percent, message) {
    return {
      percent,
      message,
      updatedAt: nowIso()
    };
  }

  static normalizeId(value, fallbackPrefix = 'job') {
    if (typeof value === 'string' && /^[\w.-]{4,120}$/.test(value.trim())) {
      return value.trim();
    }
    return `${fallbackPrefix}_${crypto.randomBytes(8).toString('hex')}`;
  }

  static createJob({
    action,
    requestId,
    agentId,
    missionId,
    correlationId,
    args
  }) {
    const id = this.normalizeId(null, 'tool');
    return {
      id,
      action,
      request_id: requestId,
      agent_id: agentId,
      mission_id: missionId,
      correlation_id: correlationId,
      args,
      status: 'queued',
      progress: this.buildProgress(5, 'queued'),
      result: {},
      created_at: nowIso(),
      updated_at: nowIso()
    };
  }

  static completeJob(job, result = {}, finalStatus = 'done', reason) {
    job.status = finalStatus;
    job.progress = this.buildProgress(100, finalStatus);
    job.result = {
      ...job.result,
      ...result
    };
    if (reason) {
      job.result.reason = reason;
    }
    job.updated_at = nowIso();
    return job;
  }

  static failJob(job, error) {
    job.status = 'failed';
    job.result = {
      ...(job.result || {}),
      error: String(error?.message || error || 'tool execution failed')
    };
    job.progress = this.buildProgress(100, 'failed');
    job.updated_at = nowIso();
    return job;
  }
}

class TwitchApiClient {
  constructor() {
    this.clientId = TWITCH_CLIENT_ID;
    this.oauthToken = TWITCH_OAUTH_TOKEN;
    this.defaultBroadcasterId = TWITCH_BROADCASTER_ID;
    this.defaultBroadcasterLogin = TWITCH_BROADCASTER_LOGIN;
    this.apiBase = 'https://api.twitch.tv/helix';
    this.validateCache = null;
    this.userCache = new Map();
    this.gameCache = new Map();
    this.channelCache = new Map();
  }

  isConfigured() {
    return Boolean(this.clientId && this.oauthToken);
  }

  buildAuthHeaders() {
    return {
      'client-id': this.clientId,
      authorization: `Bearer ${this.oauthToken}`
    };
  }

  async request(method, path, {
    query = {},
    body = null,
    baseUrl = this.apiBase
  } = {}) {
    if (!this.isConfigured()) {
      throw new Error('missing twitch credentials');
    }

    const endpoint = new URL(`${baseUrl.replace(/\/$/, '')}/${String(path || '').replace(/^\//, '')}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || String(value).trim().length === 0) continue;
      endpoint.searchParams.set(key, String(value));
    }

    const headers = {
      'content-type': body ? 'application/json' : 'application/json',
      ...this.buildAuthHeaders()
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort('twitch-api-timeout');
    }, TWITCH_API_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      const responseText = await response.text();
      let payload = null;
      try {
        payload = responseText ? JSON.parse(responseText) : null;
      } catch {
        payload = responseText ? { message: responseText } : null;
      }

      if (!response.ok) {
        const reason = payload?.message || payload?.error || response.statusText || 'twitch api error';
        const error = new Error(`${reason}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }

      return payload || {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async validateIdentity() {
    if (!this.isConfigured()) {
      return null;
    }

    const now = Date.now();
    if (this.validateCache && this.validateCache.expires_at > now) {
      return this.validateCache;
    }

    const response = await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort('twitch-validate-timeout');
      }, TWITCH_API_TIMEOUT_MS);
      try {
        const authResponse = await fetch('https://id.twitch.tv/oauth2/validate', {
          method: 'GET',
          headers: {
            authorization: `Bearer ${this.oauthToken}`
          },
          signal: controller.signal
        });
        const text = await authResponse.text();
        let parsed = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = {};
        }
        if (!authResponse.ok) {
          const reason = parsed?.message || authResponse.statusText || 'invalid twitch token';
          const error = new Error(reason);
          error.status = authResponse.status;
          error.payload = parsed;
          throw error;
        }
        return parsed;
      } finally {
        clearTimeout(timer);
      }
    }, { retries: TWITCH_API_RETRIES, delayMs: 500, label: 'twitch token validate' });

    this.validateCache = {
      user_id: response.user_id,
      login: response.login,
      user_name: response.user_name,
      scopes: response.scopes || [],
      expires_at: Date.now() + ((response.expires_in || 0) * 1000)
    };

    return this.validateCache;
  }

  async resolveBroadcasterId(channel) {
    const normalized = String(channel || '').trim().toLowerCase();
    if (this.defaultBroadcasterId && /^[0-9]+$/.test(this.defaultBroadcasterId)) {
      return this.defaultBroadcasterId;
    }
    if (normalized && this.channelCache.has(normalized)) {
      return this.channelCache.get(normalized);
    }
    if (normalized) {
      const data = await this.request('GET', '/users', { query: { login: normalized } });
      const found = Array.isArray(data?.data) ? data.data[0] : null;
      if (!found?.id) {
        throw new Error(`unable to resolve twitch broadcaster for channel ${normalized}`);
      }
      this.channelCache.set(normalized, found.id);
      return found.id;
    }

    const identity = await this.validateIdentity();
    if (!identity?.user_id) {
      throw new Error('missing broadcaster id in request and no service default configured');
    }
    return identity.user_id;
  }

  async resolveGameId(gameName, broadcasterId) {
    const normalized = String(gameName || '').trim();
    if (!normalized) return null;
    const cached = this.gameCache.get(normalized.toLowerCase());
    if (cached) return cached;

    const data = await this.request('GET', '/games', { query: { name: normalized } });
    const game = Array.isArray(data?.data) ? data.data[0] : null;
    if (!game?.id) {
      throw new Error(`unable to resolve game "${normalized}"`);
    }
    const gameId = game.id;
    this.gameCache.set(normalized.toLowerCase(), gameId);
    return gameId;
  }

  async setChannelMetadata(args = {}) {
    const { channel, title, game, game_id } = args;
    const broadcasterId = await this.resolveBroadcasterId(channel);

    const payload = {};
    if (title) payload.title = title;
    if (game_id || game) {
      const resolvedGameId = game_id || await this.resolveGameId(game);
      if (resolvedGameId) {
        payload.game_id = resolvedGameId;
      }
    }

    if (Object.keys(payload).length === 0) {
      return { status: 'skipped', reason: 'no metadata changes requested' };
    }

    const response = await this.request('PATCH', '/channels', {
      query: { broadcaster_id: broadcasterId },
      body: payload
    });

    return {
      status: 'updated',
      broadcaster_id: broadcasterId,
      payload,
      response
    };
  }

  async setTitle({ channel, title }) {
    if (!title) {
      return { status: 'skipped', reason: 'no title provided' };
    }
    return this.setChannelMetadata({ channel, title });
  }

  async setGame({ channel, game, game_id }) {
    if (!game && !game_id) {
      return { status: 'skipped', reason: 'no game provided' };
    }
    const payload = { channel, game, game_id };
    return this.setChannelMetadata(payload);
  }

  async sendChatMessage({ channel, message, reply_parent_message_id }) {
    const broadcasterId = await this.resolveBroadcasterId(channel);
    const identity = await this.validateIdentity();
    const senderId = identity?.user_id;
    if (!senderId) {
      throw new Error('could not resolve chat sender id from token');
    }

    const body = {
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message
    };
    if (reply_parent_message_id) {
      body.reply_parent_message_id = reply_parent_message_id;
    }

    const response = await this.request('POST', '/chat/messages', { body });
    return {
      status: 'posted',
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      payload: response
    };
  }

  async createClip({ channel }) {
    const broadcasterId = await this.resolveBroadcasterId(channel);
    const response = await this.request('POST', '/clips', {
      query: { broadcaster_id: broadcasterId }
    });

    const clip = Array.isArray(response?.data) ? response.data[0] : null;
    if (!clip?.id) {
      return {
        status: 'created',
        broadcaster_id: broadcasterId,
        payload: response
      };
    }

    return {
      status: 'created',
      clip_id: clip.id,
      edit_url: clip.edit_url,
      broadcaster_id: broadcasterId
    };
  }
}

class OBSStreamController {
  constructor() {
    this.wsUrl = OBS_WS_URL;
    this.password = OBS_WS_PASSWORD;
    this.obs = OBSWebSocket ? new OBSWebSocket() : null;
    this.connected = false;
    this.connecting = null;
    this.setupEvents();
  }

  isConfigured() {
    return Boolean(this.obs && this.wsUrl);
  }

  setupEvents() {
    if (!this.obs || this.__wired) return;
    this.obs.on('ConnectionClosed', () => {
      this.connected = false;
    });
    this.obs.on('ConnectionOpened', () => {
      this.connected = true;
    });
    this.obs.on('ConnectionError', () => {
      this.connected = false;
    });
    this.__wired = true;
  }

  async connect() {
    if (!this.isConfigured()) {
      throw new Error('OBS websocket dependency is not installed or OBS URL is missing');
    }
    if (this.connected) {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = (async () => {
      try {
        await withTimeout('obs connect', async () => {
          await withRetry(
            async () => {
              const connectArgs = [this.wsUrl];
              if (this.password) connectArgs.push(this.password);
              await this.obs.connect(...connectArgs);
            },
            {
              retries: OBS_OPERATION_RETRIES,
              delayMs: 500,
              label: 'obs websocket connect'
            }
          );
        }, OBS_CONNECT_TIMEOUT_MS);
        this.connected = true;
      } finally {
        this.connecting = null;
      }
    })();

    return this.connecting;
  }

  async call(requestType, requestData = {}) {
    await this.connect();
    return this.obs.call(requestType, requestData);
  }

  normalizeStreamState(response) {
    const active = Boolean(
      response?.outputActive ??
      response?.streaming ??
      response?.outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED'
    );
    return {
      active,
      outputState: response?.outputState || (active ? 'started' : 'stopped'),
      outputDuration: response?.outputDuration,
      outputTimecode: response?.outputTimecode,
      raw: response
    };
  }

  async getStreamState() {
    try {
      const status = await this.call('GetStreamStatus');
      return this.normalizeStreamState(status);
    } catch {
      const status = await this.call('GetStreamingStatus');
      return this.normalizeStreamState(status);
    }
  }

  async ensureStreamState(targetActive, actionLabel) {
    const startedAt = Date.now();
    let lastState = null;

    while (Date.now() - startedAt < OBS_OPERATION_TIMEOUT_MS) {
      lastState = await this.getStreamState();
      if (lastState.active === targetActive) {
        return lastState;
      }
      await wait(OBS_STREAM_POLL_MS);
    }

    const state = lastState?.outputState || (targetActive ? 'started' : 'stopped');
    throw new Error(`timed out while waiting for OBS to ${actionLabel} (state=${state})`);
  }

  async setScene(sceneName) {
    if (!sceneName) return;
    try {
      await this.call('SetCurrentProgramScene', { sceneName });
    } catch (error) {
      if (error?.code === '404' || /No scene/.test(error?.message || '')) {
        throw new Error(`obs scene not found: ${sceneName}`);
      }
      throw error;
    }
  }

  async startStream(args = {}) {
    await this.setScene(args.obs_scene || OBS_STREAM_SCENE);
    const before = await this.getStreamState();
    if (before.active) {
      return {
        status: 'already_running',
        stream: before
      };
    }
    await withRetry(
      async () => {
        await this.call('StartStream');
      },
      {
        retries: OBS_OPERATION_RETRIES,
        delayMs: 500,
        label: 'obs start'
      }
    );
    const after = await this.ensureStreamState(true, 'start');
    return {
      status: 'running',
      stream: after
    };
  }

  async stopStream() {
    const before = await this.getStreamState();
    if (!before.active) {
      return {
        status: 'already_stopped',
        stream: before
      };
    }

    await withRetry(
      async () => {
        await this.call('StopStream');
      },
      {
        retries: OBS_OPERATION_RETRIES,
        delayMs: 500,
        label: 'obs stop'
      }
    );

    const after = await this.ensureStreamState(false, 'stop');
    return {
      status: 'stopped',
      stream: after
    };
  }
}

class TwitchStreamRuntime {
  constructor() {
    this.sessions = new Map();
    this.obs = new OBSStreamController();
    this.twitch = new TwitchApiClient();
    this.jobLock = new Map();
  }

  _getSession(agentId) {
    if (!agentId || typeof agentId !== 'string') {
      return null;
    }
    return this.sessions.get(agentId) || {
      state: 'idle',
      metadata: {},
      updated_at: nowIso()
    };
  }

  _setSession(agentId, session) {
    const next = {
      ...session,
      updated_at: nowIso()
    };
    this.sessions.set(agentId, next);
    return next;
  }

  async _withActionLock(agentId, action) {
    const prior = this.jobLock.get(agentId) || Promise.resolve();
    let release = null;
    const next = prior.then(async () => {
      try {
        return await action();
      } finally {
        if (this.jobLock.get(agentId) === next) {
          this.jobLock.delete(agentId);
        }
      }
    });
    release = next;
    this.jobLock.set(agentId, next);
    return next;
  }

  async _setMetadata(channel, metadata) {
    if (!this.twitch.isConfigured()) {
      return {
        status: 'skipped',
        reason: 'twitch metadata update skipped: missing twitch credentials'
      };
    }

    const hasMetadata = Boolean(metadata?.title || metadata?.game || metadata?.game_id);
    if (!hasMetadata) {
      return {
        status: 'skipped',
        reason: 'no metadata provided'
      };
    }

    return this.twitch.setChannelMetadata({
      channel,
      title: metadata.title,
      game: metadata.game,
      game_id: metadata.game_id
    });
  }

  async startStream(agentId, args = {}) {
    return this._withActionLock(agentId, async () => {
      const session = this._getSession(agentId);
      if (session.state === 'starting') {
        return {
          status: 'running',
          reason: 'start already in progress for this agent'
        };
      }

      session.state = 'starting';
      this._setSession(agentId, session);

      try {
        const metadata = await this._setMetadata(args.channel, {
          title: args.title,
          game: args.game,
          game_id: args.game_id
        });

        const result = await withTimeout('start stream', () => this.obs.startStream(args), OBS_OPERATION_TIMEOUT_MS);
        const mergedState = {
          ...result,
          channel: args.channel,
          metadata
        };
        session.state = 'running';
        session.metadata = {
          ...(session.metadata || {}),
          channel: args.channel,
          title: args.title || session.metadata?.title || null,
          game: args.game || session.metadata?.game || null,
          game_id: args.game_id || session.metadata?.game_id || null,
          stream_started_at: nowIso()
        };
        this._setSession(agentId, session);
        return mergedState;
      } catch (error) {
        session.state = 'failed';
        this._setSession(agentId, session);
        throw error;
      }
    });
  }

  async stopStream(agentId, args = {}) {
    return this._withActionLock(agentId, async () => {
      const session = this._getSession(agentId);
      if (session.state === 'stopping') {
        return {
          status: 'stopped',
          reason: 'stop already in progress for this agent'
        };
      }

      session.state = 'stopping';
      this._setSession(agentId, session);

      try {
        const result = await withTimeout('stop stream', () => this.obs.stopStream(), OBS_OPERATION_TIMEOUT_MS);
        session.state = 'stopped';
        session.stream_stopped_at = nowIso();
        this._setSession(agentId, session);
        return result;
      } catch (error) {
        session.state = 'failed';
        this._setSession(agentId, session);
        throw error;
      }
    });
  }

  async setTitle(agentId, args = {}) {
    return this._withActionLock(agentId, () =>
      withTimeout(
        'set_title',
        () => this.twitch.setTitle(args),
        OBS_OPERATION_TIMEOUT_MS
      )
    );
  }

  async setGame(agentId, args = {}) {
    return this._withActionLock(agentId, () =>
      withTimeout(
        'set_game',
        () => this.twitch.setGame(args),
        OBS_OPERATION_TIMEOUT_MS
      )
    );
  }

  async postChatMessage(agentId, args = {}) {
    return this._withActionLock(agentId, () =>
      withTimeout(
        'post_chat_message',
        () => this.twitch.sendChatMessage(args),
        OBS_OPERATION_TIMEOUT_MS
      )
    );
  }

  async createClip(agentId, args = {}) {
    return this._withActionLock(agentId, () =>
      withTimeout(
        'create_clip',
        () => this.twitch.createClip(args),
        OBS_OPERATION_TIMEOUT_MS
      )
    );
  }
}

const streamRuntime = new TwitchStreamRuntime();

async function executeAsyncToolAction(job, action, args, agentId) {
  job.status = 'running';
  job.progress = JobStore.buildProgress(20, `${action} started`);
  try {
    const method = ACTION_TO_HANDLER[action];
    if (!method || typeof streamRuntime[method] !== 'function') {
      throw new Error(`No handler mapped for action "${action}"`);
    }

    const response = await withRetry(
      async () => {
        job.progress = JobStore.buildProgress(45, `${action} in progress`);
        const started = Date.now();
        try {
          return await streamRuntime[method](agentId, args);
        } finally {
          if (Date.now() - started > 0 && action === 'twitch.start_stream') {
            job.progress = JobStore.buildProgress(70, 'stream state updated');
          }
        }
      },
      {
        retries: 0,
        delayMs: 400,
        label: `retry ${action}`
      }
    );

    if (response?.status === 'failed') {
      throw new Error(response.error || 'tool action failed');
    }

    job.status = 'done';
    job.result = {
      status: response?.status || 'done',
      request_id: job.request_id,
      action_response: response
    };
    job.progress = JobStore.buildProgress(100, `${action} finished`);
    job.updated_at = nowIso();
  } catch (error) {
    JobStore.failJob(job, error);
  }
}

function createSyncResult(action, args, agentId) {
  const method = ACTION_TO_HANDLER[action];
  const handler = method ? streamRuntime[method] : null;
  if (typeof handler !== 'function') {
    return {
      status: 'failed',
      error: `Unsupported tool action "${action}"`
    };
  }

  return withTimeout(action, () => handler.call(streamRuntime, agentId, args), TOOL_SERVICE_TIMEOUT_MS)
    .then((result) => ({
      status: result?.status || 'done',
      ...result
    }))
    .catch((error) => ({
      status: 'failed',
      error: String(error?.message || error)
    }));
}

app.use(express.json({
  limit: '512kb',
  verify(req, res, buf) {
    req.rawBody = buf;
  }
}));
app.use(requireToken);
app.use(requireSignature);

app.get('/health', (_req, res) => {
  const obsConfigured = Boolean(OBSWebSocket);
  res.json({
    ok: true,
    service: 'twitch-clawcraft',
    obs: {
      configured: obsConfigured,
      url: OBS_WS_URL || null,
      default_scene: OBS_STREAM_SCENE || null,
      connected: streamRuntime?.obs?.connected || false
    },
    twitch: {
      configured: streamRuntime?.twitch?.isConfigured(),
      default_channel: streamRuntime?.twitch?.defaultBroadcasterLogin || streamRuntime?.twitch?.defaultBroadcasterId
    }
  });
});

app.get('/tools/jobs/:id', (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'job not found' });
  }
  return res.json({ ok: true, job });
});

app.post('/tools/execute', async (req, res) => {
  const validated = validateActionPayload(req.body || {});
  if (!validated.ok) {
    return res.status(400).json({ ok: false, error: validated.error });
  }
  if (!canRunAction(validated.normalized.action)) {
    return res.status(429).json({ ok: false, error: 'rate limit exceeded for action' });
  }

  const action = validated.normalized.action;
  const args = validated.normalized.args;
  const agentId = validated.normalized.agent_id;
  const idempotencySeed = validated.normalized.request_id
    || validated.normalized.mission_id
    || validated.normalized.correlation_id
    || `${action}:${agentId}`;
  const requestId = validated.normalized.request_id
    ? JobStore.normalizeId(validated.normalized.request_id, 'req')
    : `req_${crypto.createHash('sha1')
      .update(`async|${idempotencySeed}|${action}|${agentId}`)
      .digest('hex')
      .slice(0, 18)}`;
  const correlationId = validated.normalized.correlation_id || validated.normalized.mission_id;

  if (ASYNC_TOOL_ACTIONS.has(action)) {
    const idempotencyKey = `${action}:${requestId}`;
    const existingJobId = idempotency.get(idempotencyKey);
    if (existingJobId) {
      const existingJob = jobs.get(existingJobId);
      if (existingJob) {
        return res.status(202).json({ ok: true, action, result: jobSummary(existingJob) });
      }
      idempotency.delete(idempotencyKey);
    }

    const job = JobStore.createJob({
      action,
      requestId,
      agentId,
      missionId: validated.normalized.mission_id,
      correlationId,
      args
    });
    jobs.set(job.id, job);
    idempotency.set(idempotencyKey, job.id);

    executeAsyncToolAction(job, action, args, agentId).catch(() => {});

    return res.status(202).json({
      ok: true,
      action,
      result: {
        job_id: job.id,
        status: job.status,
        progress: job.progress,
        request_id: requestId
      }
    });
  }

  try {
    const result = await createSyncResult(action, args, agentId);
    return res.status(result.status === 'failed' ? 500 : 200).json({
      ok: result.status !== 'failed',
      action,
      result: {
        request_id: requestId,
        ...result
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      action,
      error: String(error.message || error)
    });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const createdAt = Date.parse(job.created_at || 0);
    if (Number.isFinite(createdAt) && now - createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
  for (const [key, value] of idempotency) {
    const job = jobs.get(value);
    if (!job) idempotency.delete(key);
  }
}, 60_000);

app.listen(PORT, () => {
  console.log(`twitch-clawcraft tool service listening on :${PORT}`);
});
