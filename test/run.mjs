#!/usr/bin/env node
/**
 * Offline test runner: the cases `npm test` is expected to execute.
 *
 * The suites register cases through `test/harness.mjs` and never run on import,
 * so `node --test` would report every file as a passing test while executing
 * nothing. This runner drives the offline sections explicitly and fails the
 * process when a case throws.
 *
 * Browser and network are not required: fixtures and live sections live behind
 * `npm run accept`.
 */
import process from 'node:process'

import { reset, runAll } from './harness.mjs'

const suites = ['./unit.test.mjs', './modes.test.mjs', './provision.test.mjs', './cdp.test.mjs', './download.test.mjs', './engine.test.mjs']
let total = 0
const failures = []

for (const suite of suites) {
  reset()
  await import(suite)
  const summary = await runAll()
  total += summary.total
  failures.push(...summary.failures)
}

if (failures.length > 0) {
  console.error(`\nFAILED ${failures.length}/${total} case(s):`)
  for (const name of failures) console.error(`  - ${name}`)
  process.exit(1)
}
console.log(`\nPASSED ${total} case(s) across ${suites.length} suites`)
