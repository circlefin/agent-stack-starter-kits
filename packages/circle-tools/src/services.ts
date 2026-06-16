import { runCircle, runCircleJson } from './cli';
import {
  CHAIN_PREFERENCE,
  chainCli,
  chainFromNetwork,
  DEFAULT_CHAIN,
  type Chain,
} from './chains';
import type {
  AcceptOption,
  FetchServiceResult,
  PaymentResult,
  Service,
  ServiceAccepts,
  ServiceInspection,
} from './types';

const TX_HASH_REGEX = /0x[a-fA-F0-9]{64}/;
/**
 * Request timeout for a paid call, in seconds. The CLI defaults to 30s, which is
 * too tight for slower x402 endpoints: under x402 the payment is submitted
 * *before* the upstream request resolves, so a timeout still spends USDC. A
 * larger ceiling lets a slow-but-valid endpoint answer instead of wasting a
 * charged call.
 */
const PAY_TIMEOUT_SECONDS = 60;
/** Extra attempts for idempotent read commands when the network blips. */
const READ_RETRIES = 3;
/** USDC has 6 decimals; the marketplace quotes payment amounts in atomic units. */
const USDC_DECIMALS = 6;

export interface SearchServicesInput {
  keyword: string;
}

export interface InspectServiceInput {
  url: string;
}

export interface FetchServiceInput {
  url: string;
}

export interface PayServiceInput {
  url: string;
  address: string;
  data: Record<string, unknown>;
  /**
   * HTTP method the service expects, from its inspection. Defaults to GET.
   * GET/DELETE send `data` as URL query parameters; POST/PUT/PATCH send it as a
   * JSON request body.
   */
  method?: string;
  /**
   * Chain to settle the payment on. Must be a chain the seller offers (see
   * preferredChain). Defaults to Base.
   */
  chain?: Chain;
}

/**
 * Loose shape of one item in `circle services search` JSON output (CLI 0.0.3).
 * Every field is optional so a CLI shape change degrades gracefully instead of
 * throwing.
 */
interface RawSearchItem {
  resource?: string;
  accepts?: Array<{ amount?: string }>;
  metadata?: {
    provider?: { name?: string; description?: string };
    description?: string;
    path?: string;
  };
}

/** Loose shape of the `circle services inspect` JSON `data` object. */
interface RawInspection {
  url?: string;
  status?: string;
  description?: string;
  provider?: { name?: string; description?: string };
  price?: { amount?: string; formatted?: string };
  input?: unknown;
  method?: string;
}

/** Format an atomic USDC amount (e.g. "4000") as a human string ("0.004 USDC"). */
function formatUsdc(atomic: string | undefined): string | undefined {
  if (!atomic) return undefined;
  const n = Number(atomic);
  if (!Number.isFinite(n)) return undefined;
  return `${n / 10 ** USDC_DECIMALS} USDC`;
}

/**
 * Pull the result array out of `circle services search` output. The CLI (0.0.3)
 * wraps results as `{ data: { items: [...] } }`; a bare `{ items: [...] }` is
 * also tolerated so a minor CLI change does not silently zero out results.
 */
function extractSearchItems(raw: unknown): RawSearchItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | undefined;
  if (data && Array.isArray(data.items)) return data.items as RawSearchItem[];
  if (Array.isArray(o.items)) return o.items as RawSearchItem[];
  return [];
}

function mapSearchItem(item: RawSearchItem): Service {
  const meta = item.metadata ?? {};
  const provider = meta.provider ?? {};
  return {
    url: item.resource ?? '',
    name: provider.name ?? meta.path ?? item.resource ?? 'unknown service',
    description: meta.description ?? provider.description,
    price: formatUsdc(item.accepts?.[0]?.amount),
  };
}

/** Unwrap the `{ data: ... }` envelope the CLI puts around inspect output. */
function unwrapData(raw: unknown): RawInspection {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  if (o.data && typeof o.data === 'object') return o.data as RawInspection;
  return o as RawInspection;
}

/** `circle services search "<keyword>" --output json` */
export async function searchServices(input: SearchServicesInput): Promise<Service[]> {
  const raw = runCircleJson<unknown>(['services', 'search', input.keyword, '--output', 'json'], {
    retries: READ_RETRIES,
  });
  return extractSearchItems(raw).map(mapSearchItem);
}

/** `circle services inspect "<url>" --output json` */
export async function inspectService(input: InspectServiceInput): Promise<ServiceInspection> {
  const raw = runCircleJson<unknown>(['services', 'inspect', input.url, '--output', 'json'], {
    retries: READ_RETRIES,
  });
  const data = unwrapData(raw);
  const provider = data.provider ?? {};
  return {
    url: data.url ?? input.url,
    name: provider.name ?? data.description ?? data.url ?? input.url,
    description: data.description ?? provider.description,
    price: data.price?.formatted ?? formatUsdc(data.price?.amount),
    schema: data.input,
    health: data.status,
    method: data.method ? data.method.toUpperCase() : undefined,
  };
}

/**
 * Plain, unpaid HTTP GET of a service endpoint: the free-tier path.
 *
 * x402 semantics: an unpaid GET of a paid resource answers HTTP 402 with a
 * payment challenge; a free endpoint answers 200 with the data itself. The kit's
 * payService path only handles the 402 case, so a free endpoint (e.g. a catalog
 * or index that publishes no `accepts[]`) has no payment to make and must be
 * read with this helper instead.
 *
 * Returns the body for the free case and flags `paymentRequired` for the 402
 * case so the caller can route to inspectService / payService.
 */
export async function fetchService(input: FetchServiceInput): Promise<FetchServiceResult> {
  let res: Response;
  try {
    res = await fetch(input.url, { method: 'GET' });
  } catch (e) {
    throw new Error(`Could not reach ${input.url}: ${(e as Error).message}`);
  }
  const contentType = res.headers.get('content-type') ?? undefined;
  const raw = await res.text();
  // Re-stringify JSON compact so the agent gets a valid, dense payload; leave
  // any other content type exactly as the server sent it.
  let body = raw;
  if (contentType?.includes('application/json')) {
    try {
      body = JSON.stringify(JSON.parse(raw));
    } catch {
      // Header claims JSON but the body is not, so return the raw text.
    }
  }
  return {
    url: input.url,
    status: res.status,
    paymentRequired: res.status === 402,
    contentType,
    body,
  };
}

/** Loose shape of one entry in an x402 402-challenge `accepts[]` array. */
interface Raw402Accept {
  network?: string;
  amount?: string;
  extra?: { name?: string };
}

/**
 * Decode a base64 (or base64url) JSON string into an object, or null if it is
 * not valid base64-encoded JSON. Used for the x402 v2 `payment-required` header.
 */
function decodeBase64Json(value: string): Record<string, unknown> | null {
  try {
    const json = Buffer.from(value, 'base64').toString('utf8');
    const obj = JSON.parse(json) as unknown;
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extract the x402 `accepts[]` from a 402 response. The challenge travels one of
 * two ways depending on the x402 version a seller speaks:
 *   - v1: a JSON response *body* `{ accepts: [...] }`.
 *   - v2: an empty body plus a base64-encoded JSON `payment-required` *header*
 *     `{ x402Version: 2, accepts: [...] }`.
 * Both must be handled: a v2 seller (e.g. StableEnrich) sends an empty body, so
 * a body-only reader sees no challenge and wrongly rejects a payable service.
 * Returns the accepts array, or null when neither transport carries a challenge
 * (e.g. a 405 to a wrong-method probe).
 */
async function readAccepts(res: Response): Promise<Raw402Accept[] | null> {
  // Header transport (x402 v2) first: it is present even when the body is empty.
  const header = res.headers.get('payment-required');
  if (header) {
    const decoded = decodeBase64Json(header.trim());
    if (decoded && Array.isArray(decoded.accepts)) return decoded.accepts as Raw402Accept[];
  }
  // Body transport (x402 v1).
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { accepts?: unknown }).accepts)) {
    return (parsed as { accepts: Raw402Accept[] }).accepts;
  }
  return null;
}

/**
 * Fetch a service's x402 payment challenge and normalise its `accepts[]` into
 * the chains and schemes the kit can act on.
 *
 * An unpaid GET to an x402 resource returns HTTP 402 with an `accepts` array.
 * Each entry is either vanilla x402 or Gateway-batched. The Gateway scheme is
 * identified by `extra.name === 'GatewayWalletBatched'`, NOT the top-level
 * `scheme` field (which reads `exact` for both). Entries on a supported chain
 * (Base or Polygon, matched by CAIP-2 id or x402 short name) are kept and
 * tagged with their chain; any other network is reported as unsupported.
 */
export async function getServiceAccepts(url: string, method = 'GET'): Promise<ServiceAccepts> {
  // Probe with the SAME method the payment will use. An x402 challenge is bound
  // to the route's method: a POST-only endpoint answers 405 (not 402) to a GET,
  // so a GET probe would miss the challenge entirely. The 402 is returned before
  // the request body is read, so the probe needs no body to see the options.
  const probeMethod = method.toUpperCase();
  let res: Response;
  try {
    res = await fetch(url, { method: probeMethod });
  } catch (e) {
    throw new Error(
      `Could not reach ${url} to read its x402 payment options: ${(e as Error).message}`,
    );
  }
  // Read the challenge from either transport (v2 header or v1 body). A null
  // result means no challenge was returned at all: most often a 405 from probing
  // with the wrong method, so point the caller at passing the inspected method.
  const accepts = await readAccepts(res);
  if (accepts === null) {
    throw new Error(
      `${url} did not return an x402 challenge to a ${probeMethod} request (HTTP ${res.status}). ` +
        'If the service expects a different HTTP method, pass the `method` from ' +
        'circle_inspect_service so the payment options are read with that method.',
    );
  }
  if (accepts.length === 0) {
    throw new Error(
      `${url} published no x402 payment options, so it is not a paid x402 resource. ` +
        'If it is a free endpoint, read it with fetch_service instead of pay_service.',
    );
  }
  const options: AcceptOption[] = [];
  const unsupported = new Set<string>();
  for (const a of accepts) {
    const network = a.network ?? '';
    const chain = network ? chainFromNetwork(network) : null;
    if (!chain) {
      if (network) unsupported.add(network);
      continue;
    }
    options.push({
      kind: a.extra?.name === 'GatewayWalletBatched' ? 'gateway' : 'vanilla',
      chain,
      amountAtomic: a.amount ?? '',
    });
  }
  return { url, options, unsupportedNetworks: [...unsupported] };
}

/**
 * Pick the chain to pay a service on: the first chain in CHAIN_PREFERENCE the
 * seller offers, so Base wins when available and Polygon is the fallback.
 * Returns null when the seller offers no supported chain.
 */
export function preferredChain(accepts: ServiceAccepts): Chain | null {
  for (const chain of CHAIN_PREFERENCE) {
    if (accepts.options.some((o) => o.chain === chain)) return chain;
  }
  return null;
}

/**
 * Whether the service requires a Circle Gateway (batched) payment on the given
 * chain. The CLI auto-routes to Gateway whenever the seller advertises it on
 * the chain being paid, so a single Gateway option is enough to require it.
 */
export function sellerRequiresGateway(accepts: ServiceAccepts, chain: Chain): boolean {
  return accepts.options.some((o) => o.chain === chain && o.kind === 'gateway');
}

/**
 * CLI failure substrings that mean the x402 payment was already submitted (the
 * USDC moved) but the upstream request failed afterwards: a server-side reject,
 * a timeout, or a dropped response. Under x402 the charge happens before the
 * request resolves, so these are non-refundable and MUST NOT be retried with a
 * fresh payment to the same URL.
 */
const PAYMENT_SUBMITTED_PATTERNS = [
  'payment submitted',
  'payment was submitted',
  'payment may have been submitted',
  'funds may have moved',
];

function paymentAlreadySubmitted(detail: string): boolean {
  return PAYMENT_SUBMITTED_PATTERNS.some((p) => detail.includes(p));
}

/**
 * Translate a raw `circle services pay` failure into an actionable error.
 *
 * Two cases get rewritten:
 *
 * 1. Gateway routing: the CLI auto-routes to Circle Gateway whenever a seller
 *    advertises it, even when the wallet holds only vanilla USDC, and there is
 *    no flag to force vanilla (CLI 0.0.3). The resulting "No/Insufficient
 *    Gateway balance" message is opaque; rewrite it into the concrete next step.
 *
 * 2. Payment-submitted-but-request-failed: the USDC already moved but the
 *    upstream answered an error (e.g. a 400 from a service whose published
 *    schema is inaccurate) or timed out. This is a terminal, non-retryable
 *    failure: re-paying the same URL just spends more USDC for the same result.
 *    Rewrite it so the agent stops retrying and chooses a different service.
 */
function explainPayError(e: unknown, url: string): Error {
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  if (
    lower.includes('no gateway balance found') ||
    lower.includes('insufficient gateway balance')
  ) {
    return new Error(
      'This seller requires a Circle Gateway (batched) payment and the wallet has no ' +
        'Gateway balance on the chain the seller settles on. Call gateway_deposit for ' +
        `this service URL, then retry the payment.\n\nUnderlying CLI error: ${message}`,
    );
  }
  if (paymentAlreadySubmitted(lower)) {
    return new Error(
      `The USDC payment for ${url} was already submitted and has been spent, but the ` +
        'request failed afterwards (the server rejected it or it timed out). This is ' +
        'NOT a payload problem you can fix by retrying: x402 charges before the request ' +
        'resolves, so re-paying this URL just spends more USDC for the same failure. ' +
        "Do not pay this URL again. The service's published input schema may be " +
        'inaccurate, or the endpoint may be unhealthy. Choose a different service, or ' +
        `report this one as broken.\n\nUnderlying CLI error: ${message}`,
    );
  }
  return e instanceof Error ? e : new Error(message);
}

/**
 * HTTP methods that carry a request body. Everything else (GET, DELETE) takes
 * its input as URL query parameters instead.
 */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Encode a flat payload object onto a URL's query string. Array values become
 * repeated keys (`symbols=ETH&symbols=BTC`), matching how x402 GET services
 * publish their input. Non-string scalars are stringified; nested objects are
 * JSON-encoded so nothing is silently dropped. Existing query params on the URL
 * are preserved.
 */
function appendQuery(url: string, data: Record<string, unknown>): string {
  const u = new URL(url);
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) u.searchParams.append(key, String(item));
    } else if (typeof value === 'object') {
      u.searchParams.append(key, JSON.stringify(value));
    } else {
      u.searchParams.append(key, String(value));
    }
  }
  return u.toString();
}

/**
 * Best-effort tx-hash extraction. A bare 64-hex hash in the text wins; failing
 * that, x402 settle receipts (the `x-payment-response` header surfaced as
 * `payment.receipt`) are base64-encoded JSON like `{"transaction":"0x..."}`, so
 * decode and look inside. Never throws: a missing hash is not an error.
 */
function extractTxHash(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const direct = source.match(TX_HASH_REGEX)?.[0];
  if (direct) return direct;
  try {
    const decoded = Buffer.from(source, 'base64').toString('utf8');
    return decoded.match(TX_HASH_REGEX)?.[0];
  } catch {
    return undefined;
  }
}

/** The `{ response, payment }` envelope `circle services pay --output json` prints. */
interface RawPayEnvelope {
  response?: unknown;
  payment?: { amount?: string; receipt?: string };
}

/**
 * `circle services pay "<url>" --address <addr> --chain BASE -X <method> [-d '<json>'] --output json`
 *
 * The CLI's `-d/--data` flag implies POST and sends a JSON request body. A GET
 * service reads its input from the URL query string, so for GET/DELETE the
 * payload is encoded onto the URL and `-d` is omitted; sending a body to a GET
 * endpoint makes the server see no input (and still spends USDC, since the x402
 * payment is submitted before the request resolves).
 *
 * `--output json` is required. The CLI's default `table` output for a paid call
 * prints *only the service response body, with no tx hash* — so a hash-presence
 * check there fails on every successful payment whose body has no 0x… hash,
 * making the caller re-pay in a loop. With JSON the result is wrapped as
 * `{ response, payment: { amount, receipt } }`, and success is the CLI exit code
 * (a real failure throws), never whether a hash was found.
 */
export async function payService(input: PayServiceInput): Promise<PaymentResult> {
  const method = (input.method ?? 'GET').toUpperCase();
  const sendsBody = BODY_METHODS.has(method);
  const url = sendsBody ? input.url : appendQuery(input.url, input.data);
  const args = [
    'services',
    'pay',
    url,
    '--address',
    input.address,
    '--chain',
    chainCli(input.chain ?? DEFAULT_CHAIN),
    '--method',
    method,
    '--timeout',
    String(PAY_TIMEOUT_SECONDS),
    '--output',
    'json',
  ];
  if (sendsBody) {
    args.push('--data', JSON.stringify(input.data));
  }

  let out: string;
  try {
    out = runCircle(args);
  } catch (e) {
    throw explainPayError(e, input.url);
  }

  // The call settled the moment runCircle returned without throwing; from here
  // we only shape the body for the caller, never re-derive success.
  const trimmed = out.trim();
  let envelope: RawPayEnvelope;
  try {
    envelope = JSON.parse(trimmed) as RawPayEnvelope;
  } catch {
    // Non-JSON stdout (a quiet-mode plain-text body, say): hand it back as-is.
    return {
      response: trimmed,
      txHash: extractTxHash(trimmed),
      serviceUrl: input.url,
      amount: '',
    };
  }

  const response =
    envelope.response === undefined
      ? trimmed
      : typeof envelope.response === 'string'
        ? envelope.response
        : JSON.stringify(envelope.response);

  return {
    response,
    txHash: extractTxHash(envelope.payment?.receipt) ?? extractTxHash(trimmed),
    serviceUrl: input.url,
    amount: envelope.payment?.amount ?? '',
  };
}
