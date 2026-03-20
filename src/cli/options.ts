import { Option } from 'commander';

export const promptOption = new Option('-p, --prompt <text>', 'Instructions for the AI agent');

export const outputOption = new Option('-o, --output <dir>', 'Output directory').default('./recordings');

export const viewportOption = new Option('--viewport <WxH>', 'Viewport size').default('1920x1080');

export const modelOption = new Option('-m, --model <model>', 'Claude model to use').default('claude-sonnet-4-20250514');

export const headlessOption = new Option('--no-headless', 'Show browser window');

export const slowMoOption = new Option('--slow-mo <ms>', 'Extra delay between actions').default('0');

export const maxStepsOption = new Option('--max-steps <n>', 'Max agent iterations').default('50');

export const presetOption = new Option('--preset <name>', 'Platform preset').choices([
  'youtube',
  'twitter',
  'instagram',
  'tiktok',
  'linkedin',
  'github-gif',
]).default('youtube');

export const noZoomOption = new Option('--no-zoom', 'Disable auto-zoom');
export const noHighlightOption = new Option('--no-highlight', 'Disable click highlights');
export const noCursorOption = new Option('--no-cursor', 'Disable cursor trail');

export const loginOption = new Option('--login', 'Open browser for manual login before AI takes over');
export const authOption = new Option('--auth <name>', 'Use saved auth state (auto-creates on first use via login flow)');

export const backgroundOption = new Option('--background <name>', 'Background style').choices([
  'midnight', 'ember', 'forest', 'nebula', 'slate', 'copper', 'none',
]);
export const noBackgroundOption = new Option('--no-background', 'Disable background');
export const paddingOption = new Option('--padding <percent>', 'Background padding percentage').default('8');
export const cornerRadiusOption = new Option('--corner-radius <px>', 'Video corner radius in pixels').default('12');
export const noShadowOption = new Option('--no-shadow', 'Disable drop shadow on background');

export const localOption = new Option('--local', 'Skip cloud upload even if logged in');
export const unlistedOption = new Option('--unlisted', 'Upload but mark as unlisted (not shown on public profile)');

export function parseViewport(value: string): { width: number; height: number } {
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`Invalid viewport format: ${value}. Expected WxH (e.g. 1920x1080)`);
  return { width: parseInt(match[1]!, 10), height: parseInt(match[2]!, 10) };
}
