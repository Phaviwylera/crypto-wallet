#!/usr/bin/env node
// Run the optional Python Shor demo using the isolated quantum venv when present.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const venv = path.join(root, '.runtime/quantum-venv/bin/python');
const python = process.env.QUANTUM_PYTHON || (existsSync(venv) ? venv : 'python3');
const child = spawn(python, [path.join(root, 'scripts/shors_algorithm.py'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: root });
child.on('error', () => { console.error('Python not found. Run: bash scripts/setup-shors-lab.sh'); process.exit(1); });
child.on('close', (code) => process.exit(code ?? 1));
