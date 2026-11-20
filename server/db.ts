import { Client } from "pg";

type HyperdriveEnv = Pick<Env, "HYPERDRIVE">;

export async function withDatabase<T>(
  env: HyperdriveEnv,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });

  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.end().catch((error) => {
      console.error("Database client cleanup failed", error);
    });
  }
}

export async function withTransaction<T>(
  env: HyperdriveEnv,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  return withDatabase(env, async (client) => {
    await client.query("BEGIN");

    try {
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Database transaction rollback failed",
          rollbackError,
        );
      }

      throw error;
    }
  });
}