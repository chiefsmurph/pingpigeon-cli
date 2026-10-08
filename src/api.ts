import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "./generated.js";

export const DEFAULT_URL = "https://pingpigeon.app";

/** The sign-in, in ~/.pingpigeon/config.json (0600). git-drift reads and writes the same file. */
export interface Login {
  url: string;
  token: string;
  email?: string;
  topic?: string | null;
  phoneVerified?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export const loginPath = (home = homedir()) => join(home, ".pingpigeon", "config.json");

/** PINGPIGEON_TOKEN (and PINGPIGEON_URL) win, for CI and scripts; otherwise the saved sign-in. */
export async function readLogin(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<Login | null> {
  if (env.PINGPIGEON_TOKEN) return { url: env.PINGPIGEON_URL || DEFAULT_URL, token: env.PINGPIGEON_TOKEN };
  try {
    const c = JSON.parse(await readFile(loginPath(home), "utf8")) as Login;
    return c?.token ? { ...c, url: env.PINGPIGEON_URL || c.url || DEFAULT_URL } : null;
  } catch {
    return null;
  }
}

export async function saveLogin(login: Login, home = homedir()): Promise<string> {
  const path = loginPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(login, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

export async function forgetLogin(home = homedir()): Promise<boolean> {
  try {
    await rm(loginPath(home));
    return true;
  } catch {
    return false;
  }
}

type Json = Record<string, any>;

async function call(base: string, path: string, opts: { token?: string; body?: Json } = {}): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method: opts.body ? "POST" : "GET",
      headers: {
        "user-agent": `pingpigeon-cli/${VERSION}`,
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ApiError(`can't reach ${base}: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok || data.ok === false) {
    if (res.status === 401) throw new ApiError("your sign-in isn't valid anymore: run `pingpigeon login`", 401);
    throw new ApiError(data.error || `${path} answered ${res.status}`, res.status);
  }
  return data;
}

export interface Attachment {
  filename: string;
  content: string;
  contentType?: string;
}

export interface EmailMessage {
  subject?: string;
  body?: string;
  html?: string;
  attachments?: Attachment[];
  attachPdf?: boolean;
  pdfFilename?: string;
}

export const api = {
  /** Email a 6-digit code (also how an existing account signs in on a new machine). */
  signup: (url: string, email: string) => call(url, "/signup", { body: { email } }),
  /** Trade the code for a token, labelled so the account shows where it was connected. */
  verify: (url: string, email: string, code: string) => call(url, "/verify-email", { body: { email, code, client: "pingpigeon-cli" } }),
  me: (l: Login) => call(l.url, "/me", { token: l.token }),
  email: (l: Login, msg: EmailMessage) => call(l.url, "/email", { token: l.token, body: { ...msg } }),
  push: (l: Login, msg: { message: string; title?: string; priority?: number }) => call(l.url, "/push", { token: l.token, body: { ...msg } }),
  text: (l: Login, message: string) => call(l.url, "/text", { token: l.token, body: { message } }),
  addPhone: (l: Login, phone: string) => call(l.url, "/add-phone", { token: l.token, body: { phone } }),
  verifyPhone: (l: Login, code: string) => call(l.url, "/verify-phone", { token: l.token, body: { code } }),
  checkout: (l: Login) => call(l.url, "/billing/checkout", { token: l.token, body: {} }),
};
