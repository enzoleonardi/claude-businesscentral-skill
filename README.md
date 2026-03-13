# Business Central Skill for Claude Code & Cowork

Claude Code and Cowork skill for Microsoft Dynamics 365 Business Central — authenticate, query, create, update, and delete entities via the BC REST API.

## Install

From Claude Code or Cowork:

```
/install enzoleonardi/claude-businesscentral-skill
```

That's it. Claude will handle authentication and API calls automatically when you ask about Business Central.

## What it does

Once installed, you can ask Claude things like:

- "List my Business Central companies"
- "Show the last 10 sales invoices"
- "Create a draft invoice for customer C00010"
- "Query open purchase orders above 10,000 EUR"

The skill provides:

- **Browser-based OAuth login** — no credentials to configure, just sign in with your Microsoft account
- **Auto token refresh** — long-lived sessions without re-authentication
- **Full CRUD** — create, read, update, delete any BC entity
- **OData queries** — filter, select, expand, sort, paginate with convenience flags
- **Safety levels** — reads execute freely, writes require confirmation, deletes require explicit approval
- **Cowork compatible** — manual auth flow for sandboxed environments

## Cowork setup

Before using in Cowork, add these domains to your allowlist:

**Settings > Capabilities > Domain allowlist > Additional allowed domains:**
- `*.microsoftonline.com`
- `*.businesscentral.dynamics.com`

## Advanced: Custom Azure AD app

A default app registration is included — most users don't need to configure anything. If your organization requires a custom app:

1. Go to [Microsoft Entra admin center](https://entra.microsoft.com) > App registrations
2. Create new registration (Multitenant)
3. Add permission: Dynamics 365 Business Central > `Financials.ReadWrite.All` (Delegated)
4. Enable "Allow public client flows" in Authentication settings
5. Use: `bc-cli login --client-id=<YOUR_CLIENT_ID>`

## CLI reference

The skill includes `bc-cli`, a lightweight CLI used by Claude under the hood:

| Command | Description |
|---------|-------------|
| `bc-cli login` | Browser-based OAuth login |
| `bc-cli login-exchange` | Atomic code exchange for Cowork |
| `bc-cli status` | Show auth status and config |
| `bc-cli test` | Test connection and list companies |
| `bc-cli query` | Query entities (`--top`, `--select`, `--filter`, `--orderby`, `--expand`) |
| `bc-cli get` | Get single record by ID |
| `bc-cli create` | Create a new record |
| `bc-cli update` | Update an existing record |
| `bc-cli delete` | Delete a record |
| `bc-cli raw` | Raw API request |
| `bc-cli logout` | Clear saved tokens |

## License

MIT
