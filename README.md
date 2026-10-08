# pingpigeon

**Email, push and text yourself from the terminal.** Pipe a build log, a cron job's result or a report into
your inbox or onto your phone, with no mail server, SMTP password or Twilio account to set up.

```sh
make test 2>&1 | tail -50 | pingpigeon email -s "tests finished"
pingpigeon push "backup done" -t nightly
pingpigeon text "prod is down"
```

This is the command-line client for [PingPigeon](https://pingpigeon.app). Messages only ever go to you: your
verified email address, your verified phone, your private push topic. There's no way to message anyone else,
so a leaked token can't be used to spam people.

## Install

```sh
brew install chiefsmurph/tap/pingpigeon
```

or with npm (Node.js 20+):

```sh
npm install -g pingpigeon        # or run it without installing: npx pingpigeon
```

or as a single file, no Node.js needed (macOS and Linux, arm64 and x86-64):

```sh
curl -fsSL https://raw.githubusercontent.com/chiefsmurph/pingpigeon-cli/main/install.sh | sh
```

## Sign in

```sh
pingpigeon login
```

It asks for your email address and emails you a 6-digit code; type it in and you're done. The same command
signs you in on another machine. The sign-in is saved to `~/.pingpigeon/config.json` (mode 600) and shared
with [git-drift](https://github.com/chiefsmurph/git-drift), which can email you its reports.

Already have an account from pingpigeon.app? `pingpigeon login --token <token>`. In CI or a script, set
`PINGPIGEON_TOKEN` instead of signing in.

## Use

```
pingpigeon email [message]      email yourself (no message: reads stdin)
     -s, --subject <text>          default: the message's first line
     --html <file>                 HTML body
     -a, --attach <file>           attach a file (repeatable)
     --pdf                         also attach the message as a PDF
pingpigeon push [message]       push notification (no message: reads stdin)
     -t, --title <text>  -p, --priority <1-5>
pingpigeon text [message]       text your verified phone
pingpigeon phone <number>       verify your phone for texts
pingpigeon status               plan, this month's usage, your push topic
pingpigeon upgrade              open checkout for Pro
pingpigeon logout               forget the sign-in on this machine
```

Push notifications arrive through the free [ntfy](https://ntfy.sh) app: `pingpigeon status` shows the private
topic to subscribe to. Exit codes: 0 sent, 1 not sent (a plan limit, the network, the server), 2 usage error, so
`pingpigeon email … || echo "didn't send"` works in scripts.

More examples:

```sh
# a nightly job that tells you how it went
0 3 * * * /usr/local/bin/backup.sh 2>&1 | pingpigeon email -s "backup $(date +%F)"

# a long command, then a buzz on your phone
./train.sh; pingpigeon push "training finished: exit $?"

# a report as a PDF
pingpigeon email --pdf -s "weekly numbers" < report.md
```

## Plans

| | Free | Pro |
|---|---|---|
| Emails a month | 200 | 10,000 |
| PDFs a month | 10 | unlimited |
| Text segments a month | 4 (one 160-character text each) | 300 (texts up to 3 segments) |
| Attachments per email | 1, up to 5 MB | 10, up to 20 MB total |
| Push notifications | yes | yes |

`pingpigeon upgrade` opens checkout; `pingpigeon status` shows what you've used. Pricing is on
[pingpigeon.app](https://pingpigeon.app).

PingPigeon also works inside ChatGPT and Claude ("email me this as a PDF"); set that up on
[pingpigeon.app](https://pingpigeon.app).

## License

MIT. This repository is the client only; the PingPigeon service is run by its author.
