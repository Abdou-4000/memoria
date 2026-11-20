import { Hono } from "hono";

const DIGITAAL_VLAANDEREN_BASE_URL =
  "https://geo.api.vlaanderen.be/geolocation/v4";
const UPSTREAM_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 200;
const MAX_SUGGESTIONS = 25;

type GeolocationBindings = {
  Bindings: Env;
};

type UpstreamSuggestionResponse = {
  SuggestionResult?: unknown;
};

type UpstreamCoordinate = {
  Lat_WGS84?: unknown;
  Lon_WGS84?: unknown;
};

type UpstreamLocation = {
  Municipality?: unknown;
  Zipcode?: unknown;
  Thoroughfarename?: unknown;
  Housenumber?: unknown;
  ID?: unknown;
  FormattedAddress?: unknown;
  Location?: UpstreamCoordinate;
  LocationType?: unknown;
};

type UpstreamLocationResponse = {
  LocationResult?: unknown;
};

type ValidLocation = {
  municipality: string | null;
  postcode: string | null;
  street: string | null;
  houseNumber: string | null;
  providerId: string | number | null;
  formattedAddress: string | null;
  locationType: string | null;
  latitude: number | null;
  longitude: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asNullableString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;

const asProviderId = (value: unknown): string | number | null => {
  if (
    typeof value === "string" &&
    value.trim().length > 0
  ) {
    return value.trim();
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }

  return null;
};

const asFiniteCoordinate = (
  value: unknown,
  minimum: number,
  maximum: number,
): number | null => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return null;
  }

  return value;
};

const validateQuery = (value: string | undefined) => {
  const query = value?.trim() ?? "";

  if (
    query.length < 2 ||
    query.length > MAX_QUERY_LENGTH
  ) {
    return null;
  }

  return query;
};

const fetchProviderJson = async (
  url: URL,
): Promise<unknown> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    UPSTREAM_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Digitaal Vlaanderen returned status ${response.status}`,
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const parseSuggestions = (
  payload: unknown,
): string[] | null => {
  if (!isRecord(payload)) {
    return null;
  }

  const values = payload.SuggestionResult;

  if (!Array.isArray(values)) {
    return null;
  }

  const suggestions = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, MAX_SUGGESTIONS);

  if (suggestions.length !== values.length) {
    return null;
  }

  return suggestions;
};

const parseLocations = (
  payload: unknown,
): UpstreamLocation[] | null => {
  if (!isRecord(payload) || !Array.isArray(payload.LocationResult)) {
    return null;
  }

  if (
    !payload.LocationResult.every(isRecord)
  ) {
    return null;
  }

  return payload.LocationResult as UpstreamLocation[];
};

const normalizeLocation = (
  location: UpstreamLocation,
): ValidLocation => {
  const coordinates = isRecord(location.Location)
    ? location.Location
    : null;

  return {
    municipality: asNullableString(location.Municipality),
    postcode: asNullableString(location.Zipcode),
    street: asNullableString(location.Thoroughfarename),
    houseNumber: asNullableString(location.Housenumber),
    providerId: asProviderId(location.ID),
    formattedAddress: asNullableString(location.FormattedAddress),
    locationType: asNullableString(location.LocationType),
    latitude: asFiniteCoordinate(
      coordinates?.Lat_WGS84,
      -90,
      90,
    ),
    longitude: asFiniteCoordinate(
      coordinates?.Lon_WGS84,
      -180,
      180,
    ),
  };
};

const requestedHouseNumber = (query: string): string | null => {
  const match = query.match(
    /(?:^|[\s,])(\d[A-Za-z]?(?:[-/]\d[A-Za-z]?)?)(?:[\s,]|$)/,
  );

  return match?.[1]?.toLowerCase() ?? null;
};

const matchesRequestedHouseNumber = (
  query: string,
  location: ValidLocation,
) => {
  const requested = requestedHouseNumber(query);

  if (!requested) {
    return true;
  }

  return location.houseNumber?.toLowerCase() === requested;
};

const isResolvedLocation = (
  query: string,
  location: ValidLocation,
) =>
  location.houseNumber !== null &&
  location.latitude !== null &&
  location.longitude !== null &&
  matchesRequestedHouseNumber(query, location);

export type DigitaalVlaanderenHousenumberResolution = {
  providerId: string | number | null;
  formattedAddress: string | null;
  municipality: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  locationType: string | null;
  latitude: number;
  longitude: number;
  rawResponse: unknown;
};

export async function resolveDigitaalVlaanderenHousenumber(
  query: string,
): Promise<DigitaalVlaanderenHousenumberResolution | null> {
  const url = new URL(
    `${DIGITAAL_VLAANDEREN_BASE_URL}/Location`,
  );

  url.searchParams.set("q", query);
  url.searchParams.set("type", "Housenumber");
  url.searchParams.set("c", "5");

  const payload = await fetchProviderJson(url);
  const locations = parseLocations(payload);

  if (!locations) {
    throw new Error("malformed_response");
  }

  const normalizedLocations = locations.map(normalizeLocation);
  const resolvedLocation = normalizedLocations.find((location) =>
    isResolvedLocation(query, location),
  );

  if (
    !resolvedLocation ||
    resolvedLocation.latitude === null ||
    resolvedLocation.longitude === null
  ) {
    return null;
  }

  return {
    providerId: resolvedLocation.providerId,
    formattedAddress: resolvedLocation.formattedAddress,
    municipality: resolvedLocation.municipality,
    street: resolvedLocation.street,
    houseNumber: resolvedLocation.houseNumber,
    postcode: resolvedLocation.postcode,
    locationType: resolvedLocation.locationType,
    latitude: resolvedLocation.latitude,
    longitude: resolvedLocation.longitude,
    rawResponse: payload,
  };
}
  
export function registerDigitaalVlaanderenRoutes(
  app: Hono<GeolocationBindings>,
) {
  app.get("/api/geocoding/suggestions", async (c) => {
    const query = validateQuery(c.req.query("q"));

    if (!query) {
      return c.json(
        {
          error:
            "Query must be a trimmed string between 2 and 200 characters",
        },
        400,
      );
    }

    const url = new URL(
      `${DIGITAAL_VLAANDEREN_BASE_URL}/Suggestion`,
    );
    url.searchParams.set("q", query);
    url.searchParams.set("c", String(MAX_SUGGESTIONS));

    try {
      const payload = await fetchProviderJson(url);
      const suggestions = parseSuggestions(payload);

      if (!suggestions) {
        console.error(
          "Digitaal Vlaanderen suggestions response was malformed",
        );

        return c.json(
          { error: "Geocoding provider returned malformed data" },
          502,
        );
      }

      return c.json({
        suggestions: suggestions.map((address) => ({
          selection: address,
          address,
        })),
      });
    } catch (error) {
      console.error("Digitaal Vlaanderen suggestions request failed", error);

      return c.json(
        { error: "Geocoding provider unavailable" },
        502,
      );
    }
  });

  app.get("/api/geocoding/location", async (c) => {
    const query = validateQuery(c.req.query("q"));

    if (!query) {
      return c.json(
        {
          error:
            "Query must be a trimmed string between 2 and 200 characters",
        },
        400,
      );
    }

    const url = new URL(
      `${DIGITAAL_VLAANDEREN_BASE_URL}/Location`,
    );
    url.searchParams.set("q", query);
    url.searchParams.set("type", "Housenumber");
    url.searchParams.set("c", "5");

        try {
      const location = await resolveDigitaalVlaanderenHousenumber(
        query,
      );

      if (!location) {
        return c.json({
          status: "unresolved",
          location: null,
        });
      }

      return c.json({
        status: "resolved",
        location: {
          providerId: location.providerId,
          formattedAddress: location.formattedAddress,
          municipality: location.municipality,
          street: location.street,
          houseNumber: location.houseNumber,
          postcode: location.postcode,
          locationType: location.locationType,
          coordinates: {
            latitude: location.latitude,
            longitude: location.longitude,
          },
        },
      });
    } catch (error) {
      console.error(
        "Digitaal Vlaanderen location request failed",
        error instanceof Error ? error.name : "unknown",
      );

      return c.json(
        { error: "Geocoding provider unavailable" },
        502,
      );
    }
  });
}