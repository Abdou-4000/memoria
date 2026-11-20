import { googleAuth, type GoogleUser } from "@hono/oauth-providers/google";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context, Hono } from "hono";
import { withDatabase } from "./db";

const SESSION_COOKIE_NAME = "memoria_session";
const SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const GOOGLE_SCOPES = ["openid", "email", "profile"];

type AuthApp = Hono<{ Bindings: Env }>;

type Contributor = {
  id: string;
  email: string | null;
  display_name: string | null;
  is_curator: boolean;
};

type SessionPayload = {
  contributorId: string;
  exp: number;
};

const textEncoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

const fromBase64Url = (value: string): Uint8Array | null => {
  try {
    const base64 = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')

    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }

    return bytes
  } catch {
    return null
  }
}

const importSessionKey = async (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );

const signPayload = async (
  payload: string,
  secret: string,
): Promise<string> => {
  const key = await importSessionKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(payload),
  );

  return toBase64Url(new Uint8Array(signature));
};

const constantTimeEqual = (
  left: Uint8Array,
  right: Uint8Array,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }

  return difference === 0;
};

const verifySignature = async (
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> => {
  const expected = fromBase64Url(await signPayload(payload, secret));
  const actual = fromBase64Url(signature);

  if (!expected || !actual) {
    return false;
  }

  return constantTimeEqual(expected, actual);
};

const serializeSession = async (
  contributorId: string,
  secret: string,
): Promise<string> => {
  const exp = Math.floor(Date.now() / 1000) + SESSION_LIFETIME_SECONDS;
  const payload = JSON.stringify({ contributorId, exp });
  const signature = await signPayload(payload, secret);

  return `${toBase64Url(textEncoder.encode(payload))}.${signature}`;
};

const readSession = async (
  cookieValue: string | undefined,
  secret: string,
): Promise<SessionPayload | null> => {
  if (!cookieValue) {
    return null;
  }

  const separator = cookieValue.lastIndexOf(".");

  if (separator <= 0 || separator === cookieValue.length - 1) {
    return null;
  }

  const payloadPart = cookieValue.slice(0, separator);
  const signaturePart = cookieValue.slice(separator + 1);
  const payloadBytes = fromBase64Url(payloadPart);

  if (!payloadBytes) {
    return null;
  }

  const payload = new TextDecoder().decode(payloadBytes);

  if (
    !(await verifySignature(payload, signaturePart, secret))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<SessionPayload>;

    if (
      typeof parsed.contributorId !== "string" ||
      !/^[1-9]\d*$/.test(parsed.contributorId) ||
      typeof parsed.exp !== "number" ||
      !Number.isSafeInteger(parsed.exp) ||
      parsed.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }

    return {
      contributorId: parsed.contributorId,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
};

export async function getContributorIdFromSession(
  c: Context<{ Bindings: Env }>,
): Promise<string | null> {
  const session = await readSession(
    getCookie(c, SESSION_COOKIE_NAME),
    c.env.SESSION_SECRET,
  );

  return session?.contributorId ?? null;
}

const sessionCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/",
};


const handleGoogleCallback = async (
  c: Context<{ Bindings: Env }>,
) => {
  const user = getGoogleUser(c.get("user-google"));

  if (!user) {
    return c.json({ error: "Google identity unavailable" }, 502);
  }

  try {
    const contributor = await withDatabase(
      c.env,
      async (client) => {
        const { rows } = await client.query<{
          id: string;
          is_curator: boolean;
        }>(
          `
            INSERT INTO memoria.contributors (
              google_subject,
              email,
              display_name
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (google_subject) DO UPDATE
              SET email = EXCLUDED.email,
                  display_name = EXCLUDED.display_name,
                  updated_at = now()
            RETURNING id::text AS id, is_curator
          `,
          [
            user.googleSubject,
            user.email,
            user.displayName,
          ],
        );

        return rows[0] ?? null;
      },
    );

    if (!contributor) {
      return c.json(
        { error: "Unable to create contributor session" },
        500,
      );
    }

    const session = await serializeSession(
      contributor.id,
      c.env.SESSION_SECRET,
    );

    setCookie(c, SESSION_COOKIE_NAME, session, {
      ...sessionCookieOptions,
      maxAge: SESSION_LIFETIME_SECONDS,
    });

    return c.redirect("/");
  } catch {
    console.error("Google contributor upsert failed");

    return c.json(
      { error: "Unable to create contributor session" },
      500,
    );
  }
};



const getGoogleRedirectUri = (requestUrl: string): string => {
  const url = new URL(requestUrl);
  return `${url.origin}/api/auth/google/callback`;
};

const getGoogleUser = (
  value: Partial<GoogleUser> | undefined,
): {
  googleSubject: string;
  email: string | null;
  displayName: string | null;
} | null => {
  if (!value) {
    return null;
  }

  const googleSubject = value.id?.trim();

  if (!googleSubject) {
    return null;
  }

  return {
    googleSubject,
    email: value.email?.trim() || null,
    displayName: value.name?.trim() || null,
  };
};

export function registerAuthRoutes(app: AuthApp) {
  const googleMiddleware = async (c: any, next: any) => {
    const middleware = googleAuth({
      scope: GOOGLE_SCOPES,
      redirect_uri: getGoogleRedirectUri(c.req.url),
    });

    return middleware(c, next);
  };

  app.use("/api/auth/google", googleMiddleware);
  app.use("/api/auth/google/*", googleMiddleware);


  app.get("/api/auth/google", (c) => {
    return c.redirect("/");
  });

    app.get("/api/auth/google/", (c) => {
    return c.redirect("/");
  });

  app.get("/api/auth/google/callback", handleGoogleCallback);
  app.get("/api/auth/google/callback/", handleGoogleCallback);


  app.get("/api/me", async (c) => {
    const session = await readSession(
      getCookie(c, SESSION_COOKIE_NAME),
      c.env.SESSION_SECRET,
    );

    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    try {
      const contributor = await withDatabase(
        c.env,
        async (client) => {
          const { rows } = await client.query<Contributor>(
            `
              SELECT
                id::text AS id,
                email,
                display_name,
                is_curator
              FROM memoria.contributors
              WHERE id = $1::bigint
            `,
            [session.contributorId],
          );

          return rows[0] ?? null;
        },
      );

      if (!contributor) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      return c.json({
        id: contributor.id,
        email: contributor.email,
        displayName: contributor.display_name,
        isCurator: contributor.is_curator,
      });
    } catch {
      console.error("Contributor lookup failed");

      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions);
    return c.body(null, 204);
  });
}