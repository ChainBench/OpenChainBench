export const runtime = 'edge';

const SECRET = process.env.INTERNAL_RELAY_SECRET ?? '';

export async function GET(request: Request) {
  const auth = request.headers.get('x-relay-secret');
  if (SECRET && auth !== SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  const body = JSON.stringify({
    operationName: 'CreateApiToken',
    query: 'mutation CreateApiToken { createApiTokens(input: { count: 1 }) { token } }',
    variables: {},
  });

  const resp = await fetch('https://un.defined.fi/api', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: 'https://un.defined.fi',
      Referer: 'https://un.defined.fi/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
    body,
  });

  const status = resp.status;
  const text = await resp.text();

  if (status !== 200) {
    return new Response(JSON.stringify({ error: `upstream ${status}`, body: text.slice(0, 200) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let parsed: { data?: { createApiTokens?: { token: string }[] } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({ error: 'parse error', body: text.slice(0, 200) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = parsed?.data?.createApiTokens?.[0]?.token;
  if (!token) {
    return new Response(JSON.stringify({ error: 'no token', body: text.slice(0, 300) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(token, {
    headers: { 'Content-Type': 'text/plain' },
  });
}
