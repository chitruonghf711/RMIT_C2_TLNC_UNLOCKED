import { ensureSeeded } from "../src/lib/db/seed";
import { getDb } from "../src/lib/db";

const forceReset = process.argv.includes("--reset");
ensureSeeded(forceReset);

const db = getDb();
const orgCount = (
  db.prepare("SELECT COUNT(*) as cnt FROM organizations").get() as {
    cnt: number;
  }
).cnt;
const userCount = (
  db.prepare("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number }
).cnt;
const caseCount = (
  db.prepare("SELECT COUNT(*) as cnt FROM cases").get() as { cnt: number }
).cnt;
const catCount = (
  db.prepare("SELECT COUNT(*) as cnt FROM test_catalog_entries").get() as {
    cnt: number;
  }
).cnt;

console.log(
  `[CaseBridge Seed] Completed (reset=${forceReset}): ${orgCount} organizations, ${userCount} users, ${caseCount} cases, ${catCount} test catalog entries.`
);
