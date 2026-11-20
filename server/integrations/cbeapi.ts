const CBEAPI_BASE_URL = "https://cbeapi.be/api/v1";
const CBEAPI_SEARCH_PATH = "company/search";
const CBEAPI_QUERY_PARAMETER = "name";

const CBEAPI_AUTH_HEADER_NAME = "Authorization";
const CBEAPI_TIMEOUT_MS = 8_000;

export class CbeApiError extends Error {
  readonly code: "upstream" | "malformed";

  constructor(
    code: "upstream" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "CbeApiError";
    this.code = code;
  }
}

export type CbeAddress = {
  street: string | null;
  street_number: string | null;
  post_code: string | null;
  city: string | null;
  full_address: string | null;
  date_striking_off: string | null;
};

export type CbeEstablishment = {
  cbe_number: string;
  establishment_number: string;
  start_date: string | null;
  street: string | null;
  post_code: string | null;
  city: string | null;
  house_number: string | null;
  box: string | null;
  country_code: string | null;
  full_address: string | null;
  type_of_address: string | null;
  date_striking_off: string | null;
};

export type CbeNaceActivity = {
  code: string;
  description: string | null;
  classification: string | null;
  nace_version: string;
};

export type CbeCompany = {
  cbe_number: string;
  cbe_number_formatted: string | null;
  denomination: string | null;
  abbreviation: string | null;
  commercial_name: string | null;
  branch_name: string | null;
  denomination_with_legal_form: string | null;
  address: CbeAddress;
  establishments: CbeEstablishment[];
  juridical_form: string | null;
  juridical_form_code: string | null;
  juridical_form_short: string | null;
  status: string | null;
  juridical_situation: string | null;
  type: string | null;
  start_date: string | null;
  nace_activities: CbeNaceActivity[];
};

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nullableString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const requiredString = (
  value: unknown,
  field: string,
): string => {
  const result = nullableString(value);

  if (!result) {
    throw new CbeApiError(
      "malformed",
      `CBEAPI response is missing ${field}`,
    );
  }

  return result;
};

const nullableDate = (value: unknown): string | null => {
  const result = nullableString(value);
  return result;
};

const parseAddress = (value: unknown): CbeAddress => {
  if (!isRecord(value)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response has an invalid address",
    );
  }

  return {
    street: nullableString(value.street),
    street_number: nullableString(value.street_number),
    post_code: nullableString(value.post_code),
    city: nullableString(value.city),
    full_address: nullableString(value.full_address),
    date_striking_off: nullableDate(value.date_striking_off),
  };
};

const parseEstablishments = (
  value: unknown,
): CbeEstablishment[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response has invalid establishments",
    );
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new CbeApiError(
        "malformed",
        "CBEAPI response has an invalid establishment",
      );
    }

    return {
      cbe_number: requiredString(
        entry.cbe_number,
        "establishment cbe_number",
      ),
      establishment_number: requiredString(
        entry.establishment_number,
        "establishment_number",
      ),
      start_date: nullableDate(entry.start_date),
      street: nullableString(entry.street),
      post_code: nullableString(entry.post_code),
      city: nullableString(entry.city),
      house_number: nullableString(entry.house_number),
      box: nullableString(entry.box),
      country_code: nullableString(entry.country_code),
      full_address: nullableString(entry.full_address),
      type_of_address: nullableString(entry.type_of_address),
      date_striking_off: nullableDate(entry.date_striking_off),
    };
  });
};

const parseNaceActivities = (
  value: unknown,
): CbeNaceActivity[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response has invalid nace_activities",
    );
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      throw new CbeApiError(
        "malformed",
        "CBEAPI response has an invalid NACE activity",
      );
    }

    return {
      code: requiredString(entry.code, "NACE code"),
      description: nullableString(entry.description),
      classification: nullableString(entry.classification),
      nace_version: requiredString(
        entry.nace_version,
        "NACE version",
      ),
    };
  });
};

const parseCompany = (value: unknown): CbeCompany => {
  if (!isRecord(value)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response has an invalid company",
    );
  }

  const cbeNumber = requiredString(
    value.cbe_number,
    "cbe_number",
  );

  if (!/^\d{10}$/.test(cbeNumber)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response has an invalid cbe_number",
    );
  }

  return {
    cbe_number: cbeNumber,
    cbe_number_formatted: nullableString(
      value.cbe_number_formatted,
    ),
    denomination: nullableString(value.denomination),
    abbreviation: nullableString(value.abbreviation),
    commercial_name: nullableString(value.commercial_name),
    branch_name: nullableString(value.branch_name),
    denomination_with_legal_form: nullableString(
      value.denomination_with_legal_form,
    ),
    address: parseAddress(value.address),
    establishments: parseEstablishments(value.establishments),
    juridical_form: nullableString(value.juridical_form),
    juridical_form_code: nullableString(
      value.juridical_form_code,
    ),
    juridical_form_short: nullableString(
      value.juridical_form_short,
    ),
    status: nullableString(value.status),
    juridical_situation: nullableString(
      value.juridical_situation,
    ),
    type: nullableString(value.type),
    start_date: nullableDate(value.start_date),
    nace_activities: parseNaceActivities(
      value.nace_activities,
    ),
  };
};

export const searchCompanies = async (
  env: Pick<Env, "CBEAPI_API_KEY">,
  query: string,
): Promise<CbeCompany[]> => {
  const url = new URL(
    `${CBEAPI_BASE_URL.replace(/\/+$/, "")}/${CBEAPI_SEARCH_PATH.replace(/^\/+/, "")}`,
  );

  url.searchParams.set(CBEAPI_QUERY_PARAMETER, query);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      [CBEAPI_AUTH_HEADER_NAME]: env.CBEAPI_API_KEY,
    },
    signal: AbortSignal.timeout(CBEAPI_TIMEOUT_MS),
  }).catch((error) => {
    throw new CbeApiError(
      "upstream",
      error instanceof Error ? error.name : "fetch_failed",
    );
  });

  if (!response.ok) {
    throw new CbeApiError(
      "upstream",
      `HTTP_${response.status}`,
    );
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response was not JSON",
    );
  }

  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new CbeApiError(
      "malformed",
      "CBEAPI response data was not an array",
    );
  }

  const companies = payload.data.map(parseCompany);

  return companies.filter(
    (company) =>
      company.type !== "natural_person" &&
      company.status === "active",
  );
};

export const parseCachedCompany = (
  value: unknown,
): CbeCompany => parseCompany(value);