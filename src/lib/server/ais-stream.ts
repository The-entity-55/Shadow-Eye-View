import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
export const AISSTREAM_CACHE_MAX = 50_000;
export const AISSTREAM_STALE_MS = 30 * 60_000;
export const AIS_MAX_FRAME_BYTES = 1_000_000;

const AIS_TRACK_SAMPLES = 64;
const AIS_TRACK_MIN_GAP_SEC = 30;
const AIS_TRACK_MIN_MOVE_M = 25;

const SILENCE_REPORT_MS = 120_000;
const SILENCE_RECYCLE_MS = 300_000;
const BACKOFF_LADDER_MS = [5_000, 15_000, 60_000, 300_000];
const DOWN_RETRY_MS = 900_000;
const AUTH_PROBE_MS = 3_600_000;
const TICK_INTERVAL_MS = 15_000;

const DEFAULT_BBOXES: [[[number, number], [number, number]]] = [
  [
    [-90, -180],
    [90, 180],
  ],
];

const DEFAULT_MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];

export const AIS_RECOGNIZED_MESSAGE_TYPES = new Set([
  'PositionReport',
  'UnknownMessage',
  'AddressedSafetyMessage',
  'AddressedBinaryMessage',
  'AidsToNavigationReport',
  'AssignedModeCommand',
  'BaseStationReport',
  'BinaryAcknowledge',
  'BinaryBroadcastMessage',
  'ChannelManagement',
  'CoordinatedUTCInquiry',
  'DataLinkManagementMessage',
  'DataLinkManagementMessageData',
  'ExtendedClassBPositionReport',
  'GroupAssignmentCommand',
  'GnssBroadcastBinaryMessage',
  'Interrogation',
  'LongRangeAisBroadcastMessage',
  'MultiSlotBinaryMessage',
  'SafetyBroadcastMessage',
  'ShipStaticData',
  'SingleSlotBinaryMessage',
  'StandardClassBPositionReport',
  'StandardSearchAndRescueAircraftReport',
  'StaticDataReport',
]);

const AUTH_TEXT =
  /(unauthoriz|unauthoris|forbidden|invalid\s*api[\s_-]*key|invalid\s*key|bad\s*api[\s_-]*key|authentic|api\s*key\s*(is\s*)?(invalid|required|missing|not\s*valid))/i;
const RATE_TEXT =
  /(rate[\s_-]*limit|too\s*many\s*(requests|connections)|quota\s*exceeded|429)/i;

export type AisFeedStatus =
  | 'missing-key'
  | 'idle'
  | 'connecting'
  | 'live'
  | 'stale'
  | 'reconnecting'
  | 'down'
  | 'auth-failed';

export interface AisVesselRow {
  lat: number;
  lon: number;
  name: string;
  mmsi: string;
  imo: string;
  type: string;
  destination: string;
  speed: number | null;
  course: number | null;
  heading: number | null;
  last_position_UTC: string;
  last_position_epoch: number;
}

interface StoredVessel extends AisVesselRow {
  _updatedAt: number;
}

interface StaticData {
  name: string;
  type: string;
  destination: string;
  imo: string;
}

interface TrackRing {
  lats: Float32Array;
  lons: Float32Array;
  times: Uint32Array;
  head: number;
  len: number;
}

function stringValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function staticCode(value: unknown): string {
  const n = numberValue(value);
  return n !== null && Number.isInteger(n) && n > 0 ? String(n) : '';
}

function normalizedHeading(value: unknown): number | null {
  const h = numberValue(value);
  return h !== null && h >= 0 && h <= 360 ? h : null;
}

/** ITU-R M.1371 sentinel: 102.3 knots means unavailable. */
function normalizedSpeedOverGround(value: unknown): number | null {
  const s = numberValue(value);
  return s !== null && s >= 0 && s < 102.3 ? s : null;
}

/** ITU-R M.1371 sentinel: 360 means unavailable. */
function normalizedCourseOverGround(value: unknown): number | null {
  const c = numberValue(value);
  return c !== null && c >= 0 && c < 360 ? c : null;
}

function normalizeAisTimestamp(value: unknown): string {
  const text = stringValue(value);
  if (!text) return new Date().toISOString();
  const normalized = text.replace(' +0000 UTC', 'Z').replace(' UTC', 'Z');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function aisEpochSeconds(value: unknown): number {
  const ms = Date.parse(normalizeAisTimestamp(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

function approxMetersBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLon = (lon2 - lon1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLon);
}

function writeTrackSample(track: TrackRing, lat: number, lon: number, epochSec: number) {
  track.lats[track.head] = lat;
  track.lons[track.head] = lon;
  track.times[track.head] = epochSec;
  track.head = (track.head + 1) % AIS_TRACK_SAMPLES;
  track.len = Math.min(track.len + 1, AIS_TRACK_SAMPLES);
}

function readLocalEnvKey(name: string): string {
  const direct = (process.env[name] || '').trim();
  if (direct) return direct;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      if (k !== name) continue;
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val) {
        process.env[name] = val;
        return val;
      }
    }
  } catch {
    // ignore missing .env.local
  }
  return '';
}

function decodeFrameSync(data: unknown): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  if (Array.isArray(data)) {
    const parts = data.map(decodeFrameSync);
    return parts.some((p) => p === null) ? null : parts.join('');
  }
  return null;
}

function frameByteLength(data: unknown): number {
  if (typeof data === 'string') return data.length;
  if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((acc, part) => acc + frameByteLength(part), 0);
  }
  return 0;
}

class AisStreamManager {
  private vessels = new Map<string, StoredVessel>();
  private staticCache = new Map<string, StaticData>();
  private tracks = new Map<string, TrackRing>();
  private trackPending = new Map<string, { lat: number; lon: number; epochSec: number }>();

  private socket: WebSocket | null = null;
  private generation = 0;
  private status: AisFeedStatus = 'idle';
  private error: string | null = null;
  private lastMessageAt: number | null = null;
  private lastMessageMono: number | null = null;
  private connectedMono: number | null = null;
  private keyFingerprint: string | null = null;
  private reconnectAttempt = 0;
  private nextAttemptAt: number | null = null;
  private nextAttemptMono: number | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  private resolveApiKey(): string {
    return readLocalEnvKey('AISSTREAM_API_KEY');
  }

  private fingerprint(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  private startTick() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      try {
        this.ensure();
      } catch {
        // non-fatal watchdog tick
      }
    }, TICK_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  notifyKeyChanged() {
    const key = this.resolveApiKey();
    const fp = key ? this.fingerprint(key) : null;
    if (fp !== this.keyFingerprint) {
      this.terminateSocket('key-changed');
      this.keyFingerprint = fp;
      this.reconnectAttempt = 0;
      this.nextAttemptAt = null;
      this.nextAttemptMono = null;
      this.error = null;
      this.status = key ? 'idle' : 'missing-key';
    }
    if (key) this.ensure();
  }

  ensure() {
    this.startTick();
    const key = this.resolveApiKey();
    if (!key) {
      this.terminateSocket('missing-key');
      this.keyFingerprint = null;
      this.status = 'missing-key';
      this.error = 'AISSTREAM_API_KEY is not set';
      this.nextAttemptAt = null;
      this.nextAttemptMono = null;
      return;
    }

    const fp = this.fingerprint(key);
    if (this.keyFingerprint && fp !== this.keyFingerprint) {
      this.terminateSocket('key-rotated');
      this.reconnectAttempt = 0;
      this.nextAttemptAt = null;
      this.nextAttemptMono = null;
      this.error = null;
      this.status = 'idle';
    }
    this.keyFingerprint = fp;

    const nowMono = performance.now();

    if (this.socket) {
      const refMono = this.lastMessageMono ?? this.connectedMono;
      if (refMono !== null && !process.env.AISSTREAM_BOUNDING_BOXES) {
        const silentMs = nowMono - refMono;
        if (silentMs >= SILENCE_RECYCLE_MS) {
          this.status = 'reconnecting';
          this.error = 'AISStream feed silent; reconnecting';
          this.terminateSocket('silence-recycle');
          this.scheduleReconnect('transport');
          return;
        }
        if (silentMs >= SILENCE_REPORT_MS && this.status === 'live') {
          this.status = 'stale';
          this.error = 'AISStream feed silent for >120s';
        }
      }
      return;
    }

    if (this.nextAttemptMono !== null && nowMono < this.nextAttemptMono) {
      return;
    }

    this.connect(key);
  }

  private terminateSocket(reason: string) {
    const ws = this.socket;
    this.socket = null;
    this.generation++;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch (err) {
      console.warn(`[AISStream] terminate(${reason}) failed:`, err);
    }
  }

  private scheduleReconnect(kind: 'transport' | 'auth' | 'rate-limit', retryAfterMs = 0) {
    const nowWall = Date.now();
    const nowMono = performance.now();
    if (kind === 'auth') {
      this.status = 'auth-failed';
      this.nextAttemptAt = nowWall + AUTH_PROBE_MS;
      this.nextAttemptMono = nowMono + AUTH_PROBE_MS;
      return;
    }
    if (kind === 'rate-limit') {
      const wait = Math.max(60_000, retryAfterMs || 120_000);
      this.status = 'reconnecting';
      this.nextAttemptAt = nowWall + wait;
      this.nextAttemptMono = nowMono + wait;
      return;
    }
    if (this.reconnectAttempt < BACKOFF_LADDER_MS.length) {
      const wait = BACKOFF_LADDER_MS[this.reconnectAttempt++];
      this.status = 'reconnecting';
      this.nextAttemptAt = nowWall + wait;
      this.nextAttemptMono = nowMono + wait;
    } else {
      this.status = 'down';
      this.nextAttemptAt = nowWall + DOWN_RETRY_MS;
      this.nextAttemptMono = nowMono + DOWN_RETRY_MS;
    }
  }

  private connect(apiKey: string) {
    const gen = ++this.generation;
    const url = (process.env.AISSTREAM_URL || AISSTREAM_URL).trim();
    this.status = this.status === 'down' || this.status === 'auth-failed' ? this.status : 'connecting';
    this.nextAttemptAt = null;
    this.nextAttemptMono = null;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'AISStream socket creation failed';
      this.scheduleReconnect('transport');
      return;
    }

    this.socket = ws;

    ws.on('open', () => {
      if (this.generation !== gen || this.socket !== ws) return;
      this.connectedMono = performance.now();
      let bboxes = DEFAULT_BBOXES;
      if (process.env.AISSTREAM_BOUNDING_BOXES) {
        try {
          bboxes = JSON.parse(process.env.AISSTREAM_BOUNDING_BOXES);
        } catch {
          // keep default
        }
      }
      let msgTypes = DEFAULT_MESSAGE_TYPES;
      if (process.env.AISSTREAM_MESSAGE_TYPES) {
        try {
          const parsed = JSON.parse(process.env.AISSTREAM_MESSAGE_TYPES);
          if (Array.isArray(parsed)) msgTypes = parsed;
        } catch {
          msgTypes = process.env.AISSTREAM_MESSAGE_TYPES.split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
      ws.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: bboxes,
          FilterMessageTypes: msgTypes,
        }),
      );
    });

    ws.on('message', (raw) => {
      if (this.generation !== gen || this.socket !== ws) return;
      if (frameByteLength(raw) > AIS_MAX_FRAME_BYTES) return;
      const text = decodeFrameSync(raw);
      if (!text) return;

      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return;
      if (envelope.error) {
        const msg = String(envelope.error);
        this.error = msg;
        const kind = AUTH_TEXT.test(msg)
          ? 'auth'
          : RATE_TEXT.test(msg)
            ? 'rate-limit'
            : 'transport';
        this.terminateSocket('error-envelope');
        this.scheduleReconnect(kind);
        return;
      }

      if (this.ingestEnvelope(envelope)) {
        this.lastMessageAt = Date.now();
        this.lastMessageMono = performance.now();
        this.reconnectAttempt = 0;
        this.status = 'live';
        this.error = null;
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      if (this.generation !== gen || this.socket !== ws) return;
      const statusCode = res.statusCode || 0;
      const retryAfter = res.headers['retry-after'];
      res.resume();
      this.terminateSocket(`http-${statusCode}`);
      if (statusCode === 401 || statusCode === 403) {
        this.error = `AISStream rejected the API key (HTTP ${statusCode})`;
        this.scheduleReconnect('auth');
      } else if (statusCode === 429) {
        this.error = 'AISStream rate-limited this key (HTTP 429)';
        const sec = Number(retryAfter);
        this.scheduleReconnect('rate-limit', Number.isFinite(sec) ? sec * 1000 : 120_000);
      } else {
        this.error = `AISStream upgrade failed (HTTP ${statusCode})`;
        this.scheduleReconnect('transport');
      }
    });

    ws.on('error', (err) => {
      if (this.generation !== gen || this.socket !== ws) return;
      const msg = err?.message || 'AISStream websocket error';
      this.error = msg;
      const kind = AUTH_TEXT.test(msg) ? 'auth' : RATE_TEXT.test(msg) ? 'rate-limit' : 'transport';
      this.terminateSocket('socket-error');
      this.scheduleReconnect(kind);
    });

    ws.on('close', (code, reason) => {
      if (this.generation !== gen || this.socket !== ws) return;
      const msg = reason?.toString() || `AISStream closed (${code})`;
      this.socket = null;
      if (this.status !== 'auth-failed') {
        this.error = msg;
        const kind = AUTH_TEXT.test(msg) ? 'auth' : RATE_TEXT.test(msg) ? 'rate-limit' : 'transport';
        this.scheduleReconnect(kind);
      }
    });
  }

  private ingestEnvelope(envelope: Record<string, unknown>): boolean {
    const messageType = envelope.MessageType;
    if (typeof messageType !== 'string' || !AIS_RECOGNIZED_MESSAGE_TYPES.has(messageType)) {
      return false;
    }
    const msgContainer = envelope.Message as Record<string, unknown> | undefined;
    const message = (msgContainer?.[messageType] as Record<string, unknown> | undefined) || {};
    if (!message || typeof message !== 'object') return false;

    const metadata =
      ((envelope.MetaData || envelope.Metadata) as Record<string, unknown> | undefined) || {};
    const mmsi = stringValue(metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi);
    if (!mmsi) return false;

    if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
      const previous = this.staticCache.get(mmsi);
      const live = this.vessels.get(mmsi);
      const liveName = live?.name === `MMSI ${mmsi}` ? '' : live?.name;
      const reportA = message.ReportA as Record<string, unknown> | undefined;
      const reportB = message.ReportB as Record<string, unknown> | undefined;
      const fields =
        messageType === 'StaticDataReport'
          ? {
              Name: reportA?.Valid === false ? undefined : reportA?.Name,
              Type: reportB?.Valid === false ? undefined : reportB?.ShipType,
              Destination: undefined,
              ImoNumber: undefined,
            }
          : message;

      const staticData: StaticData = {
        name:
          stringValue(fields.Name ?? fields.ShipName) ||
          liveName ||
          previous?.name ||
          stringValue(metadata.ShipName),
        type:
          staticCode(fields.Type ?? fields.ShipType) ||
          staticCode(live?.type) ||
          staticCode(previous?.type) ||
          '',
        destination:
          stringValue(fields.Destination) || live?.destination || previous?.destination || '',
        imo:
          staticCode(fields.ImoNumber ?? fields.IMO) ||
          staticCode(live?.imo) ||
          staticCode(previous?.imo) ||
          '',
      };
      this.staticCache.set(mmsi, staticData);
      if (live) {
        if (staticData.name) live.name = staticData.name;
        if (staticData.type) live.type = staticData.type;
        if (staticData.destination) live.destination = staticData.destination;
        if (staticData.imo) live.imo = staticData.imo;
        return true;
      }
    }

    const lat = numberValue(metadata.latitude ?? metadata.Latitude ?? message.Latitude);
    const lon = numberValue(metadata.longitude ?? metadata.Longitude ?? message.Longitude);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return true;
    }

    const staticData = this.staticCache.get(mmsi);
    const epochSec = aisEpochSeconds(metadata.time_utc ?? metadata.TimeUtc);
    const name =
      stringValue(
        metadata.ShipName ??
          message.Name ??
          message.ShipName ??
          (message.ReportA as Record<string, unknown> | undefined)?.Name ??
          staticData?.name,
      ) || `MMSI ${mmsi}`;

    this.vessels.set(mmsi, {
      lat,
      lon,
      name,
      mmsi,
      imo: stringValue(message.ImoNumber ?? message.IMO ?? staticData?.imo),
      type: stringValue(
        message.Type ??
          message.ShipType ??
          (message.ReportB as Record<string, unknown> | undefined)?.ShipType ??
          staticData?.type,
      ),
      destination: stringValue(message.Destination ?? staticData?.destination),
      speed: normalizedSpeedOverGround(message.Sog ?? message.SOG),
      course: normalizedCourseOverGround(message.Cog ?? message.COG),
      heading: normalizedHeading(message.TrueHeading ?? message.Heading),
      last_position_UTC: normalizeAisTimestamp(metadata.time_utc ?? metadata.TimeUtc),
      last_position_epoch: epochSec,
      _updatedAt: Date.now(),
    });

    this.appendTrackSample(mmsi, lat, lon, epochSec);
    this.pruneCache();
    return true;
  }

  private appendTrackSample(mmsi: string, lat: number, lon: number, epochSec: number) {
    let track = this.tracks.get(mmsi);
    if (!track) {
      const pending = this.trackPending.get(mmsi);
      if (!pending) {
        this.trackPending.set(mmsi, { lat, lon, epochSec });
        return;
      }
      if (epochSec - pending.epochSec < AIS_TRACK_MIN_GAP_SEC) return;
      if (approxMetersBetween(pending.lat, pending.lon, lat, lon) < AIS_TRACK_MIN_MOVE_M) return;

      track = {
        lats: new Float32Array(AIS_TRACK_SAMPLES),
        lons: new Float32Array(AIS_TRACK_SAMPLES),
        times: new Uint32Array(AIS_TRACK_SAMPLES),
        head: 0,
        len: 0,
      };
      this.tracks.set(mmsi, track);
      this.trackPending.delete(mmsi);
      writeTrackSample(track, pending.lat, pending.lon, pending.epochSec);
      writeTrackSample(track, lat, lon, epochSec);
      return;
    }

    const lastIdx = (track.head - 1 + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
    if (epochSec - track.times[lastIdx] < AIS_TRACK_MIN_GAP_SEC) return;
    if (
      approxMetersBetween(track.lats[lastIdx], track.lons[lastIdx], lat, lon) <
      AIS_TRACK_MIN_MOVE_M
    ) {
      return;
    }
    writeTrackSample(track, lat, lon, epochSec);
  }

  private pruneCache() {
    const cutoff = Date.now() - AISSTREAM_STALE_MS;
    for (const [mmsi, row] of this.vessels) {
      if (row._updatedAt < cutoff) {
        this.vessels.delete(mmsi);
        this.tracks.delete(mmsi);
        this.trackPending.delete(mmsi);
      }
    }
    const pendingCutoff = Math.floor(cutoff / 1000);
    for (const [mmsi, pending] of this.trackPending) {
      if (pending.epochSec < pendingCutoff) this.trackPending.delete(mmsi);
    }
    if (this.vessels.size <= AISSTREAM_CACHE_MAX) return;
    const ordered = [...this.vessels.entries()].sort((a, b) => a[1]._updatedAt - b[1]._updatedAt);
    for (const [mmsi] of ordered.slice(0, this.vessels.size - AISSTREAM_CACHE_MAX)) {
      this.vessels.delete(mmsi);
      this.tracks.delete(mmsi);
      this.trackPending.delete(mmsi);
    }
  }

  getRows(maxRows: number): AisVesselRow[] {
    const cutoff = Date.now() - AISSTREAM_STALE_MS;
    const rows: StoredVessel[] = [];
    for (const row of this.vessels.values()) {
      if (row._updatedAt >= cutoff) rows.push(row);
    }
    rows.sort((a, b) => b._updatedAt - a._updatedAt);
    return rows.slice(0, maxRows).map(({ _updatedAt: _drop, ...rest }) => rest);
  }

  getTrack(mmsi: string): Array<{ lat: number; lon: number; t: number }> {
    const track = this.tracks.get(mmsi);
    if (!track || !track.len) return [];
    const samples: Array<{ lat: number; lon: number; t: number }> = [];
    const start = (track.head - track.len + AIS_TRACK_SAMPLES) % AIS_TRACK_SAMPLES;
    for (let i = 0; i < track.len; i++) {
      const idx = (start + i) % AIS_TRACK_SAMPLES;
      samples.push({
        lat: track.lats[idx],
        lon: track.lons[idx],
        t: track.times[idx],
      });
    }
    return samples;
  }

  getSnapshot() {
    const hasKey = Boolean(this.resolveApiKey());
    const silentForMs =
      this.lastMessageMono !== null ? Math.round(performance.now() - this.lastMessageMono) : null;
    return {
      hasKey,
      status: hasKey ? this.status : ('missing-key' as const),
      error: hasKey ? this.error : 'AISSTREAM_API_KEY is not set',
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      silentForMs,
      reconnectAttempt: this.reconnectAttempt,
      nextAttemptAt: this.nextAttemptAt,
      staleAfterMs: SILENCE_REPORT_MS,
    };
  }
}

const MANAGER_SYMBOL = Symbol.for('gev.aisStream.singleton');

export function getAisManager(): AisStreamManager {
  const g = globalThis as unknown as Record<symbol, AisStreamManager | undefined>;
  if (!g[MANAGER_SYMBOL]) {
    g[MANAGER_SYMBOL] = new AisStreamManager();
  }
  return g[MANAGER_SYMBOL]!;
}
