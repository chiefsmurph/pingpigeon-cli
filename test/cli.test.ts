import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { loginPath } from "../src/api.js";
import { failure, run, type IO } from "../src/cli.js";

interface Hit {
  path: string;
  auth?: string;
  ua?: string;
  body: Record<string, any>;
}

const hits: Hit[] = [];
let server: Server;
let url = "";
let plan = "free";
let emailLimit = false;

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c)).on("end", () => resolve(s));
  });

before(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await read(req)) || "{}");
    hits.push({ path: req.url!, auth: req.headers.authorization, ua: req.headers["user-agent"], body });
    const send = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.url === "/signup") return send(200, { ok: true });
    if (req.url === "/verify-email") {
      return body.code === "123456"
        ? send(200, { ok: true, token: "pp_new", subscriber: { email: body.email, ntfy_topic: "pp-t", phone_verified: false } })
        : send(400, { ok: false, error: "invalid verification code" });
    }
    if (!(req.headers.authorization ?? "").startsWith("Bearer pp_")) return send(401, { ok: false, error: "invalid or missing subscriber token" });
    if (req.url === "/me") {
      return send(200, {
        ok: true,
        subscriber: { email: "me@example.com", plan, phone_verified: false, ntfy_topic: "pp-t" },
        usage: { plan, email: { used: 3, quota: 200 }, pdf: { used: 1, quota: 10 }, sms: { used: 0, quota: 4 } },
        push: { topic: "pp-t", url: "https://ntfy.sh/pp-t" },
      });
    }
    if (req.url === "/email") return emailLimit ? send(429, { ok: false, error: "monthly email limit reached (200 on the free plan) — upgrade for more" }) : send(200, { ok: true, id: "m1" });
    if (req.url === "/push" || req.url === "/text") return send(200, { ok: true, id: "x" });
    if (req.url === "/add-phone") return send(200, { ok: true });
    if (req.url === "/verify-phone") return body.code === "654321" ? send(200, { ok: true }) : send(400, { ok: false, error: "invalid code" });
    if (req.url === "/billing/checkout") return send(200, { ok: true, url: "https://checkout.stripe.test/s1" });
    send(404, { ok: false, error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => {
  hits.length = 0;
  plan = "free";
  emailLimit = false;
});

function harness(opts: { answers?: string[]; stdin?: string | null; signedIn?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pp-"));
  if (opts.signedIn) {
    mkdirSync(join(home, ".pingpigeon"));
    writeFileSync(loginPath(home), JSON.stringify({ url, token: "pp_old", email: "me@example.com", topic: "pp-t" }));
  }
  const answers = [...(opts.answers ?? [])];
  const out: string[] = [];
  const opened: string[] = [];
  const io: IO = {
    ask: async (q) => {
      const a = answers.shift();
      if (a === undefined) throw new Error(`unexpected question: ${q}`);
      return a;
    },
    say: (l) => void out.push(l),
    stdin: async () => opts.stdin ?? null,
    open: (u) => void opened.push(u),
    env: { PINGPIGEON_URL: url },
    home,
  };
  return { io, out, opened, home, text: () => out.join("\n") };
}

const sent = (path: string) => hits.find((h) => h.path === path)!;

test("login: code by email, saved privately, labelled pingpigeon-cli, same file git-drift reads", async () => {
  const h = harness({ answers: ["me@example.com", "111111", "123 456"] });
  assert.equal(await run(["login"], h.io), 0);
  assert.equal(hits.filter((x) => x.path === "/verify-email").length, 2, "a wrong code gets another try");
  assert.equal(hits.at(-1)!.body.client, "pingpigeon-cli");
  assert.match(hits.at(-1)!.ua ?? "", /^pingpigeon-cli\//);
  assert.equal(statSync(loginPath(h.home)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(loginPath(h.home), "utf8")), { url, token: "pp_new", email: "me@example.com", topic: "pp-t", phoneVerified: false });
});

test("login: an existing working sign-in is reused; --token signs in without a code", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["login"], h.io), 0);
  assert.match(h.text(), /Already signed in as me@example.com \(free plan\)/);
  assert.equal(hits.some((x) => x.path === "/signup"), false);
  const t = harness();
  assert.equal(await run(["login", "--token", "pp_web"], t.io), 0);
  assert.equal(JSON.parse(readFileSync(loginPath(t.home), "utf8")).token, "pp_web");
});

test("email: words are the message, the first line is the subject", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["email", "deploy", "finished"], h.io), 0);
  assert.deepEqual(sent("/email").body, { subject: "deploy finished", body: "deploy finished" });
  assert.equal(sent("/email").auth, "Bearer pp_old");
});

test("email: piped stdin, a subject, an attachment and --pdf", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-a-"));
  writeFileSync(join(dir, "log.txt"), "line 1\n");
  const h = harness({ signedIn: true, stdin: "\nFAILED 3 tests\nmore\n" });
  assert.equal(await run(["email", "-a", join(dir, "log.txt"), "--pdf"], h.io), 0);
  const b = sent("/email").body;
  assert.equal(b.subject, "FAILED 3 tests");
  assert.equal(b.attachPdf, true);
  assert.deepEqual(b.attachments, [{ filename: "log.txt", content: Buffer.from("line 1\n").toString("base64") }]);
  const s = harness({ signedIn: true, stdin: "x" });
  await run(["email", "-s", "nightly"], s.io);
  assert.equal(hits.at(-1)!.body.subject, "nightly");
});

test("email: --html sends the file as the html body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-h-"));
  writeFileSync(join(dir, "r.html"), "<b>report</b>");
  const h = harness({ signedIn: true });
  assert.equal(await run(["email", "--html", join(dir, "r.html"), "-s", "report"], h.io), 0);
  assert.deepEqual(sent("/email").body, { subject: "report", html: "<b>report</b>" });
});

test("nothing to send, not signed in, unknown options: usage errors (exit 2)", async () => {
  await assert.rejects(run(["email"], harness({ signedIn: true }).io), (e) => failure(e).code === 2 && /nothing to send/.test(failure(e).message));
  await assert.rejects(run(["push", "hi"], harness().io), (e) => failure(e).code === 2 && /pingpigeon login/.test(failure(e).message));
  await assert.rejects(run(["push", "--pdf", "hi"], harness({ signedIn: true }).io), (e) => failure(e).code === 2);
  assert.equal(await run([], harness().io), 2);
});

test("a plan limit fails with exit 1 and points at upgrade", async () => {
  emailLimit = true;
  await assert.rejects(run(["email", "hi"], harness({ signedIn: true }).io), (e) => {
    const f = failure(e);
    return f.code === 1 && /monthly email limit/.test(f.message) && /→ pingpigeon upgrade/.test(f.message);
  });
});

test("push and text", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["push", "backup", "done", "-t", "nightly", "-p", "4"], h.io), 0);
  assert.deepEqual(sent("/push").body, { message: "backup done", title: "nightly", priority: 4 });
  assert.equal(await run(["text", "server down"], h.io), 0);
  assert.deepEqual(sent("/text").body, { message: "server down" });
});

test("phone: texted code, verified, remembered", async () => {
  const h = harness({ signedIn: true, answers: ["654321"] });
  assert.equal(await run(["phone", "+15551234567"], h.io), 0);
  assert.deepEqual(sent("/add-phone").body, { phone: "+15551234567" });
  assert.equal(JSON.parse(readFileSync(loginPath(h.home), "utf8")).phoneVerified, true);
});

test("status: plan, usage, push topic, the Pro pitch on free", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["status"], h.io), 0);
  assert.match(h.text(), /Signed in as me@example.com \(free plan\)/);
  assert.match(h.text(), /This month: 3\/200 emails · 1\/10 PDFs · 0\/4 text segments/);
  assert.match(h.text(), /ntfy\.sh\/pp-t/);
  assert.match(h.text(), /pingpigeon upgrade/);
  const none = harness();
  assert.equal(await run(["status"], none.io), 1);
  assert.match(none.text(), /Not signed in/);
});

test("upgrade: free opens Stripe checkout; Pro gets the manage link", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["upgrade"], h.io), 0);
  assert.deepEqual(h.opened, ["https://checkout.stripe.test/s1"]);
  plan = "pro";
  const p = harness({ signedIn: true });
  await run(["upgrade"], p.io);
  assert.deepEqual(p.opened, []);
  assert.match(p.text(), /You're on Pro/);
});

test("logout removes the sign-in", async () => {
  const h = harness({ signedIn: true });
  assert.equal(await run(["logout"], h.io), 0);
  assert.equal(existsSync(loginPath(h.home)), false);
});
