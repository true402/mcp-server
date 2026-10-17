// Who this client is, for the true402 update notice. `src/clients/registry.test.ts` in the true402
// repo holds it equal to package.json.
export const CLIENT = { id: 'mcp', version: '1.3.0', package: '@true402.dev/mcp-server', install: 'npm i -g @true402.dev/mcp-server@latest (or npx -y @true402.dev/mcp-server@latest)' } as const;

// Update notice. Every request says which client it is (`true402-mcp/<version>`); when a newer
// release exists, true402 answers with `X-True402-Client-Latest` and `X-True402-Client-Update`
// (`recommended` | `required`). The MCP server speaks over stdio, so the notice can NEVER go to
// stdout (it would corrupt the protocol) and stderr is invisible in most hosts — it is returned in
// the tool result instead, once per process, where the agent and its user actually read it.
//
// The message is built HERE, from this package's own name and install command. Only a strictly
// validated version number is taken from the response: printing a server's free text would let a
// hostile endpoint tell the user to install something else.
export const USER_AGENT = `true402-${CLIENT.id}/${CLIENT.version} (+https://true402.dev/integrations)`;

const DEFAULT_ORIGIN = 'https://true402.dev/api';
const isTrue402 = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === 'true402.dev' || host.endsWith('.true402.dev');
  } catch {
    return false;
  }
};

const isNewer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The line to show for this response, or null. Pure — see takeUpdateNotice for the once-only part. */
export function updateNotice(res: Response, fromUrl: string = DEFAULT_ORIGIN): string | null {
  // Only true402 itself may say we are out of date. Any other seller could otherwise make this
  // client print a fake "security fix pending" — it could not change what gets installed (that
  // command is ours), but it could alarm the user.
  if (!isTrue402(fromUrl)) return null;
  // Never throws: a notice must not be able to break a paid call (or a stub without headers).
  let latest = '';
  let required = false;
  try {
    latest = res.headers.get('x-true402-client-latest')?.trim() ?? '';
    required = res.headers.get('x-true402-client-update') === 'required';
  } catch {
    return null;
  }
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(latest) || !isNewer(latest, CLIENT.version)) return null;
  return required
    ? `[true402] ${CLIENT.package} ${CLIENT.version} has a security fix pending — update to ${latest}: ${CLIENT.install}`
    : `[true402] ${CLIENT.package} ${latest} is available (you have ${CLIENT.version}): ${CLIENT.install}`;
}

let shown = false;
/** The notice, the first time one applies in this process; null every other time. */
export function takeUpdateNotice(res: Response, fromUrl: string): string | null {
  if (shown) return null;
  const line = updateNotice(res, fromUrl);
  if (line) shown = true;
  return line;
}
