import { Context, Hono } from "hono";
import { getContributorIdFromSession, } from "./auth";
import { withDatabase, withTransaction, } from "./db";
import {
  registerDigitaalVlaanderenRoutes,
  resolveDigitaalVlaanderenHousenumber,
} from "./integrations/digitaal-vlaanderen";
import {
  parseCachedCompany,
  searchCompanies,
  type CbeCompany,
  type CbeEstablishment,
} from "./integrations/cbeapi";
import { registerAuthRoutes } from "./auth";

const LOCATION_QUERY = `
  SELECT
    l.id,
    b.legal_name,
    l.registered_address,
    l.street_name,
    l.house_number,
    l.postcode,
    l.municipality,
    l.country_code,
    l.registry_establishment_identifier,
    l.business_verification_status,
    best_alias.alias_text AS location_alias,
    CASE
      WHEN gr.resolution_status = 'resolved'
        AND gr.quality = 'exact_housenumber'
        AND gr.point IS NOT NULL
        AND ST_IsValid(gr.point)
        AND ST_X(gr.point) BETWEEN -180 AND 180
        AND ST_Y(gr.point) BETWEEN -90 AND 90
      THEN json_build_object(
        'provider', gr.provider,
        'providerResponseId', gr.provider_response_id,
        'formattedAddress', gr.formatted_address,
        'locationType', gr.location_type,
        'quality', gr.quality,
        'coordinates', json_build_object(
          'latitude', ST_Y(gr.point),
          'longitude', ST_X(gr.point)
        ),
        'evidenceNote',
          'Coordinates support address resolution only; they do not prove a shop entrance or public access.'
      )
      ELSE NULL
    END AS geocoding
  FROM memoria.locations l
  JOIN memoria.businesses b ON b.id = l.business_id
  LEFT JOIN LATERAL (
    SELECT la.alias_text
    FROM memoria.location_aliases la
    WHERE la.location_id = l.id
    ORDER BY
      CASE WHEN la.alias_type = 'official' THEN 0 ELSE 1 END,
      CASE WHEN la.language = 'en' THEN 0 ELSE 1 END,
      la.id
    LIMIT 1
  ) best_alias ON true
  LEFT JOIN LATERAL (
    SELECT
      gr.provider,
      gr.provider_response_id,
      gr.formatted_address,
      gr.location_type,
      gr.quality,
      gr.point,
      gr.resolution_status
    FROM memoria.geocoding_results gr
    WHERE gr.location_id = l.id
    ORDER BY gr.retrieved_at DESC, gr.id DESC
    LIMIT 1
  ) gr ON true
  WHERE l.id = $1
    AND l.publication_status = 'published'
`;

const SEARCH_QUERY = `
  WITH candidates AS (
    SELECT
      'business'::text AS result_type,
      b.id AS id,
      b.legal_name AS display_name,
      b.legal_name AS legal_name,
      NULL::bigint AS business_id,
      (
        SELECT COUNT(*)::integer
        FROM memoria.locations published_locations
        WHERE published_locations.business_id = b.id
          AND published_locations.publication_status = 'published'
      ) AS location_count,
      NULL::text AS address,
      CASE
        WHEN lower(b.legal_name) = lower($1)
          THEN 'exact'
        WHEN lower(b.legal_name) LIKE lower($1) || '%'
          THEN 'prefix'
        ELSE 'trigram'
      END AS match_type,
      CASE
        WHEN lower(b.legal_name) = lower($1)          
          THEN 0
        WHEN lower(b.legal_name) LIKE lower($1) || '%'
          THEN 1
        ELSE 2
      END AS match_rank,
      similarity(b.legal_name, $1) AS similarity
    FROM memoria.businesses b
    WHERE lower(b.legal_name) = lower($1)
       OR lower(b.legal_name) LIKE lower($1) || '%'
       OR similarity(b.legal_name, $1) >= 0.25

    UNION ALL

    SELECT
      'business'::text AS result_type,
      b.id AS id,
      ba.alias_text AS display_name,
      b.legal_name AS legal_name,
      NULL::bigint AS business_id,
      (
        SELECT COUNT(*)::integer
        FROM memoria.locations published_location
        WHERE published_location.business_id = b.id
          AND published_location.publication_status = 'published'
      ) AS location_count,

      NULL::text AS address,
      CASE
        WHEN lower(ba.alias_text) = lower($1) THEN 'exact'
        WHEN lower(ba.alias_text) LIKE lower($1) || '%' THEN 'prefix'
        ELSE 'trigram'
      END AS match_type,
      CASE
        WHEN lower(ba.alias_text) = lower($1) THEN 0
        WHEN lower(ba.alias_text) LIKE lower($1) || '%' THEN 1
        ELSE 2
      END AS match_rank,
      similarity(ba.alias_text, $1) AS similarity
    FROM memoria.business_aliases ba
    JOIN memoria.businesses b ON b.id = ba.business_id
    WHERE lower(ba.alias_text) = lower($1)
       OR lower(ba.alias_text) LIKE lower($1) || '%'
       OR similarity(ba.alias_text, $1) >= 0.25

    UNION ALL

    SELECT
      'location'::text AS result_type,
      l.id AS id,
      l.registered_address AS display_name,
      b.legal_name AS legal_name,
      b.id AS business_id,
      NULL::integer AS location_count,
      l.registered_address AS address,
      CASE
        WHEN lower(l.registered_address) = lower($1)
          THEN 'exact'
        WHEN lower(l.registered_address) LIKE lower($1) || '%'
          THEN 'prefix'
        ELSE 'trigram'
      END AS match_type,
      CASE
        WHEN lower(l.registered_address) = lower($1)
          THEN 0
        WHEN lower(l.registered_address) LIKE lower($1) || '%'
          THEN 1
        ELSE 2
      END AS match_rank,
      similarity(l.registered_address, $1) AS similarity
    FROM memoria.locations l
    JOIN memoria.businesses b ON b.id = l.business_id
    WHERE l.publication_status = 'published'
      AND (
        lower(l.registered_address) = lower($1)
        OR lower(l.registered_address) LIKE lower($1) || '%'
        OR similarity(l.registered_address, $1) >= 0.25
      )

    UNION ALL

    SELECT
      'location'::text AS result_type,
      l.id AS id,
      la.alias_text AS display_name,
      b.legal_name AS legal_name,
      b.id AS business_id,
      NULL::integer AS location_count,
      l.registered_address AS address,
      CASE
        WHEN lower(la.alias_text) = lower($1) THEN 'exact'
        WHEN lower(la.alias_text) LIKE lower($1) || '%' THEN 'prefix'
        ELSE 'trigram'
      END AS match_type,
      CASE
        WHEN lower(la.alias_text) = lower($1) THEN 0
        WHEN lower(la.alias_text) LIKE lower($1) || '%' THEN 1
        ELSE 2
      END AS match_rank,
      similarity(la.alias_text, $1) AS similarity
    FROM memoria.location_aliases la
    JOIN memoria.locations l ON l.id = la.location_id
    JOIN memoria.businesses b ON b.id = l.business_id
    WHERE l.publication_status = 'published'
      AND (
        lower(la.alias_text) = lower($1)
        OR lower(la.alias_text) LIKE lower($1) || '%'
        OR similarity(la.alias_text, $1) >= 0.25
      )
  ),
  ranked AS (
    SELECT
      candidates.*,
      row_number() OVER (
        PARTITION BY result_type, id
        ORDER BY match_rank, similarity DESC, display_name, legal_name
      ) AS row_number
    FROM candidates
  )
  SELECT
    result_type,
    id,
    display_name,
    legal_name,
    business_id,
    location_count,
    address,
    match_type
  FROM ranked
  WHERE row_number = 1
  ORDER BY match_rank, similarity DESC, result_type, id
  LIMIT 50
`;

const BUSINESS_LOCATIONS_QUERY = `
  SELECT
    l.id,
    COALESCE(best_alias.alias_text, l.registered_address) AS display_name,
    l.registered_address,
    latest_geocode.quality AS geocoding_quality
  FROM memoria.locations l
  LEFT JOIN LATERAL (
    SELECT la.alias_text
    FROM memoria.location_aliases la
    WHERE la.location_id = l.id
    ORDER BY
      CASE WHEN la.alias_type = 'official' THEN 0 ELSE 1 END,
      CASE WHEN la.language = 'en' THEN 0 ELSE 1 END,
      la.id
    LIMIT 1
  ) best_alias ON true
  LEFT JOIN LATERAL (
    SELECT gr.quality
    FROM memoria.geocoding_results gr
    WHERE gr.location_id = l.id
    ORDER BY gr.retrieved_at DESC, gr.id DESC
    LIMIT 1
  ) latest_geocode ON true
  WHERE l.business_id = $1
    AND l.publication_status = 'published'
  ORDER BY display_name NULLS LAST, l.id
  LIMIT 50
`;


const LOCATION_OFFERINGS_QUERY = `
  SELECT
    so.id,
    so.verification_status,
    so.source,
    so.source_url,
    s.id AS service_id,
    s.name AS service_name,
    sc.id AS category_id,
    sc.name AS category_name,
    (
      SELECT COUNT(*)::integer
      FROM memoria.price_observations po
      WHERE po.offering_id = so.id
        AND po.publication_status = 'published'
        AND po.verification_status = 'unverified'
    ) AS price_observation_count
  FROM memoria.service_offerings so
  JOIN memoria.services s ON s.id = so.service_id
  JOIN memoria.service_categories sc ON sc.id = s.category_id
  WHERE so.location_id = $1
    AND so.publication_status = 'published'
    AND s.publication_status = 'published'
    AND sc.publication_status = 'published'
  ORDER BY sc.name, s.name, so.id
`;

const OFFERING_QUERY = `
  SELECT
    so.id,
    so.location_id,
    so.verification_status,
    so.source,
    so.source_url,
    s.id AS service_id,
    s.name AS service_name,
    sc.id AS category_id,
    sc.name AS category_name
  FROM memoria.service_offerings so
  JOIN memoria.locations l
    ON l.id = so.location_id
   AND l.publication_status = 'published'
  JOIN memoria.services s
    ON s.id = so.service_id
   AND s.publication_status = 'published'
  JOIN memoria.service_categories sc
    ON sc.id = s.category_id
   AND sc.publication_status = 'published'
  WHERE so.id = $1
    AND so.publication_status = 'published'
`;

const OFFERING_PRICES_QUERY = `
  SELECT
    po.id::text AS id,
    po.version,
    po.contributor_id::text AS contributor_id,
    por.min_amount,
    por.max_amount,
    por.currency_code,
    por.price_type,
    por.price_basis,
    por.observed_at,
    por.notes,
    po.verification_status
  FROM memoria.price_observations po
  JOIN memoria.price_observation_revisions por
    ON por.id = po.current_revision_id
   AND por.price_observation_id = po.id
  WHERE po.offering_id = $1
    AND po.publication_status = 'published'
  ORDER BY por.observed_at DESC, po.id DESC
`;

const LOCATIONS_BOUNDS_QUERY = `
  SELECT
    l.id,
    b.legal_name,
    COALESCE(best_alias.alias_text, l.registered_address) AS location_name,
    l.business_verification_status,
    exact_geocode.quality AS geocoding_quality,
    ST_AsGeoJSON(exact_geocode.point)::json AS geometry,
    EXISTS (
      SELECT 1
      FROM memoria.service_offerings so
      JOIN memoria.price_observations po ON po.offering_id = so.id
      WHERE so.location_id = l.id
        AND so.publication_status = 'published'
        AND po.publication_status = 'published'
    ) AS has_published_price_observation
  FROM memoria.locations l
  JOIN memoria.businesses b ON b.id = l.business_id
  LEFT JOIN LATERAL (
    SELECT la.alias_text
    FROM memoria.location_aliases la
    WHERE la.location_id = l.id
    ORDER BY
      CASE WHEN la.alias_type = 'official' THEN 0 ELSE 1 END,
      CASE WHEN la.language = 'en' THEN 0 ELSE 1 END,
      la.id
    LIMIT 1
  ) best_alias ON true
  CROSS JOIN LATERAL (
    SELECT
      gr.point,
      gr.quality
    FROM memoria.geocoding_results gr
    WHERE gr.location_id = l.id
      AND gr.resolution_status = 'resolved'
      AND gr.quality = 'exact_housenumber'
      AND gr.point IS NOT NULL
      AND ST_Intersects(
        gr.point,
        ST_SetSRID(ST_MakeEnvelope($1, $2, $3, $4), 4326)
      )
    ORDER BY gr.retrieved_at DESC, gr.id DESC
    LIMIT 1
  ) AS exact_geocode
  WHERE l.publication_status = 'published'
`;


const PRICE_TYPES = new Set(["fixed", "range", "from"]);
const BIGINT_ID_PATTERN = /^[1-9]\d*$/;
const MAX_AMOUNT = 1_000_000;
const MAX_PRICE_BASIS_LENGTH = 100;
const MAX_NOTES_LENGTH = 1_000;

class RateLimitExceededError extends Error {
  constructor() {
    super("Price write rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

type PriceInput = {
  offeringId: string;
  minAmount: number;
  maxAmount: number | null;
  currencyCode: string;
  priceType: "fixed" | "range" | "from";
  priceBasis: string;
  observedAt: string;
  notes: string | null;
};

type PriceSubmissionBody = {
  offeringId?: unknown;
  minAmount?: unknown;
  maxAmount?: unknown;
  currencyCode?: unknown;
  priceType?: unknown;
  priceBasis?: unknown;
  observedAt?: unknown;
  notes?: unknown;
};

type PricePatchBody = Omit<
  PriceSubmissionBody,
  "offeringId"
> & {
  expectedVersion?: unknown;
};

type PgError = {
  code?: string;
};

/*const isPgError = (error: unknown): error is PgError =>
  typeof error === "object" &&
  error !== null &&
  "code" in error;*/

const getBrusselsToday = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Brussels",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const isAmount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= MAX_AMOUNT &&
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-8;

const parseObservedAt = (value: unknown): string | null => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value > getBrusselsToday()
  ) {
    return null;
  }

  return value;
};

const parsePriceBody = (
  body: PriceSubmissionBody,
): PriceInput | null => {
  if (
    typeof body.offeringId !== "string" ||
    !BIGINT_ID_PATTERN.test(body.offeringId)
  ) {
    return null;
  }

  if (!isAmount(body.minAmount)) {
    return null;
  }

  if (
    typeof body.currencyCode !== "string" ||
    !/^[A-Za-z]{3}$/.test(body.currencyCode.trim())
  ) {
    return null;
  }

  const currencyCode = body.currencyCode.trim().toUpperCase();

  if (
    typeof body.priceType !== "string" ||
    !PRICE_TYPES.has(body.priceType)
  ) {
    return null;
  }

  const priceType = body.priceType as PriceInput["priceType"];

  let maxAmount: number | null = null;

  if (priceType === "range") {
    if (
      !isAmount(body.maxAmount) ||
      body.maxAmount < body.minAmount
    ) {
      return null;
    }

    maxAmount = body.maxAmount;
  } else if (
    body.maxAmount !== undefined &&
    body.maxAmount !== null
  ) {
    return null;
  }

  if (
    typeof body.priceBasis !== "string" ||
    body.priceBasis.trim().length < 1 ||
    body.priceBasis.trim().length > MAX_PRICE_BASIS_LENGTH
  ) {
    return null;
  }

  const observedAt = parseObservedAt(body.observedAt);

  if (!observedAt) {
    return null;
  }

  let notes: string | null = null;

  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== "string") {
      return null;
    }

    notes = body.notes.trim();

    if (notes.length > MAX_NOTES_LENGTH) {
      return null;
    }

    if (notes.length === 0) {
      notes = null;
    }
  }

  return {
    offeringId: body.offeringId,
    minAmount: body.minAmount,
    maxAmount,
    currencyCode,
    priceType,
    priceBasis: body.priceBasis.trim(),
    observedAt,
    notes,
  };
};

const parsePatchBody = (
  body: PricePatchBody,
): {
  price: Omit<PriceInput, "offeringId">;
  expectedVersion: number;
} | null => {
  if (
    typeof body.expectedVersion !== "number" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 1
  ) {
    return null;
  }

  const price = parsePriceBody({
    ...body,
    offeringId: "1",
  });

  if (!price) {
    return null;
  }

  const {
    offeringId: _offeringId,
    ...priceWithoutOfferingId
  } = price;

  return {
    price: priceWithoutOfferingId,
    expectedVersion: body.expectedVersion,
  };
};

const isSameOrigin = (request: Request): boolean => {
  const origin = request.headers.get("Origin");

  if (!origin) {
    return false;
  }

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
};

const priceWriteErrorResponse = (
  c: AppContext,
  error: unknown,
) => {
  if (error instanceof RateLimitExceededError) {
    return c.json(
      { error: "Too many price submissions" },
      429,
    );
  }

  if (
    isPgError(error) &&
    (error.code === "23514" || error.code === "22P02")
  ) {
    return c.json(
      { error: "Invalid price data" },
      400,
    );
  }

  console.error(
    "Price write failed",
    isPgError(error) ? error.code : "unknown",
  );

  return c.json(
    { error: "Internal server error" },
    500,
  );
};

const REGISTRY_ID_PATTERN = /^\d{10}$/;

type RegistryCacheRow = {
  cbe_number: string;
  response: unknown;
  fetched_at: string;
};

type RegistryImportBody = {
  cbeNumber?: unknown;
};

type ImportedLocation = {
  id: string;
  establishment: CbeEstablishment;
};

type RegistryImportResult =
  | {
      kind: "ok";
      businessId: string;
      locationIds: string[];
      geocoded: number;
      skippedOutOfScope: number;
    }
  | {
      kind: "no_establishments";
    };

const safeErrorCode = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  if (error instanceof Error) {
    return error.name;
  }

  return "unknown";
};

const isPgError = (
  error: unknown,
): error is { code: string } =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string";

const normalizeAddressPart = (
  value: string | null | undefined,
): string =>
  (value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("nl-BE");

const addressesMatchForGeocoding = (
  source: {
    municipality: string | null;
    street: string | null;
    houseNumber: string | null;
  },
  resolved: {
    municipality: string | null;
    street: string | null;
    houseNumber: string | null;
  },
): boolean => {
  const sourceStreet = normalizeAddressPart(
    source.street,
  );
  const sourceMunicipality = normalizeAddressPart(
    source.municipality,
  );
  const sourceHouseNumber = normalizeAddressPart(
    source.houseNumber,
  );

  return (
    sourceStreet.length > 0 &&
    sourceMunicipality.length > 0 &&
    sourceHouseNumber.length > 0 &&
    normalizeAddressPart(resolved.street) === sourceStreet &&
    normalizeAddressPart(resolved.municipality) ===
      sourceMunicipality &&
    normalizeAddressPart(resolved.houseNumber) ===
      sourceHouseNumber
  );
};

const isInScopePostcode = (
  value: string | null,
): boolean => {
  if (!value || !/^\d+$/.test(value.trim())) {
    return false;
  }

  const postcode = Number(value.trim());

  return (
    (postcode >= 1000 && postcode <= 1299) ||
    (postcode >= 1500 && postcode <= 3999) ||
    (postcode >= 8000 && postcode <= 9999)
  );
};

const getInScopeEstablishments = (
  company: CbeCompany,
): {
  inScope: CbeEstablishment[];
  skippedOutOfScope: number;
} => {
  const seen = new Set<string>();
  const inScope: CbeEstablishment[] = [];

  for (const establishment of company.establishments) {
    if (
      !/^\d+$/.test(establishment.establishment_number) ||
      seen.has(establishment.establishment_number)
    ) {
      continue;
    }

    seen.add(establishment.establishment_number);

    if (
      establishment.date_striking_off !== null &&
      establishment.date_striking_off !== ""
    ) {
      continue;
    }

    if (isInScopePostcode(establishment.post_code)) {
      inScope.push(establishment);
    }
  }

  return {
    inScope,
    skippedOutOfScope: company.establishments.length - inScope.length,
  };
};

const composeRegisteredAddress = (
  establishment: CbeEstablishment,
): string => {
  const street = establishment.street?.trim() ?? "";
  const houseNumber =
    establishment.house_number?.trim() ?? "";
  const box = establishment.box?.trim() ?? "";
  const postcode = establishment.post_code?.trim() ?? "";
  const city = establishment.city?.trim() ?? "";

  const firstLine = [street, houseNumber]
    .filter(Boolean)
    .join(" ");

  const boxPart = box ? ` bus ${box}` : "";

  return `${firstLine}${boxPart}, ${postcode} ${city}`.trim();
};

const getCompanyDisplayName = (
  company: CbeCompany,
): string =>
  company.denomination_with_legal_form?.trim() ||
  company.denomination?.trim() ||
  company.cbe_number;

const getCompanySourceUrl = (
  cbeNumber: string,
): string =>
  `https://kbopub.economie.fgov.be/kbopub/toonondernemingps.html?ondernemingsnummer=${encodeURIComponent(cbeNumber)}`;

const getAliasEntries = (
  company: CbeCompany,
): Array<{
  aliasText: string;
  aliasType:
    | "abbreviation"
    | "commercial_name"
    | "branch_name";
}> => {
  const entries: Array<{
    aliasText: string;
    aliasType:
      | "abbreviation"
      | "commercial_name"
      | "branch_name";
  }> = [];

  const candidates = [
    {
      aliasText: company.abbreviation,
      aliasType: "abbreviation" as const,
    },
    {
      aliasText: company.commercial_name,
      aliasType: "commercial_name" as const,
    },
    {
      aliasText: company.branch_name,
      aliasType: "branch_name" as const,
    },
  ];

  for (const candidate of candidates) {
    const aliasText = candidate.aliasText?.trim();

    if (aliasText) {
      entries.push({
        aliasText,
        aliasType: candidate.aliasType,
      });
    }
  }

  return entries;
};

const getMainActivity = (
  company: CbeCompany,
): string | null =>
  company.nace_activities.find(
    (activity) =>
      activity.classification?.toLowerCase() === "main",
  )?.description ?? null;

type AppContext = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

registerAuthRoutes(app);
registerDigitaalVlaanderenRoutes(app);

app.post("/api/prices", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    return c.json(
      { error: "Cross-origin request rejected" },
      403,
    );
  }

  const contributorId = await getContributorIdFromSession(c);

  if (!contributorId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: PriceSubmissionBody;

  try {
    body = await c.req.json<PriceSubmissionBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const price = parsePriceBody(body);

  if (!price) {
    return c.json({ error: "Invalid price data" }, 400);
  }

  try {
    const result = await withTransaction(c.env, async (client) => {
      const contributor = await client.query(
        `
          SELECT id
          FROM memoria.contributors
          WHERE id = $1::bigint
        `,
        [contributorId],
      );

      if (contributor.rowCount === 0) {
        return { kind: "unauthorized" as const };
      }

      const bucket = await client.query<{ write_count: number }>(
        `
          INSERT INTO memoria.contributor_write_buckets (
            contributor_id,
            bucket_start,
            write_count,
            updated_at
          )
          VALUES (
            $1::bigint,
            date_trunc('hour', CURRENT_TIMESTAMP),
            1,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (contributor_id, bucket_start) DO UPDATE
            SET write_count =
              memoria.contributor_write_buckets.write_count + 1,
                updated_at = CURRENT_TIMESTAMP
          RETURNING write_count
        `,
        [contributorId],
      );

      if (
        bucket.rows[0] === undefined ||
        bucket.rows[0].write_count > 20
      ) {
        throw new RateLimitExceededError();
      }

      const offering = await client.query(
        `
          SELECT so.id
          FROM memoria.service_offerings so
          JOIN memoria.locations l
            ON l.id = so.location_id
           AND l.publication_status = 'published'
          JOIN memoria.services s
            ON s.id = so.service_id
           AND s.publication_status = 'published'
          WHERE so.id = $1::bigint
            AND so.publication_status = 'published'
        `,
        [price.offeringId],
      );

      if (offering.rowCount === 0) {
        return { kind: "not_found" as const };
      }

      const observation = await client.query<{ id: string }>(
        `
          INSERT INTO memoria.price_observations (
            offering_id,
            contributor_id,
            publication_status,
            verification_status,
            version
          )
          VALUES (
            $1::bigint,
            $2::bigint,
            'published',
            'unverified',
            1
          )
          RETURNING id::text AS id
        `,
        [price.offeringId, contributorId],
      );

      const observationId = observation.rows[0]?.id;

      if (!observationId) {
        throw new Error("Price observation ID was not returned");
      }

      const revision = await client.query<{ id: string }>(
        `
          INSERT INTO memoria.price_observation_revisions (
            price_observation_id,
            revision_number,
            revision_author_id,
            min_amount,
            max_amount,
            currency_code,
            price_type,
            price_basis,
            observed_at,
            notes
          )
          VALUES (
            $1::bigint,
            1,
            $2::bigint,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8::date,
            $9
          )
          RETURNING id::text AS id
        `,
        [
          observationId,
          contributorId,
          price.minAmount,
          price.maxAmount,
          price.currencyCode,
          price.priceType,
          price.priceBasis,
          price.observedAt,
          price.notes,
        ],
      );

      const revisionId = revision.rows[0]?.id;

      if (!revisionId) {
        throw new Error("Price revision ID was not returned");
      }

      await client.query(
        `
          UPDATE memoria.price_observations
          SET current_revision_id = $1::bigint,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2::bigint
        `,
        [revisionId, observationId],
      );

      return {
        kind: "created" as const,
        id: observationId,
        version: 1,
      };
    });

    if (result.kind === "unauthorized") {
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (result.kind === "not_found") {
      return c.json({ error: "Offering not found" }, 404);
    }

    return c.json(
      {
        id: result.id,
        version: result.version,
      },
      201,
    );
  } catch (error) {
    return priceWriteErrorResponse(c, error);
  }
});

app.patch("/api/prices/:id", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    return c.json(
      { error: "Cross-origin request rejected" },
      403,
    );
  }

  const rawId = c.req.param("id");

  if (!BIGINT_ID_PATTERN.test(rawId)) {
    return c.json(
      { error: "Price ID must be a positive integer" },
      400,
    );
  }

  const contributorId = await getContributorIdFromSession(c);

  if (!contributorId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: PricePatchBody;

  try {
    body = await c.req.json<PricePatchBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = parsePatchBody(body);

  if (!parsed) {
    return c.json({ error: "Invalid price data" }, 400);
  }

  try {
    const result = await withTransaction(c.env, async (client) => {
      const observation = await client.query<{
        id: string;
        contributor_id: string;
        publication_status: string;
        version: number;
      }>(
        `
          SELECT
            id::text AS id,
            contributor_id::text AS contributor_id,
            publication_status,
            version
          FROM memoria.price_observations
          WHERE id = $1::bigint
          FOR UPDATE
        `,
        [rawId],
      );

      const current = observation.rows[0];

      if (
        !current ||
        current.publication_status !== "published"
      ) {
        return { kind: "not_found" as const };
      }

      if (current.contributor_id !== contributorId) {
        return { kind: "forbidden" as const };
      }

      if (current.version !== parsed.expectedVersion) {
        return { kind: "conflict" as const };
      }

      const nextVersion = current.version + 1;

      const revision = await client.query<{ id: string }>(
        `
          INSERT INTO memoria.price_observation_revisions (
            price_observation_id,
            revision_number,
            revision_author_id,
            min_amount,
            max_amount,
            currency_code,
            price_type,
            price_basis,
            observed_at,
            notes
          )
          VALUES (
            $1::bigint,
            $2,
            $3::bigint,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9::date,
            $10
          )
          RETURNING id::text AS id
        `,
        [
          rawId,
          nextVersion,
          contributorId,
          parsed.price.minAmount,
          parsed.price.maxAmount,
          parsed.price.currencyCode,
          parsed.price.priceType,
          parsed.price.priceBasis,
          parsed.price.observedAt,
          parsed.price.notes,
        ],
      );

      const revisionId = revision.rows[0]?.id;

      if (!revisionId) {
        throw new Error("Price revision ID was not returned");
      }

      await client.query(
        `
          UPDATE memoria.price_observations
          SET current_revision_id = $1::bigint,
              version = $2,
              verification_status = 'unverified',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $3::bigint
        `,
        [revisionId, nextVersion, rawId],
      );

      return {
        kind: "updated" as const,
        id: current.id,
        version: nextVersion,
      };
    });

    if (result.kind === "not_found") {
      return c.json({ error: "Price not found" }, 404);
    }

    if (result.kind === "forbidden") {
      return c.json({ error: "Forbidden" }, 403);
    }

    if (result.kind === "conflict") {
      return c.json(
        { error: "Price version conflict" },
        409,
      );
    }

    return c.json({
      id: result.id,
      version: result.version,
    });
  } catch (error) {
    return priceWriteErrorResponse(c, error);
  }
});

app.delete("/api/prices/:id", async (c) => {
  if (!isSameOrigin(c.req.raw)) {
    return c.json(
      { error: "Cross-origin request rejected" },
      403,
    );
  }

  const rawId = c.req.param("id");

  if (!BIGINT_ID_PATTERN.test(rawId)) {
    return c.json(
      { error: "Price ID must be a positive integer" },
      400,
    );
  }

  const contributorId = await getContributorIdFromSession(c);

  if (!contributorId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const result = await withTransaction(c.env, async (client) => {
      const observation = await client.query<{
        id: string;
        contributor_id: string;
        publication_status: string;
      }>(
        `
          SELECT
            id::text AS id,
            contributor_id::text AS contributor_id,
            publication_status
          FROM memoria.price_observations
          WHERE id = $1::bigint
          FOR UPDATE
        `,
        [rawId],
      );

      const current = observation.rows[0];

      if (
        !current ||
        current.publication_status !== "published"
      ) {
        return { kind: "not_found" as const };
      }

      const contributor = await client.query<{
        is_curator: boolean;
      }>(
        `
          SELECT is_curator
          FROM memoria.contributors
          WHERE id = $1::bigint
        `,
        [contributorId],
      );

      const isCurator =
        contributor.rows[0]?.is_curator === true;
      const isOwner =
        current.contributor_id === contributorId;

      if (!isOwner && !isCurator) {
        return { kind: "forbidden" as const };
      }

      await client.query(
        `
          UPDATE memoria.price_observations
          SET publication_status = 'hidden',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $1::bigint
        `,
        [rawId],
      );

      if (isCurator && !isOwner) {
        await client.query(
          `
            INSERT INTO memoria.moderation_events (
              price_observation_id,
              curator_contributor_id,
              action,
              reason
            )
            VALUES (
              $1::bigint,
              $2::bigint,
              'hidden',
              NULL
            )
          `,
          [rawId, contributorId],
        );
      }

      return { kind: "deleted" as const };
    });

    if (result.kind === "not_found") {
      return c.json({ error: "Price not found" }, 404);
    }

    if (result.kind === "forbidden") {
      return c.json({ error: "Forbidden" }, 403);
    }

    return c.body(null, 204);
  } catch (error) {
    return priceWriteErrorResponse(c, error);
  }
});

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

  try {
    await withDatabase(c.env, async (client) => {
    await client.query("SELECT 1");
    });

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
  }
});


app.get("/api/search", async (c) => {
  const rawQuery = c.req.query("q");
  const query = rawQuery?.trim();

  if (!query || query.length > 100) {
    return c.json(
      {
        error: "Query parameter q must be a trimmed string between 1 and 100 characters",
      },
      400,
    );
  }

  try {
    const results = await withDatabase(c.env, async (client) => {
      const { rows } = await client.query<{
        result_type: "business" | "location";
        id: string;
        display_name: string;
        legal_name: string | null;
        business_id: string | null;
        location_count: number | null;
        address: string | null;
        match_type: "exact" | "prefix" | "trigram";
      }>(SEARCH_QUERY, [query]);

      return rows.map((row) => ({
        type: row.result_type,
        id: row.id,
        displayName: row.display_name,
        legalName: row.legal_name,
        businessId: row.business_id,
        locationCount: row.location_count,
        address: row.address,
        matchType: row.match_type,
      }));
    });

    return c.json({ results });
  } catch (error) {
    console.error("Search query failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});

class RegistrySearchAgainError extends Error {
  constructor() {
    super("Search again");
    this.name = "RegistrySearchAgainError";
  }
}

app.get("/api/registry/search", async (c) => {
  const query = c.req.query("q")?.trim() ?? "";

  if (query.length < 3 || query.length > 80) {
    return c.json(
      {
        error:
          "Query parameter q must be a trimmed string between 3 and 80 characters",
      },
      400,
    );
  }

  try {
    const companies = await searchCompanies(
      c.env,
      query,
    );

    const results = await withDatabase(
      c.env,
      async (client) => {
        for (const company of companies) {
          await client.query(
            `
              INSERT INTO memoria.registry_cache (
                cbe_number,
                response,
                fetched_at
              )
              VALUES ($1, $2::jsonb, now())
              ON CONFLICT (cbe_number) DO UPDATE
                SET response = EXCLUDED.response,
                    fetched_at = now()
            `,
            [
              company.cbe_number,
              JSON.stringify(company),
            ],
          );
        }

        const cbeNumbers = companies.map(
          (company) => company.cbe_number,
        );

        const imported = new Map<
          string,
          string
        >();

        if (cbeNumbers.length > 0) {
          const { rows } = await client.query<{
            cbe_number: string;
            business_id: string;
          }>(
            `
              SELECT
                regexp_replace(
                  b.registry_identifier,
                  '\\D',
                  '',
                  'g'
                ) AS cbe_number,
                b.id::text AS business_id
              FROM memoria.businesses b
              WHERE b.country_code = 'BE'
                AND b.registry_provider = 'CBE'
                AND regexp_replace(
                  b.registry_identifier,
                  '\\D',
                  '',
                  'g'
                ) = ANY($1::text[])
            `,
            [cbeNumbers],
          );

          for (const row of rows) {
            imported.set(row.cbe_number, row.business_id);
          }
        }

        return companies.map((company) => {
          const inScope = getInScopeEstablishments(
            company,
          );

          const fullAddress =
            company.address.full_address?.trim() ?? "";

          return {
            cbeNumber: company.cbe_number,
            displayName: getCompanyDisplayName(company),
            address: fullAddress.replace(/\s+BE$/i, ""),
            establishmentCount: company.establishments.length,
            inScopeEstablishmentCount:
              inScope.inScope.length,
            mainActivity: getMainActivity(company),
            alreadyImported: imported.has(
              company.cbe_number,
            ),
            businessId:
              imported.get(company.cbe_number) ?? null,
          };
        });
      },
    );

    return c.json({ results });
  } catch (error) {
    console.error(
      "CBEAPI registry search failed",
      safeErrorCode(error),
    );

    return c.json(
      { error: "Registry unavailable" },
      502,
    );
  }
});

app.post("/api/registry/import", async (c) => {
  const contributorId =
    await getContributorIdFromSession(c);

  if (!contributorId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: RegistryImportBody;

  try {
    body = await c.req.json<RegistryImportBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const cbeNumber =
    typeof body.cbeNumber === "string"
      ? body.cbeNumber.trim()
      : "";

  if (!REGISTRY_ID_PATTERN.test(cbeNumber)) {
    return c.json(
      { error: "cbeNumber must contain 10 digits" },
      400,
    );
  }

  try {
    const result = await withDatabase(
      c.env,
      async (client): Promise<RegistryImportResult> => {
        const cache = await client.query<RegistryCacheRow>(
          `
            SELECT
              cbe_number,
              response,
              fetched_at
            FROM memoria.registry_cache
            WHERE cbe_number = $1
          `,
          [cbeNumber],
        );

        const cached = cache.rows[0];

        if (!cached) {
          throw new RegistrySearchAgainError();
        }

        const cachedResponse =
          typeof cached.response === "string"
            ? JSON.parse(cached.response)
            : cached.response;

        const company = parseCachedCompany(cachedResponse);

        const { inScope, skippedOutOfScope } =
          getInScopeEstablishments(company);

        if (inScope.length === 0) {
          return {
            kind: "no_establishments",
          };
        }

        await client.query(
          `
            SELECT pg_advisory_xact_lock(
              hashtext('cbe:' || $1)
            )
          `,
          [cbeNumber],
        );

        const businessResult = await client.query<{
          id: string;
        }>(
          `
            INSERT INTO memoria.businesses (
              country_code,
              registry_provider,
              registry_identifier,
              legal_name,
              registry_status,
              juridical_form,
              juridical_situation,
              source_name,
              source_url,
              source_retrieved_at
            )
            VALUES (
              'BE',
              'CBE',
              $1,
              $2,
              $3,
              $4,
              $5,
              'CBEAPI',
              $6,
              $7
            )
            ON CONFLICT (
              country_code,
              registry_provider,
              registry_identifier
            ) DO UPDATE
              SET legal_name = EXCLUDED.legal_name,
                  registry_status = EXCLUDED.registry_status,
                  juridical_form = EXCLUDED.juridical_form,
                  juridical_situation =
                    EXCLUDED.juridical_situation,
                  source_retrieved_at =
                    EXCLUDED.source_retrieved_at,
                  updated_at = now()
            RETURNING id::text AS id
          `,
          [
            cbeNumber,
            getCompanyDisplayName(company),
            company.status,
            company.juridical_form,
            company.juridical_situation,
            getCompanySourceUrl(cbeNumber),
            cached.fetched_at,
          ],
        );

        const businessId =
          businessResult.rows[0]?.id;

        if (!businessId) {
          throw new Error("business_id_not_returned");
        }

        for (const activity of company.nace_activities) {
          await client.query(
            `
              INSERT INTO memoria.business_nace_activities (
                business_id,
                nace_code,
                nace_version,
                description,
                classification,
                source,
                retrieved_at
              )
              VALUES (
                $1::bigint,
                $2,
                $3,
                $4,
                $5,
                'CBEAPI',
                $6
              )
              ON CONFLICT (
                business_id,
                nace_code,
                nace_version
              ) DO UPDATE
                SET description = EXCLUDED.description,
                    classification = EXCLUDED.classification,
                    retrieved_at = EXCLUDED.retrieved_at
            `,
            [
              businessId,
              activity.code,
              activity.nace_version,
              activity.description,
              activity.classification,
              cached.fetched_at,
            ],
          );
        }

        for (const alias of getAliasEntries(company)) {
          await client.query(
            `
              INSERT INTO memoria.business_aliases (
                business_id,
                alias_text,
                language,
                alias_type,
                source,
                verification_status
              )
              SELECT
                $1::bigint,
                $2,
                NULL,
                $3,
                'CBEAPI',
                'unverified'
              WHERE NOT EXISTS (
                SELECT 1
                FROM memoria.business_aliases existing
                WHERE existing.business_id = $1::bigint
                  AND existing.alias_text = $2
                  AND existing.language IS NOT DISTINCT FROM NULL
                  AND existing.alias_type = $3
              )
            `,
            [
              businessId,
              alias.aliasText,
              alias.aliasType,
            ],
          );
        }

        const importedLocations: ImportedLocation[] = [];

        for (const establishment of inScope) {
          const registeredAddress =
            composeRegisteredAddress(establishment);

          const locationResult =
            await client.query<{ id: string }>(
              `
                INSERT INTO memoria.locations (
                  business_id,
                  registry_establishment_identifier,
                  establishment_type,
                  establishment_status,
                  street_name,
                  house_number,
                  postcode,
                  municipality,
                  country_code,
                  registered_address,
                  business_verification_status,
                  publication_status
                )
                VALUES (
                  $1::bigint,
                  $2,
                  $3,
                  'active',
                  $4,
                  $5,
                  $6,
                  $7,
                  'BE',
                  $8,
                  'registry_identified',
                  'published'
                )
                ON CONFLICT (
                  registry_establishment_identifier
                ) DO UPDATE
                  SET street_name = EXCLUDED.street_name,
                      house_number = EXCLUDED.house_number,
                      postcode = EXCLUDED.postcode,
                      municipality = EXCLUDED.municipality,
                      registered_address =
                        EXCLUDED.registered_address,
                      establishment_status =
                        EXCLUDED.establishment_status,
                      updated_at = now()
                RETURNING id::text AS id
              `,
              [
                businessId,
                establishment.establishment_number,
                establishment.type_of_address,
                establishment.street,
                establishment.house_number,
                establishment.post_code,
                establishment.city,
                registeredAddress,
              ],
            );

          const locationId =
            locationResult.rows[0]?.id;

          if (!locationId) {
            throw new Error("location_id_not_returned");
          }

          importedLocations.push({
            id: locationId,
            establishment,
          });
        }

        return {
          kind: "ok",
          businessId,
          locationIds: importedLocations.map(
            (location) => location.id,
          ),
          geocoded: 0,
          skippedOutOfScope,
        };
      },
    );

    if (result.kind === "no_establishments") {
      return c.json(
        { error: "No establishments in Flanders or Brussels" },
        422,
      );
    }

    const geocodeCandidates = await withDatabase(
      c.env,
      async (client) => {
        const { rows } = await client.query<{
          id: string;
          street_name: string | null;
          house_number: string | null;
          municipality: string | null;
          registered_address: string | null;
          establishment_number: string;
        }>(
          `
            SELECT
              l.id::text AS id,
              l.street_name,
              l.house_number,
              l.municipality,
              l.registered_address,
              l.registry_establishment_identifier
                AS establishment_number
            FROM memoria.locations l
            WHERE l.id = ANY($1::bigint[])
              AND NOT EXISTS (
                SELECT 1
                FROM memoria.geocoding_results gr
                WHERE gr.location_id = l.id
                  AND gr.resolution_status = 'resolved'
              )
          `,
          [result.locationIds],
        );

        return rows;
      },
    );

    const geocodeResults = await Promise.allSettled(
      geocodeCandidates.map(async (location) => {
        const query = location.registered_address;

        if (!query) {
          return false;
        }

        const resolution =
          await resolveDigitaalVlaanderenHousenumber(
            query,
          );

        if (!resolution) {
          return false;
        }

        if (
          !addressesMatchForGeocoding(
            {
              street: location.street_name,
              municipality: location.municipality,
              houseNumber: location.house_number,
            },
            resolution,
          )
        ) {
          return false;
        }

        await withDatabase(c.env, async (client) => {
          await client.query(
            `
              INSERT INTO memoria.geocoding_results (
                location_id,
                provider,
                provider_response_id,
                formatted_address,
                municipality,
                street_name,
                house_number,
                postcode,
                location_type,
                point,
                resolution_status,
                quality,
                retrieved_at,
                raw_response
              )
              SELECT
                $1::bigint,
                'Digitaal Vlaanderen',
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                ST_SetSRID(
                  ST_MakePoint($9::double precision, $10::double precision),
                  4326
                ),
                'resolved',
                'exact_housenumber',
                now(),
                $11::jsonb
              WHERE NOT EXISTS (
                SELECT 1
                FROM memoria.geocoding_results existing
                WHERE existing.location_id = $1::bigint
                  AND existing.resolution_status = 'resolved'
              )
            `,
            [
              location.id,
              resolution.providerId === null
                ? null
                : String(resolution.providerId),
              resolution.formattedAddress,
              resolution.municipality,
              resolution.street,
              resolution.houseNumber,
              resolution.postcode,
              resolution.locationType,
              resolution.longitude,
              resolution.latitude,
              JSON.stringify(resolution.rawResponse),
            ],
          );
        });

        return true;
      }),
    );

    const geocoded = geocodeResults.filter(
      (entry) =>
        entry.status === "fulfilled" &&
        entry.value === true,
    ).length;

    for (const entry of geocodeResults) {
      if (entry.status === "rejected") {
        console.error(
          "Registry geocoding failed",
          safeErrorCode(entry.reason),
        );
      }
    }

    return c.json(
      {
        businessId: result.businessId,
        locationIds: result.locationIds,
        geocoded,
        skippedOutOfScope: result.skippedOutOfScope,
      },
      201,
    );
  } catch (error) {
    if (error instanceof RegistrySearchAgainError) {
      return c.json({ error: "Search again" }, 404);
    }

    if (
      isPgError(error) &&
      (error.code === "23514" || error.code === "22P02")
    ) {
      return c.json(
        { error: "Invalid registry data" },
        400,
      );
    }

    console.error(
      "Registry import failed",
      safeErrorCode(error),
    );

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});

app.get("/api/businesses/:id/locations", async (c) => {
  const rawId = c.req.param("id");

  if (!/^[1-9]\d*$/.test(rawId)) {
    return c.json(
      { error: "Business ID must be a positive integer" },
      400,
    );
  }

  const businessId = Number(rawId);

  if (!Number.isSafeInteger(businessId)) {
    return c.json(
      { error: "Business ID must be a positive integer" },
      400,
    );
  }

  try {
    const result = await withDatabase(c.env, async (client) => {
      const business = await client.query(
        `
          SELECT 1
          FROM memoria.businesses
          WHERE id = $1
        `,
        [businessId],
      );

      if (business.rowCount === 0) {
        return null;
      }

      const { rows } = await client.query<{
        id: string;
        display_name: string | null;
        registered_address: string | null;
        geocoding_quality: string | null;
      }>(BUSINESS_LOCATIONS_QUERY, [businessId]);

      return rows;
    });

    if (result === null) {
      return c.json(
        { error: "Business not found" },
        404,
      );
    }

    return c.json({
      locations: result.map((location) => ({
        id: location.id,
        displayName: location.display_name,
        registeredAddress: location.registered_address,
        geocodingQuality: location.geocoding_quality,
      })),
    });
  } catch (error) {
    console.error("Business locations lookup failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});


app.get("/api/locations/:id", async (c) => {
  const rawId = c.req.param("id");

  if (!/^[1-9]\d*$/.test(rawId)) {
    return c.json(
      { error: "Location ID must be a positive integer" },
      400,
    );
  }

  const locationId = Number(rawId);

  if (!Number.isSafeInteger(locationId)) {
    return c.json(
      { error: "Location ID must be a positive integer" },
      400,
    );
  }

  try {
    const location = await withDatabase(c.env, async (client) => {
      const { rows } = await client.query<{
        id: number;
        legal_name: string;
        registered_address: string | null;
        street_name: string | null;
        house_number: string | null;
        postcode: string | null;
        municipality: string | null;
        country_code: string | null;
        registry_establishment_identifier: string | null;
        business_verification_status: string | null;
        location_alias: string | null;
        geocoding: {
          provider: string;
          providerResponseId: string;
          formattedAddress: string;
          locationType: string;
          quality: string;
          coordinates: {
            latitude: number;
            longitude: number;
          }
        } | null;
      }>(LOCATION_QUERY, [locationId]);

      return rows[0] ?? null;
    });

    if (!location) {
      return c.json(
        { error: "Location not found" },
        404,
      );
    }

    return c.json({
      id: location.id,
      legalBusinessName: location.legal_name,
      registeredAddress: {
        address: location.registered_address,
        streetName: location.street_name,
        houseNumber: location.house_number,
        postcode: location.postcode,
        municipality: location.municipality,
        countryCode: location.country_code,
      },
      establishmentIdentifier: location.registry_establishment_identifier,
      locationAlias: location.location_alias,
      businessVerificationStatus: location.business_verification_status,
      geocoding: location.geocoding,
    });
  } catch (error) {
    console.error("Location lookup failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});

app.get("/api/locations/:id/offerings", async (c) => {
  const rawId = c.req.param("id");

  if (!/^[1-9]\d*$/.test(rawId)) {
    return c.json(
      { error: "Location ID must be a positive integer" },
      400,
    );
  }

  const locationId = Number(rawId);

  if (!Number.isSafeInteger(locationId)) {
    return c.json(
      { error: "Location ID must be a positive integer" },
      400,
    );
  }

  try {
    const result = await withDatabase(c.env, async (client) => {
      const location = await client.query(
        `
          SELECT 1
          FROM memoria.locations
          WHERE id = $1
            AND publication_status = 'published'
        `,
        [locationId],
      );

      if (location.rowCount === 0) {
        return null;
      }

      const { rows } = await client.query<{
        id: number;
        verification_status: string | null;
        source: string | null;
        source_url: string | null;
        service_id: number;
        service_name: string;
        category_id: number;
        category_name: string;
        price_observation_count: number;
      }>(LOCATION_OFFERINGS_QUERY, [locationId]);

      return rows;
    });

    if (result === null) {
      return c.json(
        { error: "Location not found" },
        404,
      );
    }

    return c.json({
      offerings: result.map((offering) => ({
        id: offering.id,
        service: {
          id: offering.service_id,
          name: offering.service_name,
        },
        category: {
          id: offering.category_id,
          name: offering.category_name,
        },
        verificationStatus: offering.verification_status,
        source: offering.source,
        sourceUrl: offering.source_url,
        priceObservationCount: offering.price_observation_count,
      })),
    });
  } catch (error) {
    console.error("Location offerings lookup failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});

app.get("/api/locations", async (c) => {
  const rawBounds = ["west", "south", "east", "north"].map((name) =>
    c.req.query(name),
  );

  const bounds = rawBounds.map((value) => {
    const trimmed = value?.trim();
    return trimmed ? Number(trimmed) : Number.NaN;
  });

  const [west, south, east, north] = bounds;
  const validBounds =
    bounds.every(Number.isFinite) &&
    west >= -180 &&
    west <= 180 &&
    east >= -180 &&
    east <= 180 &&
    south >= -90 &&
    south <= 90 &&
    north >= -90 &&
    north <= 90 &&
    west < east &&
    south < north;

  if (!validBounds) {
    return c.json(
      {
        error:
          "Bounds must contain finite values with west < east, south < north, longitude between -180 and 180, and latitude between -90 and 90",
      },
      400,
    );
  }

  try {
    const { rows } = await withDatabase(c.env, async (client) => {
      return client.query<{
        id: number;
        legal_name: string;
        location_name: string | null;
        business_verification_status: string | null;
        geocoding_quality: string;
        geometry: {
          type: "Point";
          coordinates: [number, number];
        };
        has_published_price_observation: boolean;
      }>(LOCATIONS_BOUNDS_QUERY, [west, south, east, north]);
    });

    return c.json({
      type: "FeatureCollection",
      features: rows.map((row) => ({
        type: "Feature",
        geometry: row.geometry,
        properties: {
          locationId: row.id,
          legalBusinessName: row.legal_name,
          locationName: row.location_name,
          businessVerificationStatus: row.business_verification_status,
          geocodingQuality: row.geocoding_quality,
          hasPublishedPriceObservation:
            row.has_published_price_observation,
        },
      })),
    });
  } catch (error) {
    console.error("Location bounds lookup failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
  }
});


app.get("/api/offerings/:id/prices", async (c) => {
  const rawId = c.req.param("id");

  if (!/^[1-9]\d*$/.test(rawId)) {
    return c.json(
      { error: "Offering ID must be a positive integer" },
      400,
    );
  }

  const offeringId = Number(rawId);

  if (!Number.isSafeInteger(offeringId)) {
    return c.json(
      { error: "Offering ID must be a positive integer" },
      400,
    );
  }

  try {
    const result = await withDatabase(c.env, async (client) => {
      const offering = await client.query<{
        id: number;
        location_id: number;
        verification_status: string | null;
        source: string | null;
        source_url: string | null;
        service_id: number;
        service_name: string;
        category_id: number;
        category_name: string;
      }>(OFFERING_QUERY, [offeringId]);

      if (offering.rowCount === 0) {
        return null;
      }

      const { rows: prices } = await client.query<{
        id: string;
        version: number;
        contributor_id: string;
        min_amount: string | null;
        max_amount: string | null;
        currency_code: string;
        price_type: string;
        price_basis: string;
        observed_at: string;
        notes: string | null;
        verification_status: string | null;
      }>(OFFERING_PRICES_QUERY, [offeringId]);

      return {
        offering: offering.rows[0],
        prices,
      };
    });

    if (result === null) {
      return c.json(
        { error: "Offering not found" },
        404,
      );
    }
    const viewerContributorId =
      await getContributorIdFromSession(c);
    const offering = result.offering;

    return c.json({
      offering: {
        id: offering.id,
        locationId: offering.location_id,
        service: {
          id: offering.service_id,
          name: offering.service_name,
        },
        category: {
          id: offering.category_id,
          name: offering.category_name,
        },
        verificationStatus: offering.verification_status,
        source: offering.source,
        sourceUrl: offering.source_url,
      },
      prices: result.prices.map((price) => ({
        id: price.id,
        version: price.version,
        minAmount: price.min_amount,
        maxAmount: price.max_amount,
        currencyCode: price.currency_code,
        priceType: price.price_type,
        priceBasis: price.price_basis,
        observedAt: price.observed_at,
        notes: price.notes,
        verificationStatus: price.verification_status,
        isMine:
          viewerContributorId !== null &&
          price.contributor_id === viewerContributorId,
      })),
    });
  } catch (error) {
    console.error("Offering prices lookup failed", error);

    return c.json(
      { error: "Internal server error" },
      500,
    );
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