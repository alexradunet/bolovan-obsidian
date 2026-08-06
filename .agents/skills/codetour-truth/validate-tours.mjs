import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const tourRoot = resolve(root, ".tours");
const failures = [];

function collectTours(directory) {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return collectTours(path);
    }
    return entry.isFile() && entry.name.endsWith(".tour") ? [path] : [];
  });
}

function fail(file, message) {
  failures.push(`${file}: ${message}`);
}

const paths = collectTours(tourRoot);
if (paths.length === 0) {
  fail(".tours", "no .tour files found");
}

const tours = [];
for (const path of paths) {
  const file = path.slice(root.length + 1);
  let tour;
  try {
    tour = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(file, `invalid JSON: ${error.message}`);
    continue;
  }

  if (!tour || typeof tour !== "object" || Array.isArray(tour)) {
    fail(file, "tour must be a JSON object");
    continue;
  }
  if (typeof tour.title !== "string" || !tour.title.trim()) {
    fail(file, "title must be a non-empty string");
  }
  if (!Array.isArray(tour.steps) || tour.steps.length === 0) {
    fail(file, "steps must be a non-empty array");
  }
  tours.push({ file, tour });
}

const titleCounts = new Map();
for (const { tour } of tours) {
  titleCounts.set(tour.title, (titleCounts.get(tour.title) ?? 0) + 1);
}
for (const [title, count] of titleCounts) {
  if (count > 1) {
    fail(".tours", `duplicate tour title: ${title}`);
  }
}

const primaryCount = tours.filter(({ tour }) => tour.isPrimary === true).length;
if (primaryCount !== 1) {
  fail(".tours", `expected exactly one primary tour, found ${primaryCount}`);
}

for (const { file, tour } of tours) {
  if (tour.nextTour !== undefined && !titleCounts.has(tour.nextTour)) {
    fail(file, `nextTour does not name an existing title: ${tour.nextTour}`);
  }

  for (const [index, step] of (tour.steps ?? []).entries()) {
    const label = `step ${index + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      fail(file, `${label} must be an object`);
      continue;
    }
    if (typeof step.description !== "string" || !step.description.trim()) {
      fail(file, `${label} description must be a non-empty string`);
    }
    if (typeof step.file !== "string" || !step.file.trim()) {
      fail(file, `${label} must reference a file`);
      continue;
    }

    const target = resolve(root, step.file);
    if (!target.startsWith(`${root}/`) || !existsSync(target) || !statSync(target).isFile()) {
      fail(file, `${label} target is not a repository file: ${step.file}`);
      continue;
    }

    const content = readFileSync(target, "utf8");
    if (step.line !== undefined) {
      const lineCount = content.split("\n").length;
      if (!Number.isInteger(step.line) || step.line < 1 || step.line > lineCount) {
        fail(file, `${label} line ${step.line} is outside ${step.file} (1-${lineCount})`);
      }
    }
    if (step.pattern !== undefined) {
      if (typeof step.pattern !== "string" || !step.pattern) {
        fail(file, `${label} pattern must be a non-empty string`);
        continue;
      }
      let matches;
      try {
        matches = [...content.matchAll(new RegExp(step.pattern, "gm"))].length;
      } catch (error) {
        fail(file, `${label} has invalid pattern: ${error.message}`);
        continue;
      }
      if (matches !== 1) {
        fail(file, `${label} pattern matches ${matches} locations in ${step.file}; expected 1`);
      }
    }
    if (step.line === undefined && step.pattern === undefined) {
      fail(file, `${label} needs a line or pattern anchor`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  const stepCount = tours.reduce((sum, { tour }) => sum + tour.steps.length, 0);
  console.log(`Validated ${tours.length} CodeTours and ${stepCount} anchored steps.`);
}
