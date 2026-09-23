const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(color: keyof typeof COLORS, text: string): string {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text;
}

function stamp(): string {
  return paint('dim', new Date().toISOString().slice(11, 19));
}

export const log = {
  info: (...args: unknown[]) => console.log(stamp(), ...args),
  step: (...args: unknown[]) => console.log(stamp(), paint('cyan', '›'), ...args),
  ok: (...args: unknown[]) => console.log(stamp(), paint('green', '✓'), ...args),
  warn: (...args: unknown[]) => console.warn(stamp(), paint('yellow', '!'), ...args),
  error: (...args: unknown[]) => console.error(stamp(), paint('red', '✗'), ...args),
  debug: (...args: unknown[]) => {
    if (process.env.DEBUG) console.log(stamp(), paint('magenta', 'debug'), ...args);
  },
  paint,
};
