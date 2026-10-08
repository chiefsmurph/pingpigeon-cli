import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { api, ApiError, DEFAULT_URL, forgetLogin, loginPath, readLogin, saveLogin, type Attachment, type Login } from "./api.js";
import { VERSION } from "./generated.js";

const USAGE = `pingpigeon — email, push and text yourself from the terminal (pingpigeon.app)

Usage:
  pingpigeon login [email]        sign up or sign in: you get a 6-digit code by email
       --token <token>               ...or paste a token from pingpigeon.app
  pingpigeon email [message]      email yourself (no message: reads stdin)
       -s, --subject <text>          default: the message's first line
       --html <file>                 HTML body (a message, if given, is the plain-text part)
       -a, --attach <file>           attach a file (repeatable; free: 1 file up to 5 MB)
       --pdf                         also attach the message as a PDF (free: 10 a month)
  pingpigeon push [message]       push notification to your phone (no message: reads stdin)
       -t, --title <text>  -p, --priority <1-5>
  pingpigeon text [message]       text your verified phone (free: 4 short texts a month)
  pingpigeon phone <number>       verify your phone for texts, e.g. +15551234567
  pingpigeon status               who you're signed in as, your plan and this month's usage
  pingpigeon upgrade              open checkout for Pro
  pingpigeon logout               forget the sign-in on this machine

Everything goes only to you: your verified email, your phone, your push topic.

  make test 2>&1 | tail -50 | pingpigeon email -s "tests finished"
  pingpigeon push "backup done" -t nightly

Env: PINGPIGEON_TOKEN (sign-in for CI and scripts), PINGPIGEON_URL.
Exit codes: 0 sent, 1 not sent (limit, network, server), 2 usage error.`;

class UsageError extends Error {}

export interface IO {
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  /** All of stdin, or null when stdin is a terminal (nothing piped in). */
  stdin: () => Promise<string | null>;
  open: (url: string) => void;
  env: NodeJS.ProcessEnv;
  home: string;
}

interface Args {
  cmd?: string;
  words: string[];
  subject?: string;
  html?: string;
  attach: string[];
  pdf: boolean;
  title?: string;
  priority?: number;
  token?: string;
}

const FLAGS: Record<string, string[]> = {
  email: ["-s", "--subject", "--html", "-a", "--attach", "--pdf"],
  push: ["-t", "--title", "-p", "--priority"],
  login: ["--token"],
};

function parse(argv: string[]): Args {
  const a: Args = { words: [], attach: [], pdf: false };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      a.words.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-" && !["-h", "--help", "-v", "--version"].includes(arg) && !(FLAGS[a.cmd ?? ""] ?? []).includes(arg)) {
      throw new UsageError(`unknown option "${arg}"${a.cmd ? ` for ${a.cmd}` : ""}`);
    }
    switch (arg) {
      case "-s": case "--subject": a.subject = value(i++, arg); break;
      case "--html": a.html = value(i++, arg); break;
      case "-a": case "--attach": a.attach.push(value(i++, arg)); break;
      case "--pdf": a.pdf = true; break;
      case "-t": case "--title": a.title = value(i++, arg); break;
      case "-p": case "--priority": {
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new UsageError("--priority must be 1-5");
        a.priority = n;
        break;
      }
      case "--token": a.token = value(i++, arg); break;
      case "-h": case "--help": a.cmd = "help"; break;
      case "-v": case "--version": a.cmd = "version"; break;
      default:
        if (!a.cmd) a.cmd = arg;
        else a.words.push(arg);
    }
  }
  return a;
}

async function signedIn(io: IO): Promise<Login> {
  const login = await readLogin(io.env, io.home);
  if (!login) throw new UsageError("not signed in yet: run `pingpigeon login` (free)");
  return login;
}

/** The message from the command line, else from stdin. */
async function message(a: Args, io: IO, what: string): Promise<string> {
  const text = a.words.length ? a.words.join(" ") : ((await io.stdin()) ?? "");
  if (!text.trim()) throw new UsageError(`nothing to send: pingpigeon ${what} "your message", or pipe text in`);
  return text;
}

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 78);

const usage = (me: Record<string, any>) => {
  const u = me.usage ?? {};
  const part = (x: any, label: string) => (x ? `${x.used}/${x.quota >= 100000 ? "unlimited" : x.quota} ${label}` : null);
  return [part(u.email, "emails"), part(u.pdf, "PDFs"), part(u.sms, "text segments")].filter(Boolean).join(" · ");
};

async function login(a: Args, io: IO): Promise<number> {
  const url = io.env.PINGPIGEON_URL || DEFAULT_URL;
  if (a.token) {
    const l: Login = { url, token: a.token };
    const me = await api.me(l);
    Object.assign(l, { email: me.subscriber?.email, topic: me.subscriber?.ntfy_topic ?? null, phoneVerified: !!me.subscriber?.phone_verified });
    io.say(`Signed in as ${l.email} (${me.subscriber?.plan ?? "free"} plan). Saved to ${await saveLogin(l, io.home)}.`);
    return 0;
  }
  const wanted = a.words[0];
  const existing = await readLogin({}, io.home);
  const me = existing ? await api.me({ ...existing, url: io.env.PINGPIGEON_URL || existing.url }).catch(() => null) : null;
  if (me && (!wanted || wanted.toLowerCase() === String(me.subscriber?.email).toLowerCase())) {
    io.say(`Already signed in as ${me.subscriber?.email} (${me.subscriber?.plan ?? "free"} plan). To switch: pingpigeon login other@example.com`);
    return 0;
  }
  const email = wanted || (await io.ask("Your email address: "));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UsageError(`"${email}" doesn't look like an email address`);
  try {
    await api.signup(url, email);
  } catch (e) {
    if (!/captcha/i.test((e as Error).message)) throw e;
    throw new ApiError(`PingPigeon is asking for a captcha right now (too many signups at once).\nSign up at ${url}, copy your token, and run: pingpigeon login --token <token>`);
  }
  io.say(`Sent a 6-digit code to ${email} (check spam if it isn't there in a minute).`);
  for (let tries = 3; ; tries--) {
    const code = (await io.ask("Code: ")).replace(/\s+/g, "");
    try {
      const v = await api.verify(url, email, code);
      const l: Login = { url, token: v.token, email: v.subscriber?.email ?? email, topic: v.subscriber?.ntfy_topic ?? null, phoneVerified: !!v.subscriber?.phone_verified };
      io.say(`Signed in as ${l.email}. Saved to ${await saveLogin(l, io.home)}.`);
      io.say(`Try it:  pingpigeon email "hello from my terminal"`);
      return 0;
    } catch (e) {
      if (tries <= 1 || !/invalid/i.test((e as Error).message)) throw e;
      io.say(`${(e as Error).message}. Try again.`);
    }
  }
}

async function attachment(path: string): Promise<Attachment> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new UsageError(`can't attach ${path}: not a file`);
  if (info.size > 20 * 1024 * 1024) throw new UsageError(`can't attach ${path}: over 20 MB`);
  return { filename: basename(path), content: (await readFile(path)).toString("base64") };
}

async function email(a: Args, io: IO): Promise<number> {
  const l = await signedIn(io);
  const html = a.html ? await readFile(a.html, "utf8").catch(() => { throw new UsageError(`can't read ${a.html}`); }) : undefined;
  const body = html && !a.words.length ? undefined : await message(a, io, "email");
  if (a.pdf && !body) throw new UsageError("--pdf renders the message: give one (or pipe it in)");
  const attachments = await Promise.all(a.attach.map(attachment));
  const subject = a.subject ?? (body ? firstLine(body) : attachments.map((x) => x.filename).join(", ")) ?? "";
  await api.email(l, { subject, body, html, attachments: attachments.length ? attachments : undefined, attachPdf: a.pdf || undefined });
  io.say(`Emailed ${l.email ?? "you"}.`);
  return 0;
}

async function push(a: Args, io: IO): Promise<number> {
  const l = await signedIn(io);
  await api.push(l, { message: await message(a, io, "push"), title: a.title, priority: a.priority });
  io.say("Pushed.");
  return 0;
}

async function text(a: Args, io: IO): Promise<number> {
  const l = await signedIn(io);
  await api.text(l, await message(a, io, "text"));
  io.say("Texted.");
  return 0;
}

async function phone(a: Args, io: IO): Promise<number> {
  const l = await signedIn(io);
  const number = a.words[0] || (await io.ask("Phone number (e.g. +15551234567): "));
  await api.addPhone(l, number);
  io.say(`Texted a code to ${number}.`);
  for (let tries = 3; ; tries--) {
    try {
      await api.verifyPhone(l, (await io.ask("Code: ")).replace(/\s+/g, ""));
      break;
    } catch (e) {
      if (tries <= 1 || !/invalid/i.test((e as Error).message)) throw e;
      io.say(`${(e as Error).message}. Try again.`);
    }
  }
  if (!io.env.PINGPIGEON_TOKEN) await saveLogin({ ...l, phoneVerified: true }, io.home);
  io.say(`Phone verified. Try it:  pingpigeon text "hello"`);
  return 0;
}

async function status(io: IO): Promise<number> {
  const l = await readLogin(io.env, io.home);
  if (!l) {
    io.say("Not signed in. Sign up or sign in (free):  pingpigeon login");
    return 1;
  }
  const me = await api.me(l);
  const s = me.subscriber ?? {};
  const pro = (me.usage?.plan ?? s.plan) === "pro";
  io.say(`Signed in as ${s.email} (${pro ? "Pro" : "free"} plan)${io.env.PINGPIGEON_TOKEN ? " via PINGPIGEON_TOKEN" : ` · ${loginPath(io.home)}`}`);
  io.say(`This month: ${usage(me)}`);
  io.say(s.phone_verified ? "Phone: verified" : "Phone: not verified (for texts):  pingpigeon phone +15551234567");
  if (me.push?.url) io.say(`Push: subscribe to ${me.push.url} in the ntfy app (iOS, Android) to get pushes`);
  if (!pro) io.say("Pro: 10,000 emails, unlimited PDFs and 300 text segments a month:  pingpigeon upgrade");
  return 0;
}

async function upgrade(io: IO): Promise<number> {
  const l = await signedIn(io);
  const me = await api.me(l);
  if ((me.usage?.plan ?? me.subscriber?.plan) === "pro") {
    io.say(`You're on Pro. Manage or cancel: ${l.url}/manage`);
    return 0;
  }
  const { url } = await api.checkout(l);
  io.say(`Opening checkout: ${url}`);
  io.open(url);
  return 0;
}

async function logout(io: IO): Promise<number> {
  io.say((await forgetLogin(io.home)) ? `Signed out on this machine (removed ${loginPath(io.home)}; git-drift used it too).` : "Not signed in.");
  return 0;
}

export async function run(argv: string[], io: IO): Promise<number> {
  const a = parse(argv);
  switch (a.cmd) {
    case undefined: case "help": io.say(USAGE); return a.cmd ? 0 : 2;
    case "version": io.say(VERSION); return 0;
    case "login": return login(a, io);
    case "email": return email(a, io);
    case "push": return push(a, io);
    case "text": return text(a, io);
    case "phone": return phone(a, io);
    case "status": case "whoami": return status(io);
    case "upgrade": return upgrade(io);
    case "logout": return logout(io);
    default: throw new UsageError(`unknown command "${a.cmd}" (pingpigeon --help)`);
  }
}

/** Exit code and message for a failure: usage problems are 2, anything that didn't get sent is 1. */
export function failure(e: unknown): { code: number; message: string } {
  if (e instanceof UsageError) return { code: 2, message: e.message };
  if (e instanceof ApiError) {
    const upsell = /upgrade/i.test(e.message) && !/pingpigeon upgrade/.test(e.message) ? "\n→ pingpigeon upgrade" : "";
    return { code: 1, message: `pingpigeon: ${e.message}${upsell}` };
  }
  return { code: 1, message: `pingpigeon: ${(e as Error).stack ?? e}` };
}

export function terminal(): IO & { close: () => void } {
  let rl: Interface | undefined;
  return {
    ask: async (q) => {
      if (!process.stdin.isTTY) throw new UsageError("this step needs a terminal to answer in (or use --token)");
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(q)).trim();
    },
    say: (l) => console.log(l),
    stdin: async () => {
      if (process.stdin.isTTY) return null;
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    open: (url) => {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      try {
        spawn(cmd, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      } catch {
        /* the URL is printed anyway */
      }
    },
    env: process.env,
    home: homedir(),
    close: () => rl?.close(),
  };
}
