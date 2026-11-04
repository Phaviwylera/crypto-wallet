import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSourceFile, scanSources, maskCommentsAndStrings, redactEvidence, SOURCE_LIMITS } from '../src/security/source-scanner.mjs';

const scan = (name, text) => scanSourceFile({ name, text });

test('JavaScript AST identifies Math.random with exact location', async () => {
  const result = await scan('wallet.js', 'const x = 1;\nconst entropy = Math.random();\n');
  const finding = result.findings.find((item) => item.ruleId === 'JS-MATH-RANDOM');
  assert.equal(result.mode, 'javascript-ast');
  assert.equal(finding.line, 2);
  assert.equal(finding.severity, 'high');
  assert.equal(finding.confidence, 'high');
});

test('comments and ordinary strings do not trigger weak RNG rules', async () => {
  const result = await scan('safe.js', '// Math.random()\nconst text = "Math.random()";\n/* Math.random() */\n');
  assert.equal(result.findings.length, 0);
});

test('masking preserves line offsets and handles escapes', () => {
  const source = 'const a = "x\\"y";\n// comment\nMath.random();';
  const masked = maskCommentsAndStrings(source);
  assert.equal(masked.split('\n').length, 3);
  assert.ok(masked.split('\n')[2].includes('Math.random'));
  assert.equal(masked.includes('comment'), false);
});

test('weak PRNG imports are detected despite string masking', async () => {
  const result = await scan('rng.js', "import seedrandom from 'seedrandom';\nconst rng = seedrandom('x');\n");
  assert.ok(result.findings.some((item) => item.ruleId === 'JS-WEAK-PRNG'));
});

test('clock-derived seed is flagged for manual data-flow review', async () => {
  const result = await scan('seed.js', 'const seed = Date.now();\n');
  assert.ok(result.findings.some((item) => item.ruleId === 'JS-TIME-SEED'));
});

test('Python random and Java Random are flagged', async () => {
  assert.ok((await scan('weak.py', 'import random\nx = random.getrandbits(256)\n')).findings.some((item) => item.ruleId === 'PY-RANDOM'));
  assert.ok((await scan('Weak.java', 'Random r = new Random();\n')).findings.some((item) => item.ruleId === 'JAVA-UTIL-RANDOM'));
});

test('Dart secure constructor is not flagged as insecure Random()', async () => {
  const insecure = await scan('weak.dart', 'final r = Random();\n');
  const secure = await scan('secure.dart', 'final r = Random.secure();\n');
  assert.ok(insecure.findings.some((item) => item.ruleId === 'DART-RANDOM'));
  assert.equal(secure.findings.length, 0);
  assert.ok(secure.positives.length > 0);
});

test('Go math/rand import is detected and crypto/rand is a positive observation', async () => {
  const weak = await scan('weak.go', 'package main\nimport "math/rand"\nfunc f() { rand.Uint64() }\n');
  const secure = await scan('secure.go', 'package main\nimport "crypto/rand"\nfunc f() { rand.Read(b) }\n');
  assert.ok(weak.findings.some((item) => item.ruleId === 'GO-MATH-RAND'));
  assert.ok(secure.positives.some((item) => item.ruleId === 'POS-GO-CRYPTO'));
});

test('C, Swift, Rust and Solidity heuristics produce triage leads', async () => {
  assert.ok((await scan('weak.c', 'int x = rand();\n')).findings.some((item) => item.ruleId === 'C-RAND'));
  assert.ok((await scan('weak.swift', 'let x = Int.random(in: 0...255)\n')).findings.some((item) => item.ruleId === 'SWIFT-SYSTEM-RANDOM'));
  assert.ok((await scan('weak.rs', 'let rng = SmallRng::seed_from_u64(7);\n')).findings.some((item) => item.ruleId === 'RUST-SMALL-RNG'));
  assert.ok((await scan('weak.sol', 'uint x = block.timestamp;\n')).findings.some((item) => item.ruleId === 'SOLIDITY-PREDICTABLE'));
});

test('short secret buffer requires key context', async () => {
  const weak = await scan('key.js', 'const walletKey = crypto.randomBytes(8);\n');
  const iv = await scan('iv.js', 'const iv = crypto.randomBytes(12);\n');
  assert.ok(weak.findings.some((item) => item.ruleId === 'SHORT-SECRET-BUFFER'));
  assert.equal(iv.findings.length, 0);
  assert.ok(iv.positives.length > 0);
});

test('hardcoded secret evidence is redacted', async () => {
  const secret = '0x' + 'ab'.repeat(32);
  const result = await scan('secret.js', `const privateKey = "${secret}";\n`);
  const finding = result.findings.find((item) => item.ruleId === 'SECRET-LITERAL');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.evidence.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('redaction removes long hex and quoted literals', () => {
  assert.equal(redactEvidence('const x = "hello secret";').includes('hello secret'), false);
  assert.equal(redactEvidence('0x' + 'ff'.repeat(40)).includes('ffffffff'), false);
});

test('secure API reference is not reported as a clean bill of health', async () => {
  const result = await scanSources([{ name: 'secure.js', text: 'crypto.getRandomValues(new Uint8Array(32));' }]);
  assert.equal(result.verdict, 'no-rule-match');
  assert.ok(result.summary.positiveObservations > 0);
  assert.ok(result.limitations.some((line) => line.includes('does not prove')));
});

test('unsupported files are skipped and unsupported-only batches fail', async () => {
  const result = await scanSources([{ name: 'a.js', text: 'Math.random();' }, { name: 'readme.md', text: '# hi' }]);
  assert.equal(result.summary.filesScanned, 1);
  assert.equal(result.summary.filesSkipped, 1);
  await assert.rejects(scanSources([{ name: 'readme.md', text: '# hi' }]), /No supported source files/);
  await assert.rejects(scanSources([]), /at least one/);
});

test('file and batch limits are enforced', async () => {
  await assert.rejects(scan('big.js', 'x'.repeat(SOURCE_LIMITS.maxFileBytes + 1)), /per-file limit/);
  const files = Array.from({ length: SOURCE_LIMITS.maxFiles + 1 }, (_, i) => ({ name: `${i}.js`, text: '' }));
  await assert.rejects(scanSources(files), /At most/);
});

test('JSX falls back explicitly instead of pretending to parse', async () => {
  const result = await scan('component.tsx', 'export const X = () => <div>{Math.random()}</div>;');
  assert.equal(result.mode, 'text-heuristic');
  assert.equal(result.parseFallback, true);
  assert.ok(result.findings.some((item) => item.ruleId === 'JS-MATH-RANDOM'));
});

test('source report contains metadata and redacted findings, not full files', async () => {
  const text = 'const marker = "UNIQUE_FULL_SOURCE_MARKER";\nMath.random();\n';
  const result = await scanSources([{ name: 'wallet.js', text }]);
  assert.match(result.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('UNIQUE_FULL_SOURCE_MARKER'), false);
  assert.equal(result.files[0].lines, 3);
});
