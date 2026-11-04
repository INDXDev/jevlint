# Providers

A provider runs the decision model. You configure one at a time. jevlint uses the
[AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/decisions) decision API, plus small adapters for
endpoints that speak the Jev protocol.

```toml
[provider]
name = "typesafe"
model = "jev-latest"   # optional
```

| `name` | Default model | Key variable | Notes |
| --- | --- | --- | --- |
| `typesafe` | `jev-latest` | `TYPESAFE_AI_API_KEY` | Direct Jev access. Early access via waitlist |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` | OpenAI Decisions API |
| `gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | Vercel AI Gateway. Also reaches other decision models |
| `cloudflare` | `clef` | `CLOUDFLARE_API_TOKEN` | Workers AI. `clef-flash` is the faster variant |
| `microsoft` | none, set `model` | `AZURE_API_KEY` | Microsoft Foundry. Requires `base_url` |
| `compatible` | none, set `model` | `JEVLINT_API_KEY` | Any Jev-compatible endpoint. Requires `base_url` |

## Cost estimates

`audit --dry-run` estimates the tokens and cost of a run before it starts. `audit` and `architecture`
show the cost of the tokens a run really used. Pinned, blank and cached files are not counted.

Each request bills the file once plus every active question, so a preset's questions add to every
file. jevlint estimates 4 characters per token, which runs low for non-Latin text. Output is free.

| Model | USD per million input tokens |
| --- | --- |
| `jev-*` on `typesafe`, `typesafe-ai/jev*` on `gateway` | 0.042 |
| `gpt-6-luna` on `openai` | 0.10 |
| Any model on `cloudflare` | 0.24, the price of `clef`, which jevlint always calls |

Prices were checked on 2026-11-05 and are built in, so they can go stale. A run shows tokens with no
cost for any other model, and for `microsoft` and `compatible`. Your provider's bill is the real
figure.

## Fallback

With no key for the configured provider, jevlint uses the first of `typesafe`, `openai`, `gateway`
and `cloudflare` that has one, with that provider's default model, and prints which it used.
`cloudflare` also needs `CLOUDFLARE_ACCOUNT_ID`. `microsoft` and `compatible` need `base_url`, so
they are never a fallback. Run `jevlint audit --dry-run` to see where files would go.

## Test status

Only one provider has been run against its live service so far. Reports from the others are welcome.

| Provider | Status |
| --- | --- |
| `openai` | Tested live |
| `typesafe` | Uses the official AI SDK provider. Not tested live |
| `gateway` | Uses the official AI SDK provider. Not tested live |
| `cloudflare` | Adapter tested against a fake server built from Cloudflare's documented format |
| `compatible` | Shares the `typesafe` code path. Not tested live |
| `microsoft` | Experimental. Not tested live |

## Which should I use?

- **You have Jev access:** `typesafe`.
- **You have no waitlist access:** `gateway` or `cloudflare`, which both offer decision models
  without waiting.
- **You already pay OpenAI:** `openai`.
- **You run LiteLLM or another proxy:** `compatible`.

## Storing keys

jevlint reads keys from `~/.config/jevlint/credentials.toml`. It ignores the provider's environment
variable unless you allow it. The first interactive run of a command that uses a key asks, and
remembers your answer. Once allowed, the environment variable takes priority over the file.

With no terminal, as in CI, nothing asks. An audit with `fail_under` set then stops with exit 2
rather than gate on AST scores alone, until you run `jevlint auth env on` or pass `--ast-only`.

```sh
jevlint auth env on    # or off, to change your answer
```

```sh
jevlint auth set typesafe
jevlint auth list
jevlint auth remove typesafe
```

`auth set` hides your input and creates the file with mode `0600`. For scripts, pipe the key in:

```sh
printf '%s' "$KEY" | jevlint auth set typesafe
```

Do not put keys in `jevlint.toml` or `config.toml`. jevlint rejects an `api_key` field in both.

## Provider setup

### TypeSafe AI (Jev)

Join the waitlist at [typesafe.ai](https://typesafe.ai), then:

```sh
jevlint auth set typesafe
```

Pin a version such as `jev-1.14.0` if you want scores to stay comparable over time. `jev-latest`
moves when new versions ship, which also invalidates your cache.

### OpenAI

```sh
jevlint auth set openai
```

```toml
[provider]
name = "openai"
```

### Vercel AI Gateway

```sh
jevlint auth set gateway
```

```toml
[provider]
name = "gateway"
model = "typesafe-ai/jev"
```

### Cloudflare Workers AI

Create an API token with Workers AI permission, and find your account ID in the dashboard.

```sh
jevlint auth set cloudflare
```

```toml
[provider]
name = "cloudflare"
model = "clef"
account_id = "your-account-id"
```

`CLOUDFLARE_ACCOUNT_ID` also works. Clef is Jev-compatible, and jevlint handles the difference in
Cloudflare's response envelope. Cloudflare allows up to 64 questions per request, so jevlint reports
an error if your active presets exceed that.

### Microsoft Foundry

This provider is **experimental**. Microsoft-Decision-1 is reported to accept the Jev protocol at a
Foundry endpoint, but we have not confirmed this against Microsoft's documentation. Vercel AI
Gateway is the safer route to this model. If you try the direct route, put the endpoint in your user
config and use your deployment name as `model`:

```toml
# ~/.config/jevlint/config.toml
[provider]
name = "microsoft"
model = "your-deployment-name"
base_url = "https://your-resource.services.ai.azure.com/providers/microsoft/v1"
```

### Jev-compatible endpoints

Anything accepting `POST <base_url>/systemone` with the Jev request shape works. A LiteLLM proxy is
one example:

```toml
# ~/.config/jevlint/config.toml
[provider]
name = "compatible"
model = "jev-latest"
base_url = "https://litellm.example.com/typesafe/v1"
```

## Provider differences

- **Score levels:** presets use 2 to 10 levels, which every provider accepts.
- **Refusals:** if a model refuses a question, the whole request fails. jevlint keeps the file's AST
  score and adds a warning.
- **Rate limits:** on a `429`, jevlint retries with backoff. Lower `concurrency` if it persists.
- **Comparability:** scores from different models are not comparable.
