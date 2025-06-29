import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Use postgres-js for more stable connections than Neon serverless
const connectionString = process.env.DATABASE_URL;

// Create stable PostgreSQL connection with authentication timeout prevention
const sql = postgres(connectionString, {
  max: 8, // Smaller pool to prevent auth timeouts
  idle_timeout: 20, // Short idle timeout
  connect_timeout: 15, // Quick connection timeout
  ssl: 'require',
  prepare: false,
  onnotice: () => {},
  debug: false,
  transform: {
    undefined: null
  }
});

export const db = drizzle(sql, { schema });
export const pool = sql; // Export for compatibility
