const express = require('express');
const crypto = require('crypto');
const { setTimeout: wait } = require('timers/promises');

const app = express();
const PORT = Number(process.env.PORT || 3040);
const TOOL_SERVICE_TOKEN = process.env.TOOL_SERVICE_TOKEN || '';
const TOOL_SIGNING_SECRET = process.env.TOOL_SERVICE_SIGNATURE_SECRET || '';
const ACTION_RATE_LIMIT_PER_MIN = Number(process.env.TOOL_ACTION_RATE_LIMIT_PER_MIN || 60);
const TOOL_SERVICE_TIMEOUT_MS = Number(process.env.TOOL_SERVICE_TIMEOUT_MS || 20000);
const JOB_TTL_MS = Number(process.env.TOOL_JOB_TTL_MS || 120 * 60 * 1000);
const OPERATION_STEP_MS = Number(process.env.TOOL_OPERATION_STEP_MS || 600);

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
    allow: ['channel', 'title', 'game', 'quality'],
    fields: {
      channel: { type: 'string', minLength: 1, maxLength: 64 },
      title: { type: 'string', minLength: 1, maxLength: 120 },
      game: { type: 'string', minLength: 1, maxLength: 80 },
      quality: { type: 'string', enum: ['low', 'medium', 'high', 'source'] }
    }
  },
  'twitch.stop_stream': {
    required: [],
    allow: ['reason'],
    fields: {
      reason: { type: 'string', minLength: 1, maxLength: 160 }
    }
  },
  'twitch.set_title': {
    required: ['title'],
    allow: ['title'],
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 140 }
    }
  },
  'twitch.set_game': {
    required: ['game'],
    allow: ['game'],
    fields: {
      game: { type: 'string', minLength: 1, maxLength: 100 }
    }
  },
  'twitch.post_chat_message': {
    required: ['message'],
    allow: ['message'],
    fields: {
      message: { type: 'string', minLength: 1, maxLength: 250 }
    }
  },
  'twitch.create_clip': {
    required: [],
    allow: ['title'],
    fields: {
      title: { type: 'string', minLength: 1, maxLength: 100 }
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

class TwitchStreamRuntime {
  constructor() {
    this.sessions = new Map();
  }

  _getSession(agentId) {
    return this.sessions.get(agentId) || { state: 'stopped', metadata: {} };
  }

  _setSession(agentId, updates = {}) {
    const session = {
      ...this._getSession(agentId),
      ...updates,
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(agentId, session);
    return session;
  }

  async startStream(agentId, payload = {}) {
    const { channel, title, game } = payload;
    const current = this._getSession(agentId);
    if (current.state === 'running') return { status: 'running', metadata: current.metadata };
    this._setSession(agentId, { state: 'starting', metadata: { channel, title, game } });
    await wait(OPERATION_STEP_MS);
    this._setSession(agentId, {
      state: 'running',
      metadata: {
        ...(current.metadata || {}),
        channel,
        title,
        game
      }
    });
    return { status: 'running', metadata: this._getSession(agentId).metadata };
  }

  async stopStream(agentId) {
    const current = this._getSession(agentId);
    if (current.state === 'stopped') return { status: 'stopped', metadata: current.metadata };
    this._setSession(agentId, { state: 'stopping', metadata: current.metadata || {} });
    await wait(OPERATION_STEP_MS);
    this._setSession(agentId, { state: 'stopped', metadata: {} });
    return { status: 'stopped', metadata: {} };
  }

  async setTitle(agentId, { title }) {
    const current = this._getSession(agentId);
    this._setSession(agentId, {
      state: current.state,
      metadata: { ...(current.metadata || {}), title }
    });
    await wait(OPERATION_STEP_MS / 2);
    return { status: current.state === 'running' ? 'running' : 'updated', metadata: this._getSession(agentId).metadata };
  }

  async setGame(agentId, { game }) {
    const current = this._getSession(agentId);
    this._setSession(agentId, {
      state: current.state,
      metadata: { ...(current.metadata || {}), game }
    });
    await wait(OPERATION_STEP_MS / 2);
    return { status: current.state === 'running' ? 'running' : 'updated', metadata: this._getSession(agentId).metadata };
  }

  async postChatMessage(_agentId, _payload) {
    await wait(OPERATION_STEP_MS / 2);
    return { status: 'posted' };
  }

  async createClip(_agentId, _payload) {
    await wait(OPERATION_STEP_MS);
    const clipId = `clip_${Date.now()}`;
    return { status: 'created', clip_id: clipId, clip_url: `https://clips.twitch.tv/${clipId}` };
  }
}

const streamRuntime = new TwitchStreamRuntime();

class JobStore {
  static buildProgress(percent, message) {
    return {
      percent,
      message,
      updatedAt: new Date().toISOString()
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
      status: 'queued',
      progress: this.buildProgress(5, 'queued'),
      result: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
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
    job.updated_at = new Date().toISOString();
    return job;
  }

  static failJob(job, error) {
    job.status = 'failed';
    job.result = {
      ...(job.result || {}),
      error: String(error?.message || error || 'tool execution failed')
    };
    job.progress = this.buildProgress(100, 'failed');
    job.updated_at = new Date().toISOString();
    return job;
  }
}

function normalizeBody(value) {
  return typeof value === 'object' && value !== null ? value : {};
}

function withTimeout(label, fn) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out`)), TOOL_SERVICE_TIMEOUT_MS);
    })
  ]);
}

function validateActionPayload(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'request body must be JSON object' };
  }

  const requestId = String(payload.request_id || '').trim() || null;
  const agentId = String(payload.agent_id || '').trim();
  const action = String(payload.action || '').trim();
  const args = normalizeBody(payload.args);

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

  return {
    ok: true,
    normalized: {
      request_id: requestId || null,
      agent_id: agentId,
      action,
      args,
      mission_id: String(payload.mission_id || '').trim() || null,
      correlation_id: String(payload.correlation_id || '').trim() || null
    }
  };
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
  const expected = crypto.createHmac('sha256', TOOL_SIGNING_SECRET).update(req.rawBody || Buffer.from('{}')).digest('hex');
  const provided = String(header).replace(/^sha256=/, '');
  if (!safeCompareHex(provided, expected)) {
    return res.status(401).json({ ok: false, error: 'invalid request signature' });
  }
  return next();
}

function canRunAction(action) {
  const now = Date.now();
  const limit = isFinite(ACTION_RATE_LIMIT_PER_MIN) ? ACTION_RATE_LIMIT_PER_MIN : 60;
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

function setJobResult(job, result = {}) {
  job.result = {
    ...job.result,
    ...result
  };
  job.updated_at = new Date().toISOString();
}

async function executeAsyncToolAction(job, action, args, agentId) {
  job.status = 'running';
  job.progress = JobStore.buildProgress(20, `${action} started`);
  try {
    job.progress = JobStore.buildProgress(45, `${action} in progress`);
    const method = ACTION_TO_HANDLER[action];
    if (!method || typeof streamRuntime[method] !== 'function') {
      throw new Error(`No handler mapped for action "${action}"`);
    }
    const response = await withTimeout(action, () => streamRuntime[method](agentId, args));
    job.status = 'done';
    job.progress = JobStore.buildProgress(100, `${action} finished`);
    job.result = {
      status: response.status || 'done',
      request_id: job.request_id,
      action_response: response
    };
    job.updated_at = new Date().toISOString();
    return job;
  } catch (error) {
    JobStore.failJob(job, error);
    return job;
  }
}

function createSyncResult(action, args, agentId) {
  const method = ACTION_TO_HANDLER[action];
  const normalized = method ? streamRuntime[method] : null;
  if (typeof normalized !== 'function') {
    return {
      status: 'failed',
      error: `Unsupported tool action "${action}"`
    };
  }
  return withTimeout(action, async () => normalized.call(streamRuntime, agentId, args))
    .then((result) => ({ status: 'done', action_response: result }))
    .catch((error) => ({ status: 'failed', reason: String(error.message || error) }));
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
  res.json({ ok: true, service: 'twitch-clawcraft' });
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
  const requestId = JobStore.normalizeId(validated.normalized.request_id || 'auto', 'req');
  const correlationId = validated.normalized.correlation_id || validated.normalized.mission_id;

  if (ASYNC_TOOL_ACTIONS.has(action)) {
    const idempotencyKey = `${action}:${requestId}`;
    const existingJobId = idempotency.get(idempotencyKey);
    if (existingJobId) {
      const existingJob = jobs.get(existingJobId);
      if (existingJob) {
        return res.status(202).json({ ok: true, action, result: jobSummary(existingJob) });
      }
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
    return res.json({
      ok: result.status !== 'failed',
      action,
      result: {
        status: result.status,
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
