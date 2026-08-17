#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BOARD_PATH = path.join(ROOT, "docs", "agent-board.json");
const JOURNAL_PATH = path.join(ROOT, "docs", "agent-journal.jsonl");
const STATUSES = new Set(["todo", "claimed", "in_progress", "review", "blocked", "done", "dropped"]);

function usage(exitCode = 0) {
  console.log(`Usage:
  node scripts/agent-board.js list
  node scripts/agent-board.js show <task-id>
  node scripts/agent-board.js claim <task-id> --agent <name>
  node scripts/agent-board.js update <task-id> --status <status> [--agent <name>] [--note <text>]
  node scripts/agent-board.js add <title> [--agent <name>] [--scope <path[,path]>] [--note <text>]
  node scripts/agent-board.js note --agent <name> --text <text>

Status values:
  ${[...STATUSES].join(", ")}
`);
  process.exit(exitCode);
}

function parse(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

function now() {
  return new Date().toISOString();
}

function ensureBoard() {
  if (!fs.existsSync(BOARD_PATH)) {
    throw new Error("Missing docs/agent-board.json. Create the board before using this helper.");
  }
}

function readBoard() {
  ensureBoard();
  return JSON.parse(fs.readFileSync(BOARD_PATH, "utf8"));
}

function writeBoard(board, event) {
  fs.mkdirSync(path.dirname(BOARD_PATH), { recursive: true });
  board.updatedAt = now();
  const tmp = `${BOARD_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, BOARD_PATH);
  if (event) {
    fs.appendFileSync(JOURNAL_PATH, `${JSON.stringify({ time: now(), ...event })}\n`, "utf8");
  }
}

function findTask(board, id) {
  const task = board.tasks.find((item) => item.id === id);
  if (!task) {
    throw new Error(`Unknown task id: ${id}`);
  }
  return task;
}

function requireValue(args, key) {
  if (!args[key] || args[key] === true) {
    throw new Error(`Missing --${key}`);
  }
  return String(args[key]);
}

function splitScope(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nextTaskId(board) {
  const numbers = board.tasks
    .map((task) => String(task.id).match(/^hell-bench-(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const next = numbers.length ? Math.max(...numbers) + 1 : 1;
  return `hell-bench-${String(next).padStart(3, "0")}`;
}

function listTasks(board) {
  for (const task of board.tasks) {
    const owner = task.agent ? ` @${task.agent}` : "";
    console.log(`${task.id.padEnd(15)} ${task.status.padEnd(11)} ${task.title}${owner}`);
  }
}

function showTask(task) {
  console.log(JSON.stringify(task, null, 2));
}

function claim(board, id, agent) {
  const task = findTask(board, id);
  if (!["todo", "claimed", "blocked"].includes(task.status) && task.agent && task.agent !== agent) {
    throw new Error(`Task ${id} is ${task.status} by ${task.agent}.`);
  }
  task.status = "claimed";
  task.agent = agent;
  task.updatedAt = now();
  task.notes.push(`Claimed by ${agent}.`);
  writeBoard(board, { type: "claim", taskId: id, agent });
  console.log(`claimed ${id} by ${agent}`);
}

function updateTask(board, id, status, agent, note) {
  if (!STATUSES.has(status)) {
    throw new Error(`Invalid status: ${status}`);
  }
  const task = findTask(board, id);
  task.status = status;
  if (agent) task.agent = agent;
  task.updatedAt = now();
  if (note) task.notes.push(note);
  writeBoard(board, { type: "update", taskId: id, status, agent: agent || task.agent || "", note: note || "" });
  console.log(`updated ${id} -> ${status}`);
}

function addTask(board, title, agent, scope, note) {
  const task = {
    id: nextTaskId(board),
    title,
    status: agent ? "claimed" : "todo",
    agent: agent || "",
    scope,
    notes: note ? [note] : [],
    updatedAt: now()
  };
  board.tasks.push(task);
  writeBoard(board, { type: "add", taskId: task.id, agent: agent || "", title });
  console.log(`added ${task.id}: ${title}`);
}

function addNote(agent, text) {
  fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
  fs.appendFileSync(JOURNAL_PATH, `${JSON.stringify({ time: now(), type: "note", agent, text })}\n`, "utf8");
  console.log("noted");
}

function main() {
  const args = parse(process.argv.slice(2));
  const [command, idOrTitle] = args._;
  if (!command || command === "help" || command === "--help") usage(0);

  if (command === "note") {
    addNote(requireValue(args, "agent"), requireValue(args, "text"));
    return;
  }

  const board = readBoard();

  if (command === "list") {
    listTasks(board);
    return;
  }
  if (command === "show") {
    if (!idOrTitle) throw new Error("show requires a task id.");
    showTask(findTask(board, idOrTitle));
    return;
  }
  if (command === "claim") {
    if (!idOrTitle) throw new Error("claim requires a task id.");
    claim(board, idOrTitle, requireValue(args, "agent"));
    return;
  }
  if (command === "update") {
    if (!idOrTitle) throw new Error("update requires a task id.");
    updateTask(board, idOrTitle, requireValue(args, "status"), args.agent ? String(args.agent) : "", args.note ? String(args.note) : "");
    return;
  }
  if (command === "add") {
    if (!idOrTitle) throw new Error("add requires a title.");
    addTask(board, idOrTitle, args.agent ? String(args.agent) : "", splitScope(args.scope), args.note ? String(args.note) : "");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
