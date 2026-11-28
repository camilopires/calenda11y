// Runs before every build so a missing or invalid variable fails the deploy,
// rather than surfacing on the first request to a cold serverless function.
import { EnvError, parseEnv } from '../src/lib/env.ts';

try {
  const e = parseEnv(process.env);
  console.log(`Environment OK (APP_ENV=${e.APP_ENV}, sponsorship ${e.SPONSORSHIP})`);
} catch (error) {
  if (error instanceof EnvError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
