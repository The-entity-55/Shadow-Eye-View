"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isLoopbackAddress = isLoopbackAddress;
exports.checkSameSite = checkSameSite;
exports.readResponseBytesCapped = readResponseBytesCapped;
exports.readResponseTextCapped = readResponseTextCapped;
exports.coalesceRequest = coalesceRequest;
const server_1 = require("next/server");
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function isLoopbackAddress(hostOrIp) {
    const raw = String(hostOrIp || '')
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, '');
    return LOOPBACK_HOSTS.has(raw) || raw.startsWith('127.');
}
/**
 * Same-site gate modeled on upstream server/providers/common/same-site.js.
 * Refuses cross-site browser requests (foreign Origin or cross-site Sec-Fetch-Site)
 * while permitting same-origin browser calls and non-browser loopback tools.
 */
function checkSameSite(req, { allowProxied = true } = {}) {
    const secFetchSite = (req.headers.get('sec-fetch-site') || '').trim().toLowerCase();
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        return server_1.NextResponse.json({ error: 'Cross-site request refused' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    const host = (req.headers.get('host') || '').trim().toLowerCase();
    const origin = (req.headers.get('origin') || '').trim();
    if (origin) {
        try {
            const originUrl = new URL(origin);
            if (host && originUrl.host.toLowerCase() !== host) {
                return server_1.NextResponse.json({ error: 'Foreign origin refused' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
            }
        }
        catch {
            return server_1.NextResponse.json({ error: 'Malformed origin refused' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
        }
    }
    if (!allowProxied) {
        const hasForwarding = req.headers.has('x-forwarded-for') ||
            req.headers.has('x-forwarded-host') ||
            req.headers.has('forwarded');
        if (hasForwarding) {
            return server_1.NextResponse.json({ error: 'Proxied configuration request refused' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
        }
        const hostname = host.replace(/:\d+$/, '');
        if (hostname && !isLoopbackAddress(hostname)) {
            return server_1.NextResponse.json({ error: 'Loopback access required for key setup' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
        }
    }
    return null;
}
/**
 * Read a fetch Response body up to `maxBytes` to prevent runaway upstream payloads.
 */
async function readResponseBytesCapped(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        void response.body?.cancel().catch(() => { });
        throw new Error(`Upstream payload exceeds ${maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
        const buf = new Uint8Array(await response.arrayBuffer());
        if (buf.byteLength > maxBytes) {
            throw new Error(`Upstream payload exceeds ${maxBytes} bytes`);
        }
        return buf;
    }
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    throw new Error(`Upstream payload exceeds ${maxBytes} bytes`);
                }
                chunks.push(value);
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
async function readResponseTextCapped(response, maxBytes) {
    const bytes = await readResponseBytesCapped(response, maxBytes);
    return new TextDecoder('utf-8').decode(bytes);
}
/**
 * Coalesce concurrent upstream fetches keyed by string ID so cache stampedes
 * collapse to a single upstream request.
 */
function coalesceRequest(inFlight, key, loader) {
    const existing = inFlight.get(key);
    if (existing)
        return existing;
    const promise = Promise.resolve()
        .then(loader)
        .finally(() => {
        if (inFlight.get(key) === promise) {
            inFlight.delete(key);
        }
    });
    inFlight.set(key, promise);
    return promise;
}
