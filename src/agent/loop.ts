import Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';
import { tools } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
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

// Visual-verification keyword detector — when the prompt mentions visual
// properties we keep the `screenshot` tool available. Otherwise we hide it,
// because offering it tempts the model to call it for navigation flows that
// don't need vision. Mirrors the same list in the cloud proxy.
const VISUAL_KEYWORDS = [
  'look', 'looks', 'color', 'colour', 'style', 'styled',
  'appear', 'appears', 'appearance', 'visible', 'visual',
  'design', 'layout', 'chart', 'graph', 'image', 'photo',
  'icon', 'logo', 'font', 'shadow', 'render', 'rendered',
  'screenshot', 'see', 'shown', 'displayed', 'background',
];
function promptNeedsVision(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return VISUAL_KEYWORDS.some((kw) => p.includes(kw));
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
  const useProxy = isLoggedIn() && !process.env['ANTHROPIC_API_KEY'];
  const client = useProxy ? null : new Anthropic({ apiKey: options.apiKey });
  const handlers = new ToolHandlers(
    options.page,
    options.eventLog,
    options.recordingDir,
    options.actionDelayMs
  );

  const systemPrompt = buildSystemPrompt(
    options.url,
    options.prompt,
    options.requireVerdict,
    options.authInstructions,
  );

  // In verdict mode, hide the `done` tool so the agent is forced to use
  // pass/fail. The Anthropic SDK doesn't error on unknown tool names if the
  // model tries to call one — we just rely on the tool list to constrain.
  //
  // Additionally, hide `screenshot` unless the prompt explicitly mentions
  // visual properties. The element list is sufficient for navigation, and
  // offering vision causes the model to call it speculatively, which is
  // the main source of slowness users complain about.
  const needsVision = promptNeedsVision(options.prompt);
  let availableTools = options.requireVerdict
    ? tools.filter((t) => t.name !== 'done')
    : tools;
  if (!needsVision) {
    availableTools = availableTools.filter((t) => t.name !== 'screenshot');
  }
  // Prompt caching: within a single recording, system + tools are identical
  // across every step. A single cache breakpoint on the last tool caches
  // both — cutting input tokens for steps 2..N by ~80% and shaving latency.
  // Cache TTL is 5 min, which comfortably covers a recording session.
  const cachedTools = availableTools.map((t, i) =>
    i === availableTools.length - 1
      ? ({ ...t, cache_control: { type: 'ephemeral' as const } } as any)
      : t,
  );
  const cachedSystem = [
    { type: 'text' as const, text: systemPrompt, cache_control: { type: 'ephemeral' as const } },
  ];
  const messages: Anthropic.MessageParam[] = [];
  let totalActions = 0;
  let inputTokens = 0;
  let outputTokens = 0;

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
  const { formatted: initialElements } = await getInteractiveElements(options.page);
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
    logger.debug(`Agent step ${step + 1}/${options.maxSteps}`);

    // Trim old screenshots to keep payload small and API calls fast
    trimOldScreenshots(messages);

    let response: Anthropic.Message;
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      try {
        if (useProxy) {
          response = await callAgentProxy({
            messages: messages as any,
            model: options.model,
            recording_id: options.recording_id,
            url: options.url,
            prompt: options.prompt,
            requireVerdict: options.requireVerdict,
            authInstructions: options.authInstructions,
          }) as any;
        } else {
          response = await client!.messages.create({
            model: options.model,
            max_tokens: 1024,
            system: cachedSystem as any,
            tools: cachedTools,
            messages,
          });
        }
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRetryable = msg.includes('429') || msg.includes('529') || msg.includes('overloaded');
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

      try {
        const result = await handlers.handle(toolUse.name, toolUse.input as Record<string, any>);

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
        logger.warn(`Tool ${toolUse.name} failed: ${err}`);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }] as any,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
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
