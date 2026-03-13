---
name: businesscentral
description: Interact with Microsoft Dynamics 365 Business Central — authenticate, query entities, create/update/delete records, manage sales orders, invoices, customers, vendors, items, and more via the BC REST API
version: 1.0.0
triggers:
  - business central
  - dynamics 365
  - BC query
  - BC customers
  - BC invoices
  - BC sales orders
  - ERP
---

# Business Central Skill for Claude Code

Interact with Microsoft Dynamics 365 Business Central via the REST API using `bc-cli`.

## Prerequisites

1. **Node.js 18+** installed
2. **bc-cli installed** from this skill's directory:
   ```bash
   # From skill directory
   npm link
   # Or run directly
   node <skill-path>/bin/bc-cli.mjs <command>
   ```

No Azure AD setup needed — a default app registration is included.

**Binary location:** `bc-cli` is at `../../bin/bc-cli.mjs` relative to this SKILL.md file. In Cowork, find it at `<plugin-path>/bin/bc-cli.mjs`.

## Authentication

### Step 1: Check if already authenticated

```bash
bc-cli status
```

If status shows "Active", you're ready — skip to "Operation Safety Levels".

### Step 2: Login

#### Claude Code (local machine — no sandbox)

Just run:

```bash
bc-cli login
```

This will:
1. Open your browser to the Microsoft login page
2. You sign in with your Microsoft/Business Central account
3. Token is saved automatically with auto-refresh
4. Tenant and environment are auto-detected

That's it. No Client ID, no Tenant ID, no environment to configure — everything is automatic.

#### Claude Cowork (sandboxed environment)

**IMPORTANT — Domain allowlist setup (MUST do before anything else):**

The user MUST add these domains to the Cowork network allowlist:
- `*.microsoftonline.com` (Microsoft authentication)
- `*.businesscentral.dynamics.com` (Business Central API)

**How:** In Cowork, go to **Settings > Capabilities > Domain allowlist > Additional allowed domains** and add both domains. Without this, all API calls will fail.

In Cowork, `bc-cli login` cannot open the user's browser because the sandbox is isolated.
Node.js `fetch()` also doesn't work in the sandbox — use `curl` directly for token exchange.

**Step A — Generate the auth URL:**

```bash
bc-cli login-url --port=33333
```

This outputs JSON with `authorizeUrl`, `verifier`, and `redirectUri`. Save the `verifier` — you'll need it in Step C.

**Step B — Ask the user to authenticate:**

Tell the user:
1. Open the `authorizeUrl` link in their browser
2. Sign in with their Microsoft account
3. After login, the browser will redirect to `http://localhost:33333/?code=...&state=...`
4. **This page will NOT load** (it's the sandbox's localhost, not theirs) — that's expected
5. Copy the **full URL** from the browser address bar and paste it back in the chat

**Step C — Exchange the code and save the token (ONE command):**

Use `login-exchange` which does the code exchange + token save atomically:

```bash
bc-cli login-exchange --code="<PASTED_URL_OR_CODE>" --verifier=<VERIFIER_FROM_STEP_A> --environment=<EXACT_ENV_NAME>
```

**CRITICAL RULES:**
- The authorization code is SINGLE USE. `login-exchange` handles everything in one call.
- NEVER try to exchange the code twice — it's consumed after the first exchange.
- Use the EXACT environment name from the user (e.g. "prod", NOT "production").

**Complete Cowork example (3 calls total):**

```bash
# 1. Generate auth URL
bc-cli login-url --port=33333
# Output: { "authorizeUrl": "https://login.microsoftonline.com/...", "verifier": "abc123...", ... }

# 2. Show the authorizeUrl to the user, ask them to login and paste back the redirect URL
# User pastes: http://localhost:33333/?code=1.ATsAd...&state=xyz

# 3. Exchange code + save token in one atomic call
bc-cli login-exchange --code="http://localhost:33333/?code=1.ATsAd...&state=xyz" --verifier=abc123... --environment=prod

# Done! Try: bc-cli test
```

**Fallback** — if `login-exchange` hangs (fetch timeout in sandbox), use the curl + save-token approach:

```bash
CODE=$(echo "<PASTED_URL>" | sed 's/.*code=\([^&]*\).*/\1/') && \
curl -s -X POST "https://login.microsoftonline.com/common/oauth2/v2.0/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=0bac98ef-7d93-4eae-85af-2dc429a4e6ef" \
  -d "grant_type=authorization_code" \
  -d "code=$CODE" \
  -d "redirect_uri=http://localhost:33333" \
  -d "code_verifier=<VERIFIER>" \
  -d "scope=https://api.businesscentral.dynamics.com/Financials.ReadWrite.All offline_access" \
  -o /tmp/bc-token.json && \
bc-cli save-token --file=/tmp/bc-token.json --environment=<ENV>
```

### Optional: Specify environment or tenant

If auto-detection picks the wrong environment, override it:

```bash
bc-cli login --environment=sandbox
bc-cli login --tenant=<YOUR_TENANT_ID>
```

### Check status / manage auth

```bash
bc-cli status   # Show config and token status
bc-cli test     # Test connection and list companies
bc-cli logout   # Clear saved tokens
```

## Environment Name Rule

**CRITICAL:** Always use the EXACT environment name the user provides. Environment names in Business Central are custom and case-sensitive.
- If the user says "prod" → use `prod`, NOT `production`
- If the user says "sandbox" → use `sandbox`
- If the user says "test" → use `test`
- NEVER translate, guess, or normalize environment names. Use them verbatim.

## Operation Safety Levels

### 🟢 READ Operations — Execute Freely

These operations are safe and read-only. Execute without asking for confirmation.

#### List Companies
```bash
bc-cli test
# or
bc-cli raw GET /companies
```

#### Query Entities

Use `--top`, `--orderby`, `--select`, `--filter`, `--expand` flags (recommended — handles encoding automatically):

```bash
# List customers (first page)
bc-cli query <companyId> customers

# Top N with specific fields
bc-cli query <companyId> customers --top=10 --select=displayName,email,phoneNumber

# Order and limit
bc-cli query <companyId> salesInvoices --top=5 --orderby="invoiceDate desc" --select=number,invoiceDate,customerName,totalAmountIncludingTax,status

# Filter
bc-cli query <companyId> salesInvoices --filter="status eq 'Open'" --top=10

# Expand related entities
bc-cli query <companyId> salesOrders --expand=salesOrderLines --top=5

# Fetch ALL pages (auto-pagination)
bc-cli query <companyId> customers --select=displayName --all

# Raw OData params also still work (legacy)
bc-cli query <companyId> customers '$top=10&$select=displayName,email'
```

#### Get Single Record
```bash
bc-cli get <companyId> customers <customerId>
bc-cli get <companyId> salesInvoices <invoiceId>
bc-cli get <companyId> items <itemId>
```

#### Common Entities for Queries

| Entity | Endpoint | Description |
|--------|----------|-------------|
| `customers` | Customers | Customer records |
| `vendors` | Vendors | Vendor/supplier records |
| `items` | Items | Product/service catalog |
| `salesOrders` | Sales Orders | Sales order headers |
| `salesInvoices` | Sales Invoices | Posted sales invoices |
| `salesQuotes` | Sales Quotes | Sales quotes |
| `salesCreditMemos` | Sales Credit Memos | Credit memo documents |
| `purchaseOrders` | Purchase Orders | Purchase order headers |
| `purchaseInvoices` | Purchase Invoices | Posted purchase invoices |
| `generalLedgerEntries` | GL Entries | General ledger entries (read-only) |
| `accounts` | Chart of Accounts | GL accounts |
| `journals` | Journals | General journals |
| `employees` | Employees | Employee records |
| `bankAccounts` | Bank Accounts | Bank account records |
| `paymentTerms` | Payment Terms | Payment term definitions |
| `currencies` | Currencies | Currency definitions |
| `countriesRegions` | Countries/Regions | Country/region codes |
| `dimensions` | Dimensions | Dimension definitions |
| `taxGroups` | Tax Groups | Tax group definitions |

#### OData Query Reference

| Parameter | Example | Purpose |
|-----------|---------|---------|
| `$filter` | `$filter=displayName eq 'Contoso'` | Filter results |
| `$select` | `$select=id,displayName` | Return specific fields |
| `$expand` | `$expand=salesOrderLines` | Include related entities |
| `$top` | `$top=50` | Limit result count |
| `$orderby` | `$orderby=displayName asc` | Sort results |
| `$count` | `$count=true` | Include total count |

**Filter operators:** `eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`, `contains()`, `startswith()`, `endswith()`

#### Raw API Calls
```bash
# Any GET request
bc-cli raw GET '/companies(<companyId>)/customers?$top=5'

# Check API metadata
bc-cli raw GET '/companies'
```

### 🟡 WRITE Operations — Confirm with User First

⚠️ **ALWAYS confirm with the user before executing write operations.**

Display this before ANY write operation:
```
⚠️ WRITE OPERATION
Action: [CREATE/UPDATE]
Entity: [entity name]
Company: [company name/ID]
Data: [summary of data being written]

Proceed? (yes/no)
```

#### Create Record
```bash
# Create a customer
bc-cli create <companyId> customers '{"displayName": "New Customer Inc.", "email": "contact@newcustomer.com"}'

# Create an item
bc-cli create <companyId> items '{"number": "ITEM-001", "displayName": "Widget", "unitPrice": 29.99}'

# Create a sales order
bc-cli create <companyId> salesOrders '{"customerNumber": "C00010", "orderDate": "2024-06-15"}'
```

#### Update Record
```bash
# Update customer email
bc-cli update <companyId> customers <customerId> '{"email": "newemail@example.com"}'

# Update with ETag (optimistic concurrency)
bc-cli update <companyId> customers <customerId> '{"email": "new@example.com"}' --etag='W/"JzQ0Oz..."'

# Update item price
bc-cli update <companyId> items <itemId> '{"unitPrice": 39.99}'
```

### 🔴 DELETE Operations — Explicit Confirmation Required

⚠️⚠️ **ALWAYS require explicit user confirmation before ANY delete operation.**

Display this warning:
```
🔴 DELETE OPERATION
Entity: [entity name]
Record ID: [id]
Company: [company name/ID]

This action CANNOT be undone. Type "DELETE" to confirm.
```

**DO NOT proceed unless the user explicitly types "DELETE" or clearly confirms.**

```bash
# Delete a record
bc-cli delete <companyId> customers <customerId>

# Delete with ETag
bc-cli delete <companyId> customers <customerId> --etag='W/"JzQ0Oz..."'
```

### Safety Bypass

For automation/scripting contexts, set:
```bash
export BC_SKIP_WARNINGS=true
```

## Common Workflows

### 1. Initial Setup
```bash
# Login (opens browser, auto-detects tenant + environment)
bc-cli login
# List companies to get company ID
bc-cli test
# Query data
bc-cli query <companyId> customers '$top=5'
```

### 2. Sales Pipeline Review
```bash
# Open sales orders
bc-cli query <companyId> salesOrders '$filter=status eq '\''Open'\'''

# Open sales invoices above threshold
bc-cli query <companyId> salesInvoices '$filter=status eq '\''Open'\'' and totalAmountIncludingTax gt 10000'

# Recent quotes
bc-cli query <companyId> salesQuotes '$orderby=documentDate desc&$top=10'
```

### 3. Inventory Check
```bash
# All items with inventory
bc-cli query <companyId> items '$select=number,displayName,inventory,unitPrice&$filter=inventory gt 0'

# Low stock items
bc-cli query <companyId> items '$filter=inventory lt 10 and inventory gt 0'
```

### 4. Financial Overview
```bash
# GL entries for a period
bc-cli query <companyId> generalLedgerEntries '$filter=postingDate ge 2024-01-01 and postingDate le 2024-03-31' --all

# Chart of accounts
bc-cli query <companyId> accounts '$select=number,displayName,category,subCategory'

# Journal entries
bc-cli query <companyId> journals
```

### 5. Vendor Management
```bash
# All vendors
bc-cli query <companyId> vendors '$select=number,displayName,email,phoneNumber'

# Purchase orders from a vendor
bc-cli query <companyId> purchaseOrders '$filter=vendorNumber eq '\''V00010'\'''
```

## Using with Python (Advanced)

For complex operations, use Python with the saved token:

```python
import json
import subprocess

def get_bc_credentials():
    """Get credentials from bc-cli config."""
    with open(os.path.expanduser("~/.config/bc-cli/tokens.json")) as f:
        tokens = json.load(f)
    with open(os.path.expanduser("~/.config/bc-cli/config.json")) as f:
        config = json.load(f)
    return {
        "access_token": tokens["access_token"],
        "tenant": config.get("tenant", ""),
        "environment": config.get("environment", "production"),
    }

def bc_api_get(path, creds):
    """Make a GET request to BC API."""
    import urllib.request
    tenant = creds["tenant"]
    env = creds["environment"]
    base = f"https://api.businesscentral.dynamics.com/v2.0/{tenant}/{env}/api/v2.0"
    url = f"{base}{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {creds['access_token']}",
        "Accept": "application/json",
        "Data-Access-Intent": "ReadOnly",
    })
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())
```

## Troubleshooting

| Error | Solution |
|-------|----------|
| `AADSTS700016: Application not found` | Default app ID may be blocked by tenant — use `bc-cli login --client-id=<YOUR_ID>` with your own Azure AD app |
| `AADSTS50076: MFA required` | Complete MFA in the browser window that opens |
| `AADSTS65001: User hasn't consented` | Admin must grant consent in Azure portal |
| `401 Unauthorized` | Token expired — run `bc-cli login` again |
| `403 Forbidden` | User lacks BC permissions — check license and roles |
| `404 Not Found` | Wrong environment name or company ID |
| `429 Too Many Requests` | Rate limited — wait and retry |
| `No companies found` | Check environment name (production/sandbox) |
| Token refresh fails | Run `bc-cli logout` then `bc-cli login` |

## Rate Limits

| Limit | Value |
|-------|-------|
| API requests per 5 min (per user) | 6,000 |
| Concurrent requests | 5 |
| Max page size | 20,000 entities |
| Request timeout | 8 minutes |

## Network Requirements

For Cowork/restricted environments, allow these domains:
- `*.businesscentral.dynamics.com`
- `login.microsoftonline.com`
- `graph.microsoft.com` (if using Graph API features)
