// All settings come from environment variables, with defaults for local development.
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(env('PORT', '3000')),
  databaseUrl: env('DATABASE_URL', 'postgres://sitetrack:sitetrack@localhost:5433/sitetrack'),
  jwtSecret: env('JWT_SECRET', 'dev-only-secret-change-me'),
};
