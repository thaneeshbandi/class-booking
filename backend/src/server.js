/**
 * Process entry point.
 *
 * The real startup lives in `start.js` and is imported dynamically so that a
 * configuration mistake — by far the most likely deployment failure — surfaces
 * as a readable message rather than a module-evaluation stack trace. Env
 * validation runs on the first import of `config/env.js`, which happens inside
 * that dynamic import.
 */
try {
  await import('./start.js');
} catch (error) {
  if (error?.name === 'EnvValidationError') {
    console.error(`\n${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
