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
}

export interface AgentLoopResult {
  summary: string;
  stats: AgentStats;
}

// Strip old screenshots from conversation to keep payloads small.
// Keeps only the last N screenshots, replacing older ones with a text placeholder.
function trimOldScreenshots(messages: Anthropic.MessageParam[], keepLast: number = 2): void {
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

  const systemPrompt = buildSystemPrompt(options.url, options.prompt);
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
          }) as any;
        } else {
          response = await client!.messages.create({
            model: options.model,
            max_tokens: 1024,
            system: systemPrompt,
            tools,
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

  logger.warn('Agent reached max steps limit.');
  return {
    summary: 'Agent reached maximum steps without completing.',
    stats: { total_actions: totalActions, input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
