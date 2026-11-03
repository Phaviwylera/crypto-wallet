import { getBitcoinPuzzle } from './bitcoin-puzzles.js';
import { parseSearchRange } from './search-range.js';

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

function hasCompleteCoverage(job) {
  if (job.state !== 'COMPLETED' || job.found) return false;
  try {
    return BigInt(job.done) >= BigInt(job.total);
  } catch {
    return false;
  }
}

function completedIntervals(jobs, puzzle) {
  const publishedLower = BigInt(puzzle.lower);
  const publishedUpper = BigInt(puzzle.upper);
  const intervals = [];
  for (const job of jobs) {
    if (Number(job.puzzle) !== puzzle.id || !hasCompleteCoverage(job)) continue;
    try {
      const start = BigInt(job.lower);
      const end = BigInt(job.upper);
      if (start > end || end < publishedLower || start > publishedUpper) continue;
      intervals.push({ start: start < publishedLower ? publishedLower : start, end: end > publishedUpper ? publishedUpper : end });
    } catch {
      // Invalid or incomplete registry entries never count as scanned coverage.
    }
  }
  intervals.sort((left, right) => left.start < right.start ? -1 : left.start > right.start ? 1 : 0);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 1n) {
      if (interval.end > previous.end) previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function unscannedGaps(requested, completed) {
  const gaps = [];
  let cursor = requested.start;
  for (const interval of completed) {
    if (interval.end < cursor) continue;
    if (interval.start > requested.end) break;
    if (interval.start > cursor) {
      const end = interval.start - 1n < requested.end ? interval.start - 1n : requested.end;
      gaps.push({ start: cursor, end });
    }
    if (interval.end >= cursor) cursor = interval.end + 1n;
    if (cursor > requested.end) break;
  }
  if (cursor <= requested.end) gaps.push({ start: cursor, end: requested.end });
  return gaps.filter((gap) => gap.start <= gap.end);
}

export function planNativePuzzleRange(puzzleId, lower, upper, jobs = []) {
  const puzzle = getBitcoinPuzzle(Number(puzzleId));
  const lowerText = String(lower ?? '').trim();
  const upperText = String(upper ?? '').trim();
  const automatic = !lowerText && !upperText;
  const requested = parseSearchRange(lowerText || puzzle.lower, upperText || puzzle.upper);
  if (requested.start < BigInt(puzzle.lower) || requested.end > BigInt(puzzle.upper)) {
    throw new Error(`The requested interval is outside puzzle #${puzzle.id}'s published bounds.`);
  }
  const gaps = unscannedGaps(requested, completedIntervals(jobs, puzzle));
  if (!gaps.length) throw conflict(`The requested interval is already fully covered by completed puzzle #${puzzle.id} campaigns.`);
  const selected = gaps[0];
  const unfinished = jobs.find((job) => {
    if (Number(job.puzzle) !== puzzle.id || hasCompleteCoverage(job)) return false;
    try {
      return BigInt(job.lower) <= selected.end && BigInt(job.upper) >= selected.start;
    } catch {
      return false;
    }
  });
  if (unfinished) {
    throw conflict(`The next unscanned interval overlaps ${unfinished.campaign || 'an existing campaign'} (${unfinished.state || 'not completed'}). Use that campaign's available action or choose a different interval; a partial or stopped count is not contiguous coverage.`);
  }
  return {
    puzzle,
    range: { start: selected.start, end: selected.end, count: selected.end - selected.start + 1n },
    automatic,
    adjusted: selected.start !== requested.start || selected.end !== requested.end,
    requested,
  };
}
