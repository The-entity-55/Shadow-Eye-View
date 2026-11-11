import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite, readResponseTextCapped } from '@/lib/server/proxy-utils';
import { readServerSecret } from '@/lib/server/env-config';
import {
  computeKinematicPrediction,
  validatePredictedWaypoints,
  type FlightPredictInput,
  type PredictedWaypointMath,
} from '@/engine/flightPredictionMath';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 45_000;
const CACHE_MAX = 120;
const AI_MAX_BYTES = 256 * 1024;

interface PredictionResponseBody {
  provider: 'gemini' | 'openai' | 'kinematic';
  model: string;
  phase: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  etaMin: number | null;
  summary: string;
  waypoints: PredictedWaypointMath[];
  generatedAtMs: number;
}

const predictionCache = new Map<string, { at: number; body: PredictionResponseBody }>();

function cachePut(key: string, body: PredictionResponseBody) {
  predictionCache.set(key, { at: Date.now(), body });
  if (predictionCache.size > CACHE_MAX) {
    const oldest = [...predictionCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) predictionCache.delete(oldest[0]);
  }
}

function buildAiPrompt(input: FlightPredictInput, baseline: ReturnType<typeof computeKinematicPrediction>): string {
  const recent = (input.recentFixes || []).slice(-8).map((f) => ({
    lat: Number(f.lat.toFixed(4)),
    lon: Number(f.lon.toFixed(4)),
    altM: Math.round(f.altM),
    tRelSec: Math.round((f.epochMs - Date.now()) / 1000),
    courseDeg: f.courseDeg != null ? Math.round(f.courseDeg) : undefined,
    speedKts: f.speedMps != null ? Math.round(f.speedMps * 1.94384) : undefined,
  }));

  const contextPayload = {
    aircraft: {
      icao24: input.icao24,
      callsign: input.callsign,
      military: Boolean(input.military),
      typeCode: input.typeCode || null,
      typeName: input.typeName || null,
      airline: input.airline || null,
    },
    currentState: {
      lat: Number(input.lat.toFixed(5)),
      lon: Number(input.lon.toFixed(5)),
      altM: Math.round(input.altM),
      speedKts: Math.round(input.speedMps * 1.94384),
      courseDeg: Math.round(input.courseDeg),
      verticalRateFpm: Math.round(input.verticalRateMps * 196.85),
      onGround: input.onGround,
    },
    recentTrackTrend: recent,
    filedRoute: input.route || null,
    kinematicBaseline: {
      phase: baseline.phase,
      etaMin: baseline.etaMin,
      waypoints: baseline.waypoints,
    },
  };

  return (
    'You are an aviation ATC & ADS-B trajectory analyst. ' +
    'Given the live telemetry, recent track history trend, optional origin/destination route, and kinematic baseline, ' +
    'predict the aircraft flight phase, confidence, estimated minutes remaining (etaMin, null if destination unknown), ' +
    'a concise 1-sentence tactical summary (max 190 chars), and 4 to 8 chronological future waypoints (lat, lon, altM, etaMin, label). ' +
    'Ensure waypoints obey subsonic/transonic flight physics (<= 650 kts) and smooth turns/climb/descent profiles toward any filed destination airport.\n' +
    'Return ONLY valid JSON matching schema: ' +
    '{"phase":"TAKEOFF|CLIMB|CRUISE|DESCENT|APPROACH|GROUND","confidence":"HIGH|MEDIUM|LOW","etaMin":number|null,"summary":string,"waypoints":[{"lat":number,"lon":number,"altM":number,"etaMin":number,"label":string}]}.\n' +
    `TELEMETRY:\n${JSON.stringify(contextPayload)}`
  );
}

async function queryGemini(
  apiKey: string,
  prompt: string,
): Promise<{ model: string; parsed: Record<string, unknown> } | null> {
  const model = process.env.GEMINI_PREDICT_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 900,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    return null;
  }
  const text = await readResponseTextCapped(resp, AI_MAX_BYTES);
  const json = JSON.parse(text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawContent = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawContent.trim()) return null;
  return { model, parsed: JSON.parse(rawContent) as Record<string, unknown> };
}

async function queryOpenAi(
  apiKey: string,
  prompt: string,
): Promise<{ model: string; parsed: Record<string, unknown> } | null> {
  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini';
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: {
        format: {
          type: 'json_schema',
          name: 'flight_path_prediction',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['phase', 'confidence', 'etaMin', 'summary', 'waypoints'],
            properties: {
              phase: {
                type: 'string',
                enum: ['GROUND', 'TAKEOFF', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH'],
              },
              confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
              etaMin: { type: ['number', 'null'] },
              summary: { type: 'string' },
              waypoints: {
                type: 'array',
                minItems: 2,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['lat', 'lon', 'altM', 'etaMin', 'label'],
                  properties: {
                    lat: { type: 'number' },
                    lon: { type: 'number' },
                    altM: { type: 'number' },
                    etaMin: { type: 'number' },
                    label: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      max_output_tokens: 700,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    void resp.body?.cancel().catch(() => {});
    return null;
  }
  const text = await readResponseTextCapped(resp, AI_MAX_BYTES);
  const data = JSON.parse(text) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string; output_text?: string }> }>;
  };
  const outText =
    (typeof data.output_text === 'string' && data.output_text.trim()) ||
    (Array.isArray(data.output)
      ? data.output
          .flatMap((o) => o.content || [])
          .map((c) => c.text || c.output_text || '')
          .join('')
          .trim()
      : '');
  if (!outText) return null;
  return { model, parsed: JSON.parse(outText) as Record<string, unknown> };
}

export async function POST(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  let body: (FlightPredictInput & { force?: boolean }) | null = null;
  try {
    body = (await req.json()) as FlightPredictInput & { force?: boolean };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    !body ||
    !Number.isFinite(body.lat) ||
    !Number.isFinite(body.lon) ||
    Math.abs(body.lat) > 90 ||
    Math.abs(body.lon) > 180
  ) {
    return NextResponse.json({ error: 'Valid aircraft position required' }, { status: 400 });
  }

  const normalizedInput: FlightPredictInput = {
    icao24: String(body.icao24 || '').trim().toLowerCase(),
    callsign: String(body.callsign || body.icao24 || '').trim().toUpperCase(),
    military: Boolean(body.military),
    typeCode: body.typeCode ? String(body.typeCode) : null,
    typeName: body.typeName ? String(body.typeName) : null,
    airline: body.airline ? String(body.airline) : null,
    lat: Number(body.lat),
    lon: Number(body.lon),
    altM: Number.isFinite(body.altM) ? Math.max(0, Number(body.altM)) : 0,
    speedMps: Number.isFinite(body.speedMps) ? Math.max(0, Number(body.speedMps)) : 0,
    courseDeg: Number.isFinite(body.courseDeg) ? ((Number(body.courseDeg) % 360) + 360) % 360 : 0,
    verticalRateMps: Number.isFinite(body.verticalRateMps) ? Number(body.verticalRateMps) : 0,
    onGround: Boolean(body.onGround),
    recentFixes: Array.isArray(body.recentFixes) ? body.recentFixes : [],
    route: body.route || null,
  };

  const destCode = normalizedInput.route?.destination?.code || '';
  const cacheKey = `${normalizedInput.icao24}:${destCode}:${normalizedInput.lat.toFixed(1)},${normalizedInput.lon.toFixed(1)}:${Math.round(normalizedInput.courseDeg / 15)}`;

  if (!body.force) {
    const cached = predictionCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.body, { headers: { 'Cache-Control': 'no-store' } });
    }
  }

  const baseline = computeKinematicPrediction(normalizedInput);
  const prompt = buildAiPrompt(normalizedInput, baseline);

  let result: PredictionResponseBody = {
    provider: 'kinematic',
    model: 'great-circle-kinematic-v1',
    phase: baseline.phase,
    confidence: baseline.confidence,
    etaMin: baseline.etaMin,
    summary: baseline.summary,
    waypoints: baseline.waypoints,
    generatedAtMs: Date.now(),
  };

  const geminiKey = await readServerSecret('GEMINI_API_KEY');
  const openaiKey = await readServerSecret('OPENAI_API_KEY');

  try {
    let aiAnswer: { provider: 'gemini' | 'openai'; model: string; parsed: Record<string, unknown> } | null = null;

    if (geminiKey) {
      const gem = await queryGemini(geminiKey, prompt);
      if (gem) aiAnswer = { provider: 'gemini', ...gem };
    }
    if (!aiAnswer && openaiKey) {
      const oai = await queryOpenAi(openaiKey, prompt);
      if (oai) aiAnswer = { provider: 'openai', ...oai };
    }

    if (aiAnswer) {
      const { parsed } = aiAnswer;
      const validWaypoints = validatePredictedWaypoints(
        { lat: normalizedInput.lat, lon: normalizedInput.lon, altM: normalizedInput.altM },
        parsed.waypoints,
      );
      const validPhase =
        typeof parsed.phase === 'string' &&
        ['GROUND', 'TAKEOFF', 'CLIMB', 'CRUISE', 'DESCENT', 'APPROACH'].includes(parsed.phase)
          ? parsed.phase
          : baseline.phase;
      const validConf =
        parsed.confidence === 'HIGH' || parsed.confidence === 'MEDIUM' || parsed.confidence === 'LOW'
          ? parsed.confidence
          : baseline.confidence;
      const validSummary =
        typeof parsed.summary === 'string' && parsed.summary.trim().length > 8
          ? parsed.summary.trim().slice(0, 220)
          : baseline.summary;
      const etaNum = parsed.etaMin === null ? null : Number(parsed.etaMin);
      const validEta =
        etaNum !== null && Number.isFinite(etaNum) && etaNum > 0 && etaNum <= 720
          ? Math.round(etaNum)
          : baseline.etaMin;

      result = {
        provider: aiAnswer.provider,
        model: aiAnswer.model,
        phase: validPhase,
        confidence: validConf,
        etaMin: validEta,
        summary: validSummary,
        waypoints: validWaypoints || baseline.waypoints,
        generatedAtMs: Date.now(),
      };
    }
  } catch {
    // Graceful kinematic fallback already populated in `result`
  }

  cachePut(cacheKey, result);
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
