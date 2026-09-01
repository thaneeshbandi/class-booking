#!/usr/bin/env node
/**
 * Database task runner.
 *
 * Knex is driven through its programmatic API rather than the `knex` CLI: the
 * project is native ESM, and going through the library keeps one code path for
 * loading and validating the environment (knexfile imports the Zod-checked
 * config, so every task fails the same way on a bad environment).
 */
import { closeConnection, db } from '../src/db/knex.js';
import { env } from '../src/config/env.js';

const USAGE = `Usage: node scripts/db.js <command>

Commands:
  migrate    Run all pending migrations
  rollback   Roll back the most recent migration batch
  status     Show completed and pending migrations
  seed       Run seed files (idempotent; a no-op on an already-seeded database)
  reset      Roll back everything, migrate from zero, then seed
`;

async function migrate() {
  const [batch, applied] = await db.migrate.latest();
  if (applied.length === 0) {
    console.log('No pending migrations.');
    return;
  }
  console.log(`Batch ${batch} — applied ${applied.length} migration(s):`);
  for (const name of applied) console.log(`  ✓ ${name}`);
}

async function rollback() {
  const [batch, reverted] = await db.migrate.rollback();
  if (reverted.length === 0) {
    console.log('Nothing to roll back.');
    return;
  }
  console.log(`Rolled back batch ${batch} — ${reverted.length} migration(s):`);
  for (const name of reverted) console.log(`  ✓ ${name}`);
}

async function status() {
  const [completed, pending] = await db.migrate.list();
  console.log(`Completed (${completed.length}):`);
  for (const row of completed) console.log(`  ✓ ${row.name ?? row}`);
  console.log(`Pending (${pending.length}):`);
  for (const row of pending) console.log(`  · ${row.file ?? row}`);
}

async function seed() {
  const [files] = await db.seed.run();
  if (files.length === 0) {
    console.log('No seed files found.');
    return;
  }
  for (const file of files) console.log(`  ✓ ${file}`);
}

async function reset() {
  if (env.NODE_ENV === 'production') {
    throw new Error('refusing to reset the database with NODE_ENV=production');
  }
  console.log('Rolling back all migrations...');
  await db.migrate.rollback(undefined, true);
  console.log('Migrating from zero...');
  await migrate();
  console.log('Seeding...');
  await seed();
}

const commands = { migrate, rollback, status, seed, reset };

const command = process.argv[2];
if (!command || !Object.hasOwn(commands, command)) {
  console.error(USAGE);
  process.exitCode = 1;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`\n${command} failed: ${error.message}`);
    if (error.detail) console.error(`detail: ${error.detail}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
    process.exitCode = 1;
  }
}

await closeConnection();
