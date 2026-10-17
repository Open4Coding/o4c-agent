# MCP servers

o4c can use tools from [MCP](https://modelcontextprotocol.io) servers. In MCP's terms o4c is a
*host* running one *client* per *server*, and **there is no separate "plugin" mechanism** — a local
plugin, a desktop application like Blender, and a remote search service are all just servers, and
their differences live in config.

Nothing here is on by default. With no config file, o4c behaves exactly as it does today.

## Where the config lives

Three files, same cascade as the rest of o4c's config (see `configStore.ts`):

| File | Scope | Commit it? |
|---|---|---|
| `~/.o4c/mcp/config.json` | your machine, every project | n/a |
| `<project>/.o4c/mcp/config.json` | this project, shared | yes, if the team wants the server |
| `<project>/.o4c/mcp/config.local.json` | this project, just you | no — always gitignored |

The three are **deep-merged**, narrower winning, so the override is finer-grained than
whole-file:

- Per server key — a project can add `myplugin` without disturbing your global `blender`.
- Per field, and per grant — if global sets `grants.autoApprove` and the project sets
  `grants.slashCommands`, the server ends up with both.
- **Arrays replace wholesale.** A narrower scope's `args` does not append to a wider one's; it
  substitutes it entirely.

**Project files are only read in a trusted project.** An MCP entry is not a preference — it is a
command line o4c will execute — so in a project you have not trusted, only the global file is used.

## The shape

```json
{
  "servers": {
    "myplugin": {
      "transport": "stdio",
      "command": "node",
      "args": ["./tools/my-mcp-server.js"],
      "env": { "MY_TOKEN": "..." },
      "cwd": "./tools",
      "enabled": true,
      "grants": { "autoApprove": true }
    },
    "blender": {
      "transport": "http",
      "url": "http://127.0.0.1:9876/mcp"
    }
  }
}
```

### Fields

- **`transport`** — required, `"stdio"` or `"http"`. This is the only lifecycle control, because
  the spec gives no choice: in stdio "the client launches the MCP server as a subprocess", so
  `stdio` means **o4c starts and owns the process**. `http` means o4c **attaches** to something
  already running, which is what you want for an application you already have open — o4c must not
  launch and own your Blender.
- **`command`**, **`args`**, **`env`**, **`cwd`** — stdio only.
  - **A spawned server does not inherit your whole environment.** The MCP SDK passes only a fixed
    safe-to-inherit list — on Windows `PATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `USERPROFILE`,
    `SYSTEMROOT` and a few more; on macOS/Linux `HOME`, `PATH`, `SHELL`, `TERM`, `USER`, `LOGNAME`.
    So `PATH` works and `export MY_TOKEN=...` in your shell **does not reach the server**. Anything
    else it needs must be listed in `env`, which is applied on top of that list.
  - **`cwd` is resolved relative to wherever you launched `o4c`**, not to the project root or the
    config file. An absolute path is the safe choice.
- **`url`** — http only, the endpoint o4c POSTs to.
- **`enabled`** — optional, defaults to `true`. `false` keeps the entry without starting it, which
  is easier to reverse than deleting it.
- **`grants`** — optional. See below. Every grant defaults to **false**.

### Server ids

The key under `servers` is the id. It must match `^[a-z0-9][a-z0-9_-]*$` and must not contain `__`,
because the id is both a segment of the tool name (`mcp__<id>__<tool>`) and a directory name. A bad
id is reported and skipped; the other servers still start.

## Grants

A server gets nothing it was not explicitly given.

| Grant | What it allows |
|---|---|
| `autoApprove` | This server's tools run without a confirmation prompt in modes that would otherwise ask. It can only turn a *confirm* into an *allow* — **never** a *deny*, so Plan mode still refuses mutating tools. Intended for a local plugin you own, not for a server reached over the network. |
| `slashCommands` | This server's **prompts** become `/mcp-<server>-<prompt>` commands. Tools are not affected: in MCP, tools are model-invoked and prompts are the user-invoked primitive. |
| `trustReadOnlyHints` | Lets the server's own `readOnlyHint` annotation mark a tool as non-mutating. **Off for a reason** — the spec says annotations "should not be relied upon for security decisions", and a non-mutating tool runs with no confirmation in every mode. Turning this on trusts the server about itself. |
| `resources` | Reserved. Parsed and validated, but **nothing consumes it yet** — see "Not built yet" below. |

## Using it

- **`/mcp`** lists every configured server, its state, its tool count, and its commands. It is the
  first place to look when a tool you expected is missing.
- Tools appear to the model as **`mcp__<server>__<tool>`**. The namespace is not cosmetic: o4c
  auto-approves some built-in tools by name, and a third-party `write_file` must not inherit that.
- **Every MCP tool is treated as mutating** unless you grant `trustReadOnlyHints`, so it goes
  through the normal confirmation. The dialog names the server, says whether the call leaves this
  machine and where to, and shows the server's own annotations labelled as its unverified claim.
- With `slashCommands`, a prompt **expands into your input box** rather than being sent. Server
  text is never auto-submitted and never re-read as a command.

## Startup behaviour

o4c does not wait for MCP. The UI appears immediately and tools arrive when they arrive; if you
type faster than a server connects, the first turn waits for it. A server that fails to start, dies,
or returns nonsense costs **only its own tools** — you get a notice naming it and the reason, and
the session stays usable.

## Secure mode

With `"secureMode": true` in o4c's main `config.json`, o4c refuses anything that would send data off
this network — a server whose URL is on the public internet, and any cloud model provider.

- Permitted: spawned servers, loopback (`127.0.0.1`, `localhost`), and private/LAN addresses
  (`10.x`, `172.16–31.x`, `192.168.x`, IPv6 ULA, `*.local`).
- Refused: public addresses, and **carrier-grade NAT (`100.64/10`, which is also Tailscale's
  range)** — those packets cross the internet, encrypted but off-site.
- **Give a LAN host as an IP address, not a name.** A bare hostname is treated as public, because
  checking it would mean a DNS lookup while reading config.
- `secureMode` is a **ratchet**: any config scope can turn it on, none can turn it off. A project
  you cloned must not be able to switch off your machine's egress boundary.

What it cannot promise: it controls *o4c's* egress. A permitted local server is free to call the
internet itself, and no config inspection can see that.

## Not built yet

- **`grants.resources`.** The intent is a namespaced config/data/log area per server
  (`.o4c/plugins/<id>/`, `.o4c/data/<id>/`). The grant is parsed and validated and nothing reads
  it. It was originally motivated by o4c's own infinite-context store, which is now built as
  in-process core code rather than as a server, so this is waiting for a real third-party need
  rather than being almost-finished.
- **o4c as an MCP server.** o4c is a client only. Exposing o4c's own tools over MCP is deferred
  until something consumes them.

## Troubleshooting

| Symptom | Cause |
|---|---|
| A server is missing from `/mcp` | Its entry was rejected. The reason is in the startup notices. |
| `/mcp` says `blocked` | Secure mode refused it — the detail says why. |
| The model says a tool does not exist | Check `/mcp` for the server's state; a failed server's tools are genuinely absent. |
| No `/mcp-*` commands | `grants.slashCommands` is off, or the server exposes no prompts. `/mcp` distinguishes these. |
| Tools work but prompts fail | A server may implement tools and not prompts; a prompt-listing failure is reported and leaves the tools working. |
