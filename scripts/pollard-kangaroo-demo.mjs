import { runPollardKangarooDemo } from '../src/pollard-kangaroo-demo.js';

const result = runPollardKangarooDemo();
console.log('Pollard kangaroo · synthetic toy example');
console.log(`Search interval: [${BigInt(result.lower).toLocaleString()}, ${BigInt(result.upper).toLocaleString()}] (${BigInt(result.width).toLocaleString()} gap)`);
console.log('Toy secret selected internally: 345,678');
console.log(`Tame steps: ${result.tameSteps.toLocaleString()}; wild steps: ${result.wildSteps.toLocaleString()}`);
console.log(`Measured walk rate: ${Math.round(result.walkStepsPerSecond).toLocaleString()} steps/second (${result.elapsedMs.toFixed(1)} ms); walk steps are not address candidates.`);
if (!result.recovered) {
  console.error('No collision produced an in-range answer in this run.');
  process.exitCode = 1;
} else {
  console.log(`Recovered toy scalar: ${BigInt(result.recovered).toLocaleString()}`);
  console.log(`Independent verification Q = dG: ${result.verified ? 'passed' : 'failed'}`);
}
console.log('This toy uses a known, deliberately small interval. It is not a wallet-recovery tool.');
