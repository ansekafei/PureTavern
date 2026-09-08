export interface Env {
  PURE_TAVERN_PROXY_KEY: string;
  ALLOWED_ORIGINS?: string;
}

const PROTOCOL = "pure-tavern-generation-proxy";
const PROTOCOL_VERSION = 1;
const PROXY_HEADER = "X-Pure-Tavern-Proxy";
const PROXY_ERROR_HEADER = "X-Pure-Tavern-Proxy-Error";

const REQUEST_BLOCKED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "accept-encoding",
]);

const RESPONSE_BLOCKED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authentication-info",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

function getAllowedOrigin(
  request: Request,
  env: Env,
): string {
  const requestOrigin = request.headers.get("Origin");

  if (!requestOrigin) {
    return "";
  }

  const configured = env.ALLOWED_ORIGINS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!configured || configured.length === 0) {
    return requestOrigin;
  }

  if (configured.includes("*")) {
    return "*";
  }

  if (configured.includes(requestOrigin)) {
    return requestOrigin;
  }

  return "";
}

function corsHeaders(
  request: Request,
  env: Env,
): Headers {
  const headers = new Headers();

  const origin = getAllowedOrigin(request, env);

  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS",
  );

  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );

  headers.set(
    "Access-Control-Expose-Headers",
    PROXY_HEADER,
  );

  headers.set(
    "Access-Control-Max-Age",
    "86400",
  );

  return headers;
}

function responseWithCors(
  body: BodyInit | null,
  init: ResponseInit,
  request: Request,
  env: Env,
): Response {
  const headers = new Headers(init.headers);

  const cors = corsHeaders(request, env);

  for (const [key, value] of cors.entries()) {
    headers.set(key, value);
  }

  return new Response(body, {
    ...init,
    headers,
  });
}

function jsonResponse(
  data: unknown,
  status: number,
  request: Request,
  env: Env,
): Response {
  return responseWithCors(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    },
    request,
    env,
  );
}

function unauthorized(
  request: Request,
  env: Env,
): Response {
  return jsonResponse(
    {
      error: "Unauthorized",
    },
    401,
    request,
    env,
  );
}

function isAuthorized(
  request: Request,
  env: Env,
): boolean {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return false;
  }

  const expected = `Bearer ${env.PURE_TAVERN_PROXY_KEY}`;

  return authorization === expected;
}

function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    if (url.username || url.password) {
      return false;
    }

    if (url.hash) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function copyRequestHeaders(
  input: Record<string, unknown> | undefined,
): Headers {
  const headers = new Headers();

  if (!input) {
    return headers;
  }

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      continue;
    }

    if (REQUEST_BLOCKED_HEADERS.has(key.toLowerCase())) {
      continue;
    }

    headers.set(key, value);
  }

  return headers;
}

function copyResponseHeaders(
  upstream: Response,
): Headers {
  const headers = new Headers();

  upstream.headers.forEach((value, key) => {
    if (RESPONSE_BLOCKED_HEADERS.has(key.toLowerCase())) {
      return;
    }

    headers.set(key, value);
  });

  return headers;
}

interface ProxyRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, unknown>;
  body?: string | null;
}

interface ProxyEnvelope {
  protocol: string;
  protocolVersion: number;
  request: ProxyRequest;
}

function validateEnvelope(
  payload: unknown,
): ProxyEnvelope | null {
  if (
    typeof payload !== "object" ||
    payload === null
  ) {
    return null;
  }

  const envelope = payload as Record<string, unknown>;

  if (envelope.protocol !== PROTOCOL) {
    return null;
  }

  if (envelope.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }

  if (
    typeof envelope.request !== "object" ||
    envelope.request === null
  ) {
    return null;
  }

  const request =
    envelope.request as Record<string, unknown>;

  if (!isValidHttpUrl(request.url)) {
    return null;
  }

  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return null;
  }

  if (
    request.body !== undefined &&
    request.body !== null &&
    typeof request.body !== "string"
  ) {
    return null;
  }

  if (
    request.headers !== undefined &&
    (
      typeof request.headers !== "object" ||
      request.headers === null ||
      Array.isArray(request.headers)
    )
  ) {
    return null;
  }

  return {
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    request: {
      url: request.url as string,
      method: request.method as "GET" | "POST",
      headers:
        request.headers as
          | Record<string, unknown>
          | undefined,
      body:
        request.body === undefined
          ? undefined
          : request.body as string | null,
    },
  };
}

async function handleHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorized(request, env);
  }

  return jsonResponse(
    {
      status: "ok",
      service: "pure-tavern-cloudflare-backend",
      protocol: PROTOCOL,
      protocolVersion: PROTOCOL_VERSION,
    },
    200,
    request,
    env,
  );
}

async function handleProxy(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isAuthorized(request, env)) {
    return unauthorized(request, env);
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return jsonResponse(
      {
        error: "Invalid JSON request body",
      },
      400,
      request,
      env,
    );
  }

  const envelope = validateEnvelope(payload);

  if (!envelope) {
    return jsonResponse(
      {
        error: "Invalid PureTavern proxy envelope",
      },
      400,
      request,
      env,
    );
  }

  const target = envelope.request.url;

  const upstreamHeaders = copyRequestHeaders(
    envelope.request.headers,
  );

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(target, {
      method: envelope.request.method,
      headers: upstreamHeaders,
      body:
        envelope.request.method === "GET"
          ? undefined
          : envelope.request.body ?? undefined,
      redirect: "follow",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown upstream fetch error";

    return jsonResponse(
      {
        error: "Upstream request failed",
        message,
      },
      502,
      request,
      env,
    );
  }

  const responseHeaders =
    copyResponseHeaders(upstreamResponse);

  responseHeaders.set(
    PROXY_HEADER,
    "1",
  );

  const headers = new Headers(
    responseHeaders,
  );

  const cors = corsHeaders(request, env);

  for (const [key, value] of cors.entries()) {
    headers.set(key, value);
  }

  return new Response(
    upstreamResponse.body,
    {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers,
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return responseWithCors(
        null,
        {
          status: 204,
        },
        request,
        env,
      );
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/health"
    ) {
      return handleHealth(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/proxy"
    ) {
      return handleProxy(request, env);
    }

    return jsonResponse(
      {
        error: "Not Found",
        endpoints: [
          "GET /v1/health",
          "POST /v1/proxy",
        ],
      },
      404,
      request,
      env,
    );
  },
};
