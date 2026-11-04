# messy-shop

A small fictional shop backend that is **bad on purpose**. It exists to give jevlint something to
rank. Do not copy from it, and please do not send pull requests that clean it up.

| File | Quality | What is wrong |
| --- | --- | --- |
| `src/checkout.ts` | Worst | God module, a 100+ line function, deep nesting, magic numbers |
| `src/pricing.py` | Bad | Copy-paste, cryptic names, stale comments |
| `src/inventory.go` | Bad | 7-parameter functions, misleading names, nesting |
| `src/helpers.ts` | Bad | Names that lie, hidden side effects |
| `src/shipping.rs` | Bad | Repeated zone logic, flag parameters, unexplained constants |
| `src/refunds.py` | Middling | Reasonable shape, some vague names and one long function |
| `src/money.ts` | Clean | The contrast: small, named, documented where it matters |

All data is made up, and nothing here needs to run.

## Audit it

From this directory, which has its own `jevlint.toml`:

```sh
jevlint audit
```

For the free local metrics only, or a different lens:

```sh
jevlint audit --ast-only
jevlint audit --preset solid
```

Expect `src/checkout.ts` near the top of the refactor list and `src/money.ts` at the bottom.
