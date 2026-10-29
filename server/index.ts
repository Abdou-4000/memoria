import { Hono } from "hono";
import { Client } from "pg";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/", (c) => {
  return c.json({
    name: "Memoria API v1",
    ok: true,
  });
});

app.get("/api/health", (c) => {
  return c.json({
	ok: true,
  });
});

app.get("/api/db-health", async (c) => {
  const client = new Client({
    connectionString: c.env.HYPERDRIVE.connectionString,
  });

  try {
    await client.connect();
    await client.query("SELECT 1");

    return c.json({
      ok: true,
      database: "connected",
    });
  } catch (error) {
    console.error("Database connectivity check failed", error);

    return c.json(
      {
        ok: false,
        database: "unavailable",
      },
      503,
    );
  } finally {
    await client.end().catch((error) => {
      console.error("Database client cleanup failed", error);
    });
  }
});

app.notFound((c) => {
  return c.json(
    { error: "Not found" },
    404,
  );
});

app.onError((error, c) => {
  console.error("Unhandled API error", error);

  return c.json(
    { error: "Internal server error" },
    500,
  );
});

export default app;