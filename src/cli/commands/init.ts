import { Command } from 'commander';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import * as output from '../output.js';
import { isLoggedIn, loadCloudConfig, saveCloudConfig } from '../../cloud/client.js';
import { loginFlow } from '../../cloud/auth.js';
import { isConfigured } from '../../utils/config.js';
import { capture } from '../../utils/telemetry.js';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function detectAgents(): string[] {
  const agents: string[] = [];
  for (const cmd of ['claude', 'cursor']) {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      agents.push(cmd);
    } catch {
      // not found
    }
  }
  return agents;
}

async function installSkill(): Promise<void> {
  const agents = detectAgents();
  if (agents.length === 0) return;

  const agentList = agents.join(', ');
  const answer = await ask(`  Install the screencli skill for your coding agent? (${agentList}) [Y/n] `);
  if (answer.toLowerCase() === 'n') return;

  const spinner = output.createSpinner('Installing skill...');
  spinner.start();
  try {
    execSync('npx -y skills add usefulagents/screencli --skill screencli', {
      stdio: 'ignore',
      timeout: 60_000,
    });
    spinner.succeed('Skill installed');
  } catch {
    spinner.warn('Skill installation skipped (you can install later with: npx skills add usefulagents/screencli --skill screencli)');
  }
}

function showGettingStarted(): void {
  console.log('');
  output.header('Getting Started');
  output.info('Record your first demo:');
  console.log('');
  console.log('    screencli record https://your-app.com -p "Walk through onboarding"');
  console.log('');
  output.info('Useful options:');
  console.log('    --auth <name>         Save & reuse login sessions');
  console.log('    --background <preset> Gradient background (aurora, sunset, ocean...)');
  console.log('    --local               Skip cloud upload');
  console.log('');
  output.info('Learn more: https://screencli.sh');
  console.log('');
}

/**
 * Run the interactive setup flow.
 * Prompts the user to sign in via cloud or paste an API key.
 */
export async function runInit(): Promise<boolean> {
  output.header('screencli setup');
  console.log('');

  const isFirstRun = !isConfigured();

  // Already configured — skip
  if (isConfigured()) {
    if (isLoggedIn()) {
      const config = loadCloudConfig();
      output.success(`Already logged in as ${config.email || 'unknown'}`);
    } else {
      output.success('API key configured');
    }
    console.log('');
    return true;
  }

  // Auth choice
  output.info('How would you like to connect?\n');
  console.log('    1. Sign in to screencli.sh (default)');
  console.log('       Free credits included — no API key needed.\n');
  console.log('    2. Use your own Anthropic API key');
  console.log('       Calls go directly to Anthropic. Local-only, no cloud features.\n');

  const choice = await ask('  Choose [1]: ');
  console.log('');

  if (choice === '2') {
    // API key flow
    const key = await ask('  Anthropic API key: ');
    if (!key || !key.startsWith('sk-ant-')) {
      output.error('Invalid API key. It should start with sk-ant-');
      return false;
    }

    const config = loadCloudConfig();
    config.anthropicApiKey = key;
    saveCloudConfig(config);

    output.success('API key saved');
    console.log('');
  } else {
    // Cloud login flow (default)
    output.info('Sign in with GitHub or Google to get started.');
    console.log('');

    try {
      const result = await loginFlow();
      console.log('');
      output.success(`Logged in as ${result.email} (${result.plan} plan)`);
      console.log('');
    } catch (err: any) {
      output.error(`Login failed: ${err.message}`);
      output.info('You can also run `screencli init` and choose option 2 to use an API key.');
      return false;
    }
  }

  // Offer skill installation
  await installSkill();

  if (isFirstRun) {
    capture('cli_first_run', {
      auth_method: choice === '2' ? 'api_key' : 'cloud_login',
    });
  }

  return true;
}

export const initCommand = new Command('init')
  .description('Set up screencli (sign in or configure API key)')
  .action(async () => {
    const ok = await runInit();
    if (ok) {
      showGettingStarted();
    }
  });
