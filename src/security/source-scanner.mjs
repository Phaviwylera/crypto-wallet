import { parse } from 'acorn';
import { simple } from 'acorn-walk';

export const SOURCE_SCHEMA_VERSION = '1.0.0';
export const SOURCE_LIMITS = Object.freeze({ maxFiles: 250, maxFileBytes: 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 });
export const SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.dart', '.c', '.h', '.cpp', '.cc', '.cs', '.rb', '.php', '.sol']);
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const RULES = [
  { id: 'JS-MATH-RANDOM', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], pattern: /\bMath\s*\.\s*random\s*\(/, severity: 'high', confidence: 'high', title: 'Non-cryptographic Math.random()', cwe: 'CWE-338', recommendation: 'Use the platform CSPRNG (Web Crypto getRandomValues or Node crypto.randomBytes) for every secret. Trace this call to determine whether it reaches key, seed, nonce, salt, or recovery material.' },
  { id: 'JS-WEAK-PRNG', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], pattern: /\b(?:seedrandom|MersenneTwister|MT19937|mt19937|xorshift\w*)\s*\(|\bfrom\s*['"](?:seedrandom|mersenne-twister|@stdlib\/random)/, severity: 'high', confidence: 'medium', title: 'Explicit non-cryptographic PRNG', cwe: 'CWE-338', recommendation: 'Do not use a general-purpose PRNG for secrets. Verify the seed source, state size, and all callers; replace secret generation with a CSPRNG.' },
  { id: 'JS-TIME-SEED', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], pattern: /(?:seed|entropy|random|nonce|key)[\w\s=:.]*(?:Date\s*\.\s*now|new\s+Date|performance\s*\.\s*now)|(?:Date\s*\.\s*now|performance\s*\.\s*now)[\w\s=:.]*(?:seed|entropy|random|nonce|key)/i, severity: 'high', confidence: 'medium', title: 'Clock-derived value near secret generation', cwe: 'CWE-337', recommendation: 'Clocks are observable and low entropy. Confirm data flow; never derive secret seeds from timestamps, counters, device identifiers, or user input alone.' },
  { id: 'PY-RANDOM', extensions: ['.py'], pattern: /\brandom\s*\.\s*(?:random|randint|randrange|getrandbits|choice|choices|sample|shuffle)\s*\(/, severity: 'high', confidence: 'high', title: 'Python random module is not cryptographic', cwe: 'CWE-338', recommendation: 'Use secrets.token_bytes / secrets.SystemRandom for secret material. Trace whether this call affects wallet generation.' },
  { id: 'JAVA-UTIL-RANDOM', extensions: ['.java', '.kt'], pattern: /\b(?:new\s+Random\s*\(|java\s*\.\s*util\s*\.\s*Random|ThreadLocalRandom\s*\.\s*current|Math\s*\.\s*random\s*\()/, severity: 'high', confidence: 'medium', title: 'General-purpose Java/Kotlin randomness', cwe: 'CWE-338', recommendation: 'Use a properly configured SecureRandom for secrets and verify provider/platform behavior. General-purpose Random is predictable.' },
  { id: 'DART-RANDOM', extensions: ['.dart'], pattern: /\bRandom\s*\(/, severity: 'high', confidence: 'medium', title: 'Dart Random() without secure constructor', cwe: 'CWE-338', recommendation: 'Use Random.secure() for secret material and verify the platform implementation. Inspect fallbacks and release builds.' },
  { id: 'GO-MATH-RAND', extensions: ['.go'], pattern: /\brand\s*\.\s*(?:New|Int63|Uint32|Uint64|Read|Float64)\s*\(|\bmath\/rand(?:\/v2)?["/]/, severity: 'high', confidence: 'medium', title: 'Go math/rand near wallet code', cwe: 'CWE-338', recommendation: 'Use crypto/rand for secret bytes. math/rand is not a secret-generation boundary, even when automatically seeded.' },
  { id: 'C-RAND', extensions: ['.c', '.h', '.cpp', '.cc'], pattern: /\b(?:rand|rand_r|srand|srandom|drand48|random)\s*\(/, severity: 'high', confidence: 'medium', title: 'C/C++ general-purpose randomness', cwe: 'CWE-338', recommendation: 'Use the OS CSPRNG and check every error/fallback path. Never substitute rand(), time(), or a fixed seed for secret entropy.' },
  { id: 'SWIFT-SYSTEM-RANDOM', extensions: ['.swift'], pattern: /\bSystemRandomNumberGenerator\b|\b(?:Int|UInt\w*)\s*\.\s*random\s*\(/, severity: 'medium', confidence: 'medium', title: 'Swift general-purpose random API', cwe: 'CWE-338', recommendation: 'SystemRandomNumberGenerator is not documented as cryptographically secure. Use SecRandomCopyBytes or CryptoKit-supported secret generation and check errors.' },
  { id: 'RUST-SMALL-RNG', extensions: ['.rs'], pattern: /\bSmallRng\b|\bStdRng\s*::\s*seed_from_u64\b|\bseed_from_u64\s*\(/, severity: 'high', confidence: 'medium', title: 'Reduced or deterministically seeded Rust RNG', cwe: 'CWE-337', recommendation: 'Use OsRng or a vetted cryptographic RNG seeded by the OS. Never derive wallet secrets from a numeric helper seed.' },
  { id: 'SOLIDITY-PREDICTABLE', extensions: ['.sol'], pattern: /\bblock\s*\.\s*(?:timestamp|prevrandao|difficulty|number|hash)\b|\bblockhash\s*\(/, severity: 'medium', confidence: 'low', title: 'Predictable/on-chain value in source', cwe: 'CWE-330', recommendation: 'These values are not private entropy. Determine whether they influence secrets, lottery outcomes, or access control; do not assume a finding without impact.' },
  { id: 'BUFFER-UNINITIALIZED', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], pattern: /\bBuffer\s*\.\s*allocUnsafe(?:Slow)?\s*\(/, severity: 'medium', confidence: 'low', title: 'Uninitialized buffer allocation', cwe: 'CWE-908', recommendation: 'Check whether this buffer becomes secret material or is fully overwritten with CSPRNG output. Uninitialized memory is not an entropy source.' },
];

const POSITIVE_RULES = [
  { id: 'POS-WEB-CRYPTO', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'], pattern: /\bcrypto\s*\.\s*(?:getRandomValues|randomBytes|randomFillSync|randomFill)\s*\(/, label: 'Platform crypto random API' },
  { id: 'POS-PY-SECRETS', extensions: ['.py'], pattern: /\bsecrets\s*\.\s*(?:token_bytes|token_hex|randbits|SystemRandom)\b/, label: 'Python secrets API' },
  { id: 'POS-JAVA-SECURE', extensions: ['.java', '.kt'], pattern: /\bSecureRandom\b/, label: 'SecureRandom reference' },
  { id: 'POS-DART-SECURE', extensions: ['.dart'], pattern: /\bRandom\s*\.\s*secure\s*\(/, label: 'Dart Random.secure()' },
  { id: 'POS-GO-CRYPTO', extensions: ['.go'], pattern: /\b(?:crypto\/rand|rand\s*\.\s*Read\s*\()/, label: 'Go crypto/rand reference' },
  { id: 'POS-RUST-OS', extensions: ['.rs'], pattern: /\bOsRng\b|\bgetrandom\s*\(/, label: 'Rust OS randomness reference' },
  { id: 'POS-SWIFT-SEC', extensions: ['.swift'], pattern: /\bSecRandomCopyBytes\s*\(/, label: 'Security framework random bytes' },
];

const LIMITATIONS = [
  'Static triage only: a rule match is a lead, not a confirmed vulnerability or a bounty eligibility decision.',
  'The scanner does not execute code, resolve dependencies, perform full interprocedural data-flow analysis, or inspect compiled binaries.',
  'TypeScript/JSX and non-JavaScript languages use conservative text rules and may miss issues or flag harmless simulations/tests.',
  'A secure API reference does not prove correct length, error handling, unbiased conversion, seed secrecy, or absence of fallbacks.',
  'Only supplied files are inspected. Reports contain redacted evidence lines and file digests, never complete source files.',
];

function extensionOf(name) {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

/** Preserve source offsets while removing comments and quoted contents from rule matching. */
export function maskCommentsAndStrings(source) {
  let result = '';
  let state = 'code';
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; result += '  '; i++; }
      else if (char === '/' && next === '*') { state = 'block'; result += '  '; i++; }
      else if (char === '"' || char === "'" || char === '`') { state = char; result += ' '; }
      else result += char;
    } else if (state === 'line') {
      if (char === '\n') { state = 'code'; result += '\n'; } else result += ' ';
    } else if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; result += '  '; i++; } else result += char === '\n' ? '\n' : ' ';
    } else {
      if (char === '\\') { result += ' '; if (i + 1 < source.length) { result += source[i + 1] === '\n' ? '\n' : ' '; i++; } }
      else if (char === state) { state = 'code'; result += ' '; }
      else result += char === '\n' ? '\n' : ' ';
    }
  }
  return result;
}

export function redactEvidence(line) {
  return line.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '[redacted string]').replace(/\b(?:0x)?[0-9a-fA-F]{32,}\b/g, '[redacted hex]').replace(/\b[1-9A-HJ-NP-Za-km-z]{40,}\b/g, '[redacted encoded value]').slice(0, 240);
}

function locationAt(source, offset) {
  const prefix = source.slice(0, offset);
  const line = prefix.split('\n').length;
  const column = offset - prefix.lastIndexOf('\n');
  return { line, column };
}

function astObservations(source, extension) {
  if (!['.js', '.mjs', '.cjs'].includes(extension)) return { mode: 'text-heuristic', calls: [], secureCalls: 0, parseFallback: ['.jsx', '.ts', '.tsx'].includes(extension) };
  try {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowReturnOutsideFunction: true, locations: true });
    const calls = [];
    let secureCalls = 0;
    simple(ast, {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const object = callee.object.type === 'Identifier' ? callee.object.name : '';
        const property = callee.property.type === 'Identifier' ? callee.property.name : '';
        if (object === 'Math' && property === 'random') calls.push({ name: 'Math.random', line: node.loc.start.line, column: node.loc.start.column + 1 });
        if (property === 'getRandomValues' || property === 'randomBytes' || property === 'randomFillSync') secureCalls++;
      },
    });
    return { mode: 'javascript-ast', calls, secureCalls };
  } catch {
    return { mode: 'text-heuristic', calls: [], secureCalls: 0, parseFallback: true };
  }
}

async function digestText(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function scanSourceFile(file, options = {}) {
  const name = String(file?.name ?? 'unnamed').replace(/\\/g, '/').slice(0, 500);
  if (typeof file?.text !== 'string') throw new TypeError(`Source file ${name} must contain text.`);
  const bytes = new TextEncoder().encode(file.text).length;
  if (bytes > (options.maxFileBytes ?? SOURCE_LIMITS.maxFileBytes)) throw new Error(`${name} exceeds the per-file limit.`);
  const extension = extensionOf(name);
  if (!SOURCE_EXTENSIONS.includes(extension)) throw new Error(`Unsupported source extension: ${extension || '(none)'}.`);
  const masked = maskCommentsAndStrings(file.text);
  const lines = file.text.split('\n');
  const maskedLines = masked.split('\n');
  const ast = astObservations(file.text, extension);
  const findings = [];
  const seen = new Set();
  const add = (rule, line, column, confidence = rule.confidence) => {
    const key = `${rule.id}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ id: `${name}:${line}:${rule.id}`, ruleId: rule.id, severity: rule.severity, confidence, title: rule.title, cwe: rule.cwe, file: name, line, column, evidence: redactEvidence(lines[line - 1]?.trim() ?? ''), recommendation: rule.recommendation, engine: ast.mode });
  };
  for (const rule of RULES) {
    if (!rule.extensions.includes(extension)) continue;
    maskedLines.forEach((line, index) => {
      const match = rule.pattern.exec(line);
      if (match) add(rule, index + 1, match.index + 1, ast.mode === 'javascript-ast' && rule.id === 'JS-MATH-RANDOM' ? 'high' : rule.confidence);
    });
  }
  // Detect quoted import sources separately because the masker intentionally hides them.
  if (/\bfrom\s*['"](?:seedrandom|mersenne-twister|@stdlib\/random[^'"]*)['"]|\brequire\s*\(\s*['"](?:seedrandom|mersenne-twister)['"]/.test(file.text)) {
    const line = lines.findIndex((value) => /seedrandom|mersenne-twister|@stdlib\/random/.test(value));
    if (line >= 0) add(RULES.find((rule) => rule.id === 'JS-WEAK-PRNG'), line + 1, 1);
  }
  if (/["'](?:go\s*)?math\/rand(?:\/v2)?["']/.test(file.text)) {
    const line = lines.findIndex((value) => /math\/rand/.test(value));
    if (line >= 0) add(RULES.find((rule) => rule.id === 'GO-MATH-RAND'), line + 1, 1);
  }
  // Secret-looking literals are reported without copying the literal into evidence.
  const secretAssignment = /\b(?:privateKey|private_key|secretKey|secret_key|mnemonic|seedPhrase|seed_phrase|walletSeed)\b\s*[:=]\s*["'`][^"'`\n]{16,}["'`]/g;
  for (const match of file.text.matchAll(secretAssignment)) {
    const location = locationAt(file.text, match.index);
    add({ id: 'SECRET-LITERAL', severity: 'critical', confidence: 'medium', title: 'Possible hardcoded secret material', cwe: 'CWE-798', recommendation: 'Remove the literal from source and logs, rotate any real exposed secret through the owner, and confirm it is not a test fixture. Do not use it to access third-party funds.' }, location.line, location.column);
  }
  // Short secret buffers: require nearby key/entropy context to avoid flagging ordinary IVs.
  const shortBuffer = /\b(?:randomBytes|getRandomValues)\s*\(\s*(?:new\s+Uint8Array\s*\(\s*)?(\d{1,2})\b/g;
  for (const match of masked.matchAll(shortBuffer)) {
    const length = Number(match[1]);
    const location = locationAt(masked, match.index);
    const context = maskedLines.slice(Math.max(0, location.line - 3), location.line + 2).join(' ');
    if (length < 16 && /(?:key|entropy|mnemonic|seed|wallet)/i.test(context)) add({ id: 'SHORT-SECRET-BUFFER', severity: 'high', confidence: 'medium', title: 'Secret-named buffer shorter than 128 bits', cwe: 'CWE-326', recommendation: 'Trace the buffer into secret generation. BIP-39 entropy must be 128–256 bits in 32-bit steps; a secp256k1 private scalar is 256 bits. Confirm intended use before reporting.' }, location.line, location.column);
  }
  const positives = [];
  for (const rule of POSITIVE_RULES) {
    if (!rule.extensions.includes(extension)) continue;
    maskedLines.forEach((line, index) => {
      if (rule.pattern.test(line)) positives.push({ ruleId: rule.id, label: rule.label, file: name, line: index + 1 });
    });
  }
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line);
  return { name, extension, bytes, lines: lines.length, sha256: await digestText(file.text), mode: ast.mode, parseFallback: ast.parseFallback ?? false, findings, positives };
}

export async function scanSources(files, options = {}) {
  const limits = { ...SOURCE_LIMITS, ...options };
  if (!Array.isArray(files) || files.length === 0) throw new Error('Choose at least one authorized source file.');
  if (files.length > limits.maxFiles) throw new Error(`At most ${limits.maxFiles} source files can be scanned at once.`);
  let totalBytes = 0;
  const scanned = [], skipped = [];
  for (const file of files) {
    const name = String(file?.name ?? 'unnamed');
    if (typeof file?.text !== 'string') { skipped.push({ name, reason: 'Not a text file.' }); continue; }
    const bytes = new TextEncoder().encode(file.text).length;
    if (!SOURCE_EXTENSIONS.includes(extensionOf(name))) { skipped.push({ name, reason: 'Unsupported extension.' }); continue; }
    if (bytes > limits.maxFileBytes || totalBytes + bytes > limits.maxTotalBytes) { skipped.push({ name, reason: 'File or batch size limit exceeded.' }); continue; }
    totalBytes += bytes;
    scanned.push(await scanSourceFile(file, limits));
  }
  if (!scanned.length) throw new Error('No supported source files remained after size and extension checks.');
  const findings = scanned.flatMap((file) => file.findings).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const positives = scanned.flatMap((file) => file.positives);
  const severityCounts = Object.fromEntries(Object.keys(SEVERITY_ORDER).map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length]));
  return {
    schemaVersion: SOURCE_SCHEMA_VERSION, kind: 'source-audit', createdAt: options.now ?? new Date().toISOString(),
    verdict: findings.length ? 'review-required' : 'no-rule-match',
    summary: { filesScanned: scanned.length, filesSkipped: skipped.length, bytesScanned: totalBytes, findings: findings.length, severityCounts, positiveObservations: positives.length, astFiles: scanned.filter((file) => file.mode === 'javascript-ast').length },
    files: scanned.map(({ findings: _findings, positives: _positives, ...metadata }) => metadata), findings, positives, skipped, limitations: LIMITATIONS,
  };
}
