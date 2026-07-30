export const VALID_STAGES = new Set(['plan', 'generate', 'compose', 'evaluate', 'all']);

export const DEFAULT_STAGE = 'all';
export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_TIMEOUT_MS = 300_000;

export function usage() {
  return `Usage:
  node scripts/run.mjs --input <input.json> --run-dir <directory> [options]

Required:
  --input <path>                 Source input JSON
  --run-dir <directory>         Run artifact directory

Options:
  --stage <name>                plan, generate, compose, evaluate, or all; default ${DEFAULT_STAGE}
  --planner-route-json <path>   Resolved planner model route JSON
  --image-route-json <path>     Resolved image model route JSON
  --compositor-route-json <path> Deterministic post-layout compositor route JSON
  --evaluator-route-json <path> Resolved evaluator model route JSON
  --authorize-model-calls       Explicitly allow model calls
  --resume                      Continue from existing valid artifacts
  --max-concurrency <n>         Concurrent image calls, 1-8; default ${DEFAULT_MAX_CONCURRENCY}
  --timeout-ms <n>              Per-call timeout, at least 10000; default ${DEFAULT_TIMEOUT_MS}
  --help                        Show help`;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');

  const args = {
    input: null,
    runDir: null,
    stage: DEFAULT_STAGE,
    plannerRouteJson: null,
    imageRouteJson: null,
    compositorRouteJson: null,
    evaluatorRouteJson: null,
    authorizeModelCalls: false,
    resume: false,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];

    if (option === '--help') args.help = true;
    else if (option === '--authorize-model-calls') args.authorizeModelCalls = true;
    else if (option === '--resume') args.resume = true;
    else if (option === '--input') args.input = requireValue(argv, ++index, option);
    else if (option === '--run-dir') args.runDir = requireValue(argv, ++index, option);
    else if (option === '--stage') args.stage = requireValue(argv, ++index, option);
    else if (option === '--planner-route-json') args.plannerRouteJson = requireValue(argv, ++index, option);
    else if (option === '--image-route-json') args.imageRouteJson = requireValue(argv, ++index, option);
    else if (option === '--compositor-route-json') args.compositorRouteJson = requireValue(argv, ++index, option);
    else if (option === '--evaluator-route-json') args.evaluatorRouteJson = requireValue(argv, ++index, option);
    else if (option === '--max-concurrency') {
      args.maxConcurrency = parseInteger(requireValue(argv, ++index, option), option);
    } else if (option === '--timeout-ms') {
      args.timeoutMs = parseInteger(requireValue(argv, ++index, option), option);
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  if (args.help) return args;
  if (!args.input) throw new Error('Missing required --input <path>');
  if (!args.runDir) throw new Error('Missing required --run-dir <directory>');
  if (!VALID_STAGES.has(args.stage)) {
    throw new Error('--stage must be plan, generate, compose, evaluate, or all');
  }
  if (args.maxConcurrency < 1 || args.maxConcurrency > 8) {
    throw new Error('--max-concurrency must be an integer from 1 to 8');
  }
  if (args.timeoutMs < 10_000) {
    throw new Error('--timeout-ms must be an integer of at least 10000');
  }

  return args;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}

function parseInteger(value, option) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${option} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${option} must be a safe integer`);
  return number;
}
