import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { ToolHandlers } from './tool-handlers.js';
import { EventLog } from '../recording/event-log.js';
import { logger } from '../utils/logger.js';
import { AgentError } from '../utils/errors.js';
import { isLoggedIn } from '../cloud/client.js';
import { callAgentProxy } from '../cloud/agent-proxy.js';
import type { AgentStats } from '../recording/types.js';
import type { Verdict } from './tool-handlers.js';

export interface AgentLoopOptions {
  apiKey: string;
  model: string;
  recording_id?: string;
  url: string;
  prompt: string;
  page: Page;
  eventLog: EventLog;
  recordingDir: string;
  actionDelayMs: number;
  maxSteps: number;
  onAction?: (step: number, toolName: string, description: string) => void;
  /**
   * Force verdict mode: the `done` tool is hidden so the agent MUST end
   * the run with `pass` or `fail`. Used by orchestrator-driven runs where
   * a verdict is required for the PR comment to make sense.
   */
  requireVerdict?: boolean;
  /**
   * Optional auth setup the agent must perform BEFORE the main task.
   * When set, the system prompt is amended with a two-phase structure:
   *   Phase 1: AUTH — perform these instructions verbatim
   *   Phase 2: TASK — carry out the user prompt
   * If auth fails (e.g. credentials rejected), the agent should `fail()`
   * the verdict with a reason that cites the auth blocker.
   */
  authInstructions?: string;
}

export interface AgentLoopResult {
  summary: string;
  stats: AgentStats;
  /** Set when the agent called pass/fail. Absent for plain `done`. */
  verdict?: Verdict;
  /** The reason the agent supplied with pass/fail. */
  reason?: string;
}

// Stagnation detection thresholds. A "fingerprint" is a hash of the page
// state (URL + element list) returned after a step's actions. If consecutive
// steps produce the same fingerprint, the agent is acting without effect —
// the classic failure mode where it guesses coordinates / re-opens the same
// menu forever until it burns the whole step budget.
const NUDGE_AFTER_NO_PROGRESS = 2;   // inject a course-correction message
const BAIL_AFTER_NO_PROGRESS = 5;    // give up and return inconclusive
const LOW_STEPS_REMAINING = 8;       // start telling the agent to converge

// Wall-clock safety nets. A single tool call (Playwright action + element
// re-scan) should never take this long — if it does, the browser is wedged
// (e.g. a click triggered a navigation/reload that never settles), and the
// loop would otherwise hang forever with no API activity until the 15-min
// server-side watchdog force-finalizes the run with NO video. These bound the
// loop so it always RETURNS, letting the CLI compose + upload whatever video
// exists and POST an honest `inconclusive` verdict.
// Override via env for ops tuning.
const STEP_TIMEOUT_MS = Number(process.env['SCREENCLI_STEP_TIMEOUT_MS']) || 60_000;
const RUN_DEADLINE_MS = Number(process.env['SCREENCLI_RUN_DEADLINE_MS']) || 10 * 60_000;

/** Thrown when a single tool call exceeds STEP_TIMEOUT_MS. */
class StepTimeoutError extends Error {}

/**
 * Race a promise against a timeout. If the timeout wins we reject (so the
 * caller unblocks), but we still attach handlers to the original promise so a
 * late rejection doesn't surface as an unhandled rejection.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new StepTimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function fingerprintToolResults(toolResults: Anthropic.ToolResultBlockParam[]): string {
  const text = toolResults
    .flatMap((r) => (Array.isArray(r.content) ? r.content : []))
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n');
  return createHash('sha1').update(text).digest('hex');
}

// Strip old screenshots from conversation to keep payloads small.
// Keeps only the last N screenshots, replacing older ones with a text placeholder.
function trimOldScreenshots(messages: Anthropic.MessageParam[], keepLast: number = 1): void {
  let imageCount = 0;
  // Count total images (reverse scan)
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as any).type === 'image' || ((block as any).type === 'tool_result' && Array.isArray((block as any).content))) {
        const items = (block as any).type === 'image' ? [block] : ((block as any).content ?? []);
        for (const item of items) {
          if ((item as any).type === 'image') imageCount++;
        }
      }
    }
  }

  if (imageCount <= keepLast) return;

  // Strip oldest images
  let toStrip = imageCount - keepLast;
  for (let i = 0; i < messages.length && toStrip > 0; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length && toStrip > 0; j++) {
      const block = content[j] as any;
      if (block.type === 'image') {
        content[j] = { type: 'text', text: '[screenshot removed to save context]' } as any;
        toStrip--;
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let k = 0; k < block.content.length && toStrip > 0; k++) {
          if (block.content[k].type === 'image') {
            block.content[k] = { type: 'text', text: '[screenshot removed]' };
            toStrip--;
          }
        }
      }
    }
  }
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  // The CLI no longer ships its own system prompt or tool schema — the agent
  // always runs through the cloud proxy, which is the single source of truth
  // for the prompt, tool list, and model. (Local/BYO-key recordings are not
  // supported.) So a valid login is required.
  if (!isLoggedIn()) {
    throw new AgentError(
      'screencli must be logged in to run the agent. Run `npx screencli login` (or set SCREENCLI_TOKEN).',
    );
  }
  const handlers = new ToolHandlers(
    options.page,
    options.eventLog,
    options.recordingDir,
    options.actionDelayMs
  );

  const messages: Anthropic.MessageParam[] = [];
  let totalActions = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // Stagnation tracking (see fingerprintToolResults).
  let lastFingerprint: string | null = null;
  let noProgressStreak = 0;
  let lastActionLabel = '';

  // Wall-clock safety nets (see STEP_TIMEOUT_MS / RUN_DEADLINE_MS).
  const runStart = Date.now();
  const runDeadlineAt = runStart + RUN_DEADLINE_MS;
  logger.info(
    `Agent budget: ${options.maxSteps} steps, ${(RUN_DEADLINE_MS / 1000).toFixed(0)}s run deadline, ` +
      `${(STEP_TIMEOUT_MS / 1000).toFixed(0)}s per-step timeout.`,
  );

  // Initial observation: navigate to URL
  logger.info(`Navigating to ${options.url}`);
  await options.page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await options.page.waitForTimeout(500);

  options.eventLog.append({
    type: 'navigate',
    description: `Navigate to ${options.url}`,
    viewport: options.page.viewportSize() ?? { width: 1920, height: 1080 },
    value: options.url,
    url: options.url,
  });

  // Send element list only (no vision) — agent can act immediately
  const { getInteractiveElements } = await import('../browser/accessibility.js');
  const { formatted: initialElements } = await withTimeout(
    getInteractiveElements(options.page),
    STEP_TIMEOUT_MS,
    'initial element scan',
  );
  messages.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Page loaded. Use the element indices to interact.\n\n${initialElements}`,
      },
    ],
  });

  for (let step = 0; step < options.maxSteps; step++) {
    const runElapsedMs = Date.now() - runStart;
    logger.debug(`Agent step ${step + 1}/${options.maxSteps} (run elapsed ${(runElapsedMs / 1000).toFixed(0)}s)`);

    // ── Overall run deadline ──
    // Backstop for slow-but-not-hung runs (many near-timeout steps, a slow
    // proxy, etc.). Returning here lets the CLI still compose + upload the
    // partial video and POST a verdict, instead of the 15-min server watchdog
    // killing the run with no video.
    if (runElapsedMs > RUN_DEADLINE_MS) {
      logger.error(
        `Agent hit run deadline (${(RUN_DEADLINE_MS / 1000).toFixed(0)}s) at step ${step + 1}. ` +
          `Finalizing as inconclusive. Last action: ${lastActionLabel || 'n/a'}.`,
      );
      return {
        summary: 'Agent exceeded the overall time budget.',
        stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
        verdict: 'inconclusive',
        reason:
          `Agent exceeded the run deadline (${(RUN_DEADLINE_MS / 1000).toFixed(0)}s) at step ${step + 1}/${options.maxSteps}` +
          (lastActionLabel ? ` (last action: ${lastActionLabel})` : '') +
          `. The page may be slow or the run too complex for the time budget.`,
      };
    }

    // Trim old screenshots to keep payload small and API calls fast
    trimOldScreenshots(messages);

    let response: Anthropic.Message;
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await withTimeout(
          callAgentProxy({
            messages: messages as any,
            model: options.model,
            recording_id: options.recording_id,
            url: options.url,
            prompt: options.prompt,
            requireVerdict: options.requireVerdict,
            authInstructions: options.authInstructions,
          }) as Promise<Anthropic.Message>,
          STEP_TIMEOUT_MS,
          'agent proxy call',
        );
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable =
          err instanceof StepTimeoutError ||
          msg.includes('429') || msg.includes('529') || msg.includes('overloaded');
        if (isRetryable && attempt < MAX_RETRIES) {
          const waitMs = Math.min(1000 * 2 ** attempt, 15_000);
          logger.warn(`Retryable error (attempt ${attempt + 1}/${MAX_RETRIES}): ${msg}. Retrying in ${waitMs}ms...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new AgentError(`Claude API error: ${err}`);
      }
    }

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    // Add assistant response to conversation
    messages.push({ role: 'assistant', content: response.content });

    // Check if there are tool calls
    const toolUses = response.content.filter(
      (block): block is Anthropic.ContentBlockParam & { type: 'tool_use'; id: string; name: string; input: any } =>
        block.type === 'tool_use'
    );

    if (toolUses.length === 0) {
      // No tool calls — model is just talking. Check if stop reason indicates end.
      if (response.stop_reason === 'end_turn') {
        logger.info('Agent ended without calling done. Finishing.');
        return {
          summary: 'Agent completed without explicit done signal.',
          stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
        };
      }
      continue;
    }

    // Process each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUses) {
      totalActions++;
      const description = (toolUse.input as Record<string, any>).description ??
        (toolUse.input as Record<string, any>).summary ??
        (toolUse.input as Record<string, any>).text ??
        toolUse.name;
      options.onAction?.(step + 1, toolUse.name, String(description));
      logger.info(`[${step + 1}] ${toolUse.name}: ${description}`);
      lastActionLabel = `${toolUse.name} (${String(description)})`;

      const toolStart = Date.now();
      try {
        // Per-step timeout: if a single action wedges (most often a click that
        // kicks off a navigation/reload that never settles), abort the whole
        // run rather than hang. STEP_TIMEOUT_MS is far above any individual
        // Playwright timeout, so this only trips on a genuinely stuck browser.
        const result = await withTimeout(
          handlers.handle(toolUse.name, toolUse.input as Record<string, any>),
          STEP_TIMEOUT_MS,
          `[${step + 1}] ${toolUse.name}`,
        );
        logger.info(`[${step + 1}] ${toolUse.name} ✓ ${Date.now() - toolStart}ms`);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content as any,
        });

        if (result.isDone) {
          return {
            summary: result.summary ?? 'Task completed.',
            stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
            verdict: result.verdict,
            reason: result.reason,
          };
        }
      } catch (err) {
        if (err instanceof StepTimeoutError) {
          // The browser is wedged. There's no point continuing — subsequent
          // actions will hit the same dead context. Finalize now so the CLI
          // can still upload the partial video + verdict. The reason names the
          // tool + elapsed so the hang is debuggable from the DB afterward.
          const elapsedMs = Date.now() - toolStart;
          logger.error(
            `[${step + 1}] ${toolUse.name} TIMED OUT after ${elapsedMs}ms — browser likely wedged ` +
              `(e.g. a click triggered a navigation/reload that never settled). Finalizing as inconclusive.`,
          );
          return {
            summary: 'Agent stalled — a browser action did not complete.',
            stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
            verdict: 'inconclusive',
            reason:
              `Browser action timed out after ${(elapsedMs / 1000).toFixed(0)}s at step ${step + 1}/${options.maxSteps}: ` +
              `${lastActionLabel}. The page likely got stuck loading after this action.`,
          };
        }
        logger.warn(`[${step + 1}] ${toolUse.name} failed after ${Date.now() - toolStart}ms: ${err}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] as any,
          is_error: true,
        });
      }
    }

    // ── Stagnation detection ──
    // Compare the page state after this step to the previous step. If nothing
    // changed, the agent's actions are having no effect — nudge it to change
    // strategy, and bail out entirely if it keeps spinning. This is what stops
    // the "re-open the same menu / guess coordinates" loop from eating the
    // whole step budget and forcing a useless max-steps inconclusive.
    const fingerprint = fingerprintToolResults(toolResults);
    if (lastFingerprint !== null && fingerprint === lastFingerprint) {
      noProgressStreak++;
    } else {
      noProgressStreak = 0;
    }
    lastFingerprint = fingerprint;

    if (noProgressStreak >= BAIL_AFTER_NO_PROGRESS) {
      logger.warn(`Agent stuck: ${noProgressStreak + 1} actions with no page change. Bailing.`);
      return {
        summary: 'Agent got stuck repeating actions with no effect.',
        stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
        verdict: 'inconclusive',
        reason:
          `Agent repeated actions with no page change ${noProgressStreak + 1} times and could not make progress` +
          (lastActionLabel ? ` (last attempted: ${lastActionLabel})` : '') +
          `. It likely couldn't reach a required element — e.g. a menu/submenu item that only appears after hovering the parent.`,
      };
    }

    const userContent: Anthropic.ContentBlockParam[] = [...toolResults];

    // Coaching note: budget awareness + stagnation course-correction. Appended
    // after the tool_result blocks (which must come first in the user turn).
    const stepsLeft = options.maxSteps - (step + 1);
    const coachLines: string[] = [`[Progress] Step ${step + 1}/${options.maxSteps} — ${stepsLeft} left.`];
    if (noProgressStreak >= NUDGE_AFTER_NO_PROGRESS) {
      coachLines.push(
        `The page has not changed for ${noProgressStreak + 1} actions — what you are doing is NOT working. Do not repeat it. ` +
          `Reveal hidden items (hover a menu to open its submenu), open the parent first, scroll, or pick a different element by index. ` +
          (options.requireVerdict
            ? `If you cannot reach the state needed to judge the expectation, call fail() naming the exact blocker.`
            : `If you cannot reach the next step, call done() and say what you could not reach.`),
      );
    }
    if (stepsLeft <= LOW_STEPS_REMAINING) {
      coachLines.push(
        `You are low on steps — converge now and ` +
          (options.requireVerdict ? `return a pass/fail verdict.` : `finish with done().`),
      );
    }
    if (coachLines.length > 0) {
      userContent.push({ type: 'text', text: coachLines.join(' ') });
    }

    messages.push({ role: 'user', content: userContent });
  }

  // ── maxSteps fallthrough ──
  // The agent neither called done nor pass/fail within maxSteps actions.
  // Return `inconclusive` so the recording lands cleanly with a real verdict
  // (instead of leaving result.verdict undefined, which used to default to
  // 'pass' in record.ts and stranded recordings in `uploading` when downstream
  // compose/upload failed). For verdict-mode runs, this is the honest answer:
  // we couldn't determine pass/fail in the time budget.
  logger.warn('Agent reached max steps limit.');
  return {
    summary: 'Agent reached maximum steps without completing.',
    stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
    verdict: 'inconclusive',
    reason:
      `Agent reached max-steps (${options.maxSteps}) without calling ${
        options.requireVerdict ? 'pass or fail' : 'done'
      }. ` +
      `The expectation may need a more focused prompt, or the page is hard to verify in this many steps.`,
  };
}
