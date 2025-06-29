import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const connectionString = process.env.DATABASE_URL;

// Create PostgreSQL connection with authentication timeout fixes
const sql = postgres(connectionString, {
  max: 8, // Smaller pool to prevent authentication timeouts
  idle_timeout: 20, // Short idle timeout to prevent auth expiry
  connect_timeout: 15, // Quick connection timeout
  ssl: 'require',
  prepare: false,
  onnotice: () => {},
  debug: false,
  transform: {
    undefined: null
  },
  // Connection recovery settings
  onclose: function(connectionId: any) {
    console.log(`Database connection ${connectionId} closed - will reconnect`);
  },
  onconnect: function(connection: any) {
    console.log(`Database connection established successfully`);
  }
});

// Test connection and auto-retry on authentication timeout
export async function testDatabaseConnection() {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      await sql`SELECT 1 as test`;
      console.log('Database connection test successful');
      return true;
    } catch (error: any) {
      retryCount++;
      console.log(`Database connection test failed (attempt ${retryCount}): ${error.message}`);
      
      if (error.message.includes('Authentication timed out') && retryCount < maxRetries) {
        console.log('Retrying database connection in 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      
      if (retryCount >= maxRetries) {
        console.error('Database connection failed after all retries');
        return false;
      }
    }
  }
  return false;
}

export const db = drizzle(sql, { schema });
export const pool = sql;