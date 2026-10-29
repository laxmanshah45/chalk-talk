// Daily limits on the work that costs API credit, so a public server can't run up the bill.
// Every limit comes from .env; leaving one unset (or 0) means no limit, which is the default
// when Chalk Talk runs on your own computer.

const num = (name) => Math.max(0, Math.floor(Number(process.env[name]) || 0));

const LIMITS = {
  lesson: { total: num("LESSONS_PER_DAY"), visitor: num("LESSONS_PER_VISITOR_PER_DAY") },
  question: { total: num("QUESTIONS_PER_DAY"), visitor: num("QUESTIONS_PER_VISITOR_PER_DAY") },
};
const MAX_BUILDS = num("MAX_BUILDS_AT_ONCE");

const MESSAGES = {
  lesson: {
    total: "Today's free lessons are all used up. Play the sample lesson, or come back tomorrow.",
    visitor: "You've made today's free lessons. Play the sample or your saved lessons, or come back tomorrow.",
  },
  question: {
    total: "Today's free questions are all used up. Come back tomorrow to ask more.",
    visitor: "You've asked today's free questions. Come back tomorrow to ask more.",
  },
};

let day = "";
let counts = new Map();
let building = 0;

function resetIfNewDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    counts = new Map();
  }
}

// Who's asking. Behind a proxy like Caddy (TRUST_PROXY=1), that's the first address it forwards.
function visitorOf(req) {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || "unknown";
}

// Count one use of `kind` ("lesson" or "question"). Returns an error message if a limit is
// reached (and counts nothing), or null when the use is allowed.
function take(kind, req) {
  resetIfNewDay();
  const limit = LIMITS[kind];
  const visitor = `${kind}:${visitorOf(req)}`;
  const total = `${kind}:*`;
  if (limit.total && (counts.get(total) || 0) >= limit.total) return MESSAGES[kind].total;
  if (limit.visitor && (counts.get(visitor) || 0) >= limit.visitor) return MESSAGES[kind].visitor;
  counts.set(total, (counts.get(total) || 0) + 1);
  counts.set(visitor, (counts.get(visitor) || 0) + 1);
  return null;
}

// Lessons being made at the same time, so a small server isn't overwhelmed.
// Returns a release function, or null when the server is already busy.
function startBuild() {
  if (MAX_BUILDS && building >= MAX_BUILDS) return null;
  building++;
  let released = false;
  return () => {
    if (!released) { released = true; building--; }
  };
}

const BUSY = "A few lessons are being made right now. Try again in a minute.";

function describe() {
  const parts = [];
  if (LIMITS.lesson.total || LIMITS.lesson.visitor) parts.push(`lessons ${LIMITS.lesson.total || "∞"}/day (${LIMITS.lesson.visitor || "∞"} per visitor)`);
  if (LIMITS.question.total || LIMITS.question.visitor) parts.push(`questions ${LIMITS.question.total || "∞"}/day (${LIMITS.question.visitor || "∞"} per visitor)`);
  if (MAX_BUILDS) parts.push(`${MAX_BUILDS} lessons made at once`);
  return parts.length ? `Limits: ${parts.join(", ")}` : "";
}

module.exports = { take, startBuild, BUSY, describe };
