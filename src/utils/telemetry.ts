import { PostHog } from 'posthog-node';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getToken, loadCloudConfig } from '../cloud/client.js';

const POSTHOG_KEY = 'phc_r8WorjeoCgYPgViRd0WzsQtjutHAB4T1E1Gw5ButjIG';
const POSTHOG_HOST = 'https://us.i.posthog.com';
const CONFIG_DIR = join(homedir(), '.screencli');
const STATE_PATH = join(CONFIG_DIR, 'telemetry.json');

interface TelemetryState {
  distinctId: string;
  disabled?: boolean;
}

let client: PostHog | null = null;
let state: TelemetryState | null = null;

function isDisabled(): boolean {
  return !!(process.env['SCREENCLI_NO_TELEMETRY'] || process.env['DO_NOT_TRACK']);
}

function loadState(): TelemetryState {
  if (state) return state;
  try {
    state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    return state!;
  } catch {
    // First run — generate an anonymous ID
    state = { distinctId: randomUUID() };
    try {
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch { /* ignore write errors */ }
    return state;
  }
}

function getClient(): PostHog | null {
  if (isDisabled()) return null;
  if (client) return client;
  client = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0 });
  return client;
}

function getDistinctId(): string {
  // Use cloud user email if logged in, otherwise anonymous ID
  const config = loadCloudConfig();
  if (config.email) return config.email;
  return loadState().distinctId;
}

export function capture(event: string, properties?: Record<string, any>): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: getDistinctId(),
      event,
      properties: {
        source: 'cli',
        cli_version: process.env['npm_package_version'] || 'unknown',
        logged_in: !!getToken(),
        ...properties,
      },
    });
  } catch { /* never block on telemetry */ }
}

export async function shutdown(): Promise<void> {
  if (client) {
    try { await client.shutdown(); } catch { /* ignore */ }
    client = null;
  }
}
