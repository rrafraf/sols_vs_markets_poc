#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const defaultRawDir = path.join(repoRoot, "research", "tradingview", "raw");
const defaultNotesDir = path.join(repoRoot, "research", "tradingview", "notes");
const defaultTemplatePath = path.join(
  repoRoot,
  "research",
  "tradingview",
  "templates",
  "pine-intake-note.md"
);

function usage(exitCode = 0) {
  console.log(`Usage:
  node scripts/create-tradingview-intake-note.js [options]

Options:
  --create              Create missing note stubs. Default is preview only.
  --script <filename>   Create or preview a note for one file under raw/.
  --raw-dir <path>      Override raw script directory.
  --notes-dir <path>    Override notes output directory.
  --template <path>     Override note template path.
  --force               Overwrite an existing note. Use carefully.
  --help                Show this help.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    create: false,
    force: false,
    script: null,
    rawDir: defaultRawDir,
    notesDir: defaultNotesDir,
    templatePath: defaultTemplatePath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--create") {
      args.create = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--script") {
      args.script = argv[++index];
    } else if (arg === "--raw-dir") {
      args.rawDir = argv[++index];
    } else if (arg === "--notes-dir") {
      args.notesDir = argv[++index];
    } else if (arg === "--template") {
      args.templatePath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      usage(0);
    } else {
      console.error(`Unknown option: ${arg}`);
      usage(1);
    }
  }

  if (!args.script && argv.includes("--script")) {
    console.error("--script requires a filename.");
    usage(1);
  }

  args.rawDir = path.resolve(args.rawDir);
  args.notesDir = path.resolve(args.notesDir);
  args.templatePath = path.resolve(args.templatePath);
  return args;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function slugify(name) {
  const parsed = path.parse(name);
  const base = parsed.name || name;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "pine-script";
}

function isCandidateFile(entry) {
  if (!entry.isFile()) {
    return false;
  }

  const name = entry.name;
  if (name.startsWith(".")) {
    return false;
  }

  return true;
}

function readRawMetadata(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const version = text.match(/\/\/\s*@version\s*=\s*([0-9]+)/i)?.[1] || "unknown";
  const title =
    text.match(/\b(?:indicator|strategy|study)\s*\(\s*["']([^"']+)["']/i)?.[1] ||
    path.parse(filePath).name;
  const inputLines = text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => /\binput(?:\.[a-z_]+)?\s*\(/i.test(line))
    .slice(0, 12);

  return { title, version, inputLines };
}

function fillTemplate(template, sourceName, metadata) {
  const inputText = metadata.inputLines.length
    ? metadata.inputLines.map((item) => `  - line ${item.number}: \`${item.line}\``).join("\n")
    : "  - none detected by helper";

  return template
    .replaceAll("{{title}}", metadata.title)
    .replaceAll("{{source_file}}", `research/tradingview/raw/${sourceName}`)
    .replaceAll("{{created_at}}", new Date().toISOString().slice(0, 10))
    .replace("- Pine version:", `- Pine version: ${metadata.version}`)
    .replace("- Inputs detected:", `- Inputs detected:\n${inputText}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (isInside(args.rawDir, args.notesDir)) {
    console.error("Refusing to write notes inside the raw drop zone.");
    process.exit(1);
  }

  if (!fs.existsSync(args.rawDir)) {
    console.log(`Raw directory not found: ${args.rawDir}`);
    console.log("Nothing to preview or create.");
    return;
  }

  let candidates;
  if (args.script) {
    const rawFile = path.resolve(args.rawDir, args.script);
    if (!isInside(args.rawDir, rawFile)) {
      console.error("--script must point to a file inside the raw directory.");
      process.exit(1);
    }
    if (!fs.existsSync(rawFile) || !fs.statSync(rawFile).isFile()) {
      console.error(`Raw script not found: ${rawFile}`);
      process.exit(1);
    }
    candidates = [{ name: path.basename(rawFile), path: rawFile }];
  } else {
    candidates = fs
      .readdirSync(args.rawDir, { withFileTypes: true })
      .filter(isCandidateFile)
      .map((entry) => ({
        name: entry.name,
        path: path.join(args.rawDir, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (!candidates.length) {
    console.log(`No raw script candidates found in ${args.rawDir}`);
    return;
  }

  const template = fs.readFileSync(args.templatePath, "utf8");
  const planned = candidates.map((candidate) => {
    const noteName = `${slugify(candidate.name)}.md`;
    const notePath = path.join(args.notesDir, noteName);
    return {
      ...candidate,
      notePath,
      exists: fs.existsSync(notePath),
      metadata: readRawMetadata(candidate.path),
    };
  });

  if (!args.create) {
    console.log("Preview only. Pass --create to write missing note stubs.");
    for (const item of planned) {
      const status = item.exists ? "exists" : "missing";
      console.log(`${status}: ${item.name} -> ${path.relative(repoRoot, item.notePath)}`);
    }
    return;
  }

  fs.mkdirSync(args.notesDir, { recursive: true });
  for (const item of planned) {
    if (isInside(args.rawDir, item.notePath)) {
      console.error(`Refusing to write note inside raw: ${item.notePath}`);
      process.exit(1);
    }

    if (item.exists && !args.force) {
      console.log(`skip existing: ${path.relative(repoRoot, item.notePath)}`);
      continue;
    }

    const body = fillTemplate(template, item.name, item.metadata);
    fs.writeFileSync(item.notePath, body, "utf8");
    console.log(`${item.exists ? "updated" : "created"}: ${path.relative(repoRoot, item.notePath)}`);
  }
}

main();
