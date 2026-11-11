"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readServerSecret = readServerSecret;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
function parseEnvFile(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0)
            continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}
/**
 * Read a server-side secret/env var from process.env or .env.local/.env.
 */
async function readServerSecret(name) {
    const direct = (process.env[name] || '').trim();
    if (direct)
        return direct;
    for (const fileName of ['.env.local', '.env']) {
        try {
            const raw = await promises_1.default.readFile(node_path_1.default.join(/*turbopackIgnore: true*/ process.cwd(), fileName), 'utf8');
            const parsed = parseEnvFile(raw);
            const val = (parsed[name] || '').trim();
            if (val)
                return val;
        }
        catch {
            // Optional env file not present
        }
    }
    return '';
}
