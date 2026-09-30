const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): string => { let text = ''; for (const byte of bytes) text += byte.toString(16).padStart(2, '0'); return text; };

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(data)));
}
async function sha256Text(text: string): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))); }

/** RFC 3986 encoding of UTF-8, as SigV4 requires: everything except `A-Z a-z 0-9 - _ . ~` (and `/` when kept). */
export function awsUriEncode(value: string, keepSlash: boolean): string {
  let encoded = '';
  for (const byte of encoder.encode(value)) {
    const character = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9\-_.~]/u.test(character) || (keepSlash && character === '/') ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

export interface AwsCredentials { readonly accessKeyId: string; readonly secretAccessKey: string; readonly sessionToken?: string }
export interface SignInput {
  readonly method: string;
  /** The request URL, whose path is already encoded as it will be sent. */
  readonly url: URL;
  /** The query parameters, unencoded; they are encoded and sorted for signing and for the URL. */
  readonly query: readonly (readonly [string, string])[];
  /** Headers to send and sign, with lowercase names. `host` and the `x-amz-*` signing headers are added. */
  readonly headers: Readonly<Record<string, string>>;
  /** The payload's SHA-256 in hex. */
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

/** The query string exactly as SigV4 canonicalizes it, which is also how the request sends it. */
export function awsCanonicalQuery(query: readonly (readonly [string, string])[]): string {
  return query.map(([name, value]) => [awsUriEncode(name, false), awsUriEncode(value, false)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([name, value]) => `${name}=${value}`).join('&');
}

/**
 * Signs a request with AWS Signature Version 4 (header-based). Returns the headers to send: the given ones plus
 * `x-amz-date`, `x-amz-content-sha256`, `x-amz-security-token` for temporary credentials, and `authorization`.
 * `host` is signed but not returned: fetch sends it from the URL.
 */
export async function signAwsRequest(input: SignInput): Promise<Record<string, string>> {
  const amzDate = input.now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, 'x-amz-date': amzDate, 'x-amz-content-sha256': input.payloadHash,
    ...(input.credentials.sessionToken ? { 'x-amz-security-token': input.credentials.sessionToken } : {}) };
  const signing: Record<string, string> = { ...headers, host: input.url.host };
  const names = Object.keys(signing).map(name => name.toLowerCase()).sort();
  const canonicalHeaders = names.map(name => `${name}:${signing[name]!.trim().replace(/\s+/gu, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [input.method, input.url.pathname || '/', awsCanonicalQuery(input.query), canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Text(canonicalRequest)].join('\n');
  let key = await hmac(encoder.encode(`AWS4${input.credentials.secretAccessKey}`), date);
  for (const part of [input.region, input.service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
