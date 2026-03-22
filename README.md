# N8n Auto Invoice (NAI) 🧾🤖

N8n Auto Invoice is a robust, Dockerized microservice designed to automate the extraction and modification of invoices from complex, heavily bot-protected environments like OpenAI (ChatGPT). 

It specifically integrates with **n8n** to trigger automated billing workflows.

---

## 🎯 Core Features

- **Multi-Engine Scraping:** Uses both **CloakBrowser** (Primary) and **Playwright Stealth** + **FlareSolverr** (Fallback) to bypass Cloudflare Turnstile and strict bot detections.
- **Full Authentication Flow:** Manages email/password login and 2FA (TOTP) generation dynamically.
- **Dynamic PDF Editing:** Automatically edits downloaded PDF invoices/receipts using `pdf-lib` to append corporate declaration texts and authorized signatures.
- **Stateless & Queue-Based:** Uses a single-threaded queue to prevent Chrome instance overlaps, ensuring stable performance across multiple N8n parallel triggers.
- **Dockerized & Unified:** Runs the Node API, Playwright, and CloakBrowser within a single lightweight `node:20-slim` container, communicating flawlessly with FlareSolverr.

---

## 🏗️ Architecture

The project consists of two main Docker containers:
1. `n8n-auto-invoice-worker`: The main Node.js server exposing the webhook on `:3000`. Runs both CloakBrowser and Playwright.
2. `n8n-auto-invoice-flaresolverr`: The proxy server handling Cloudflare clearance cookies.

---

## 🚀 Installation & Setup

### 1. Requirements
- Docker & Docker Compose
- (Optional but recommended) N8n instance to trigger the webhooks.

### 2. Configuration
Create a `.env` file in the root directory (you can use `.env.example` as a template):

```env
# Server Config
PORT=3000
HOST=0.0.0.0

# PDF Default Modifications
PDF_SIGNATURE_TEXT="Your Name"
PDF_DECLARATION_TEXT="Custom declaration text for accounting..."

# Target Invoice Logic
OPENAI_TARGET_INVOICE=son # or 'bir onceki'

# Engine Timeouts
PAGE_TIMEOUT=30000
ELEMENT_TIMEOUT=15000

# FlareSolverr Connect
FLARESOLVERR_URL=http://n8n-auto-invoice-flaresolverr:8191/v1
```

### 3. Build & Run
```bash
docker compose up -d --build
```
This will spin up both the worker and flaresolverr containers. The API will be available at `http://localhost:3000`.

---

## 📡 API Endpoints 

### POST `/trigger-invoice`
Triggers the headless browser to login and download the target invoice from OpenAI.

**Payload (Optional, defaults to .env if empty):**
```json
{
  "email": "user@domain.com",
  "password": "securepassword123",
  "totpSecret": "JBSWY3DPEHPK3PXP",
  "targetInvoice": "son"
}
```

### POST `/edit-pdf`
Modifies an existing PDF file stored in the container's volume.

**Payload:**
```json
{
  "invoiceFileName": "user_domain_com_fatura_22-03-2026.pdf",
  "declarationText": "Custom text here",
  "signatureText": "Manager Name"
}
```

---

## 📂 Project Structure
```text
n8n-auto-invoice/
├── Dockerfile             # Unified Node:20-slim image build instructions
├── docker-compose.yml     # Service orchestration (Worker + FlareSolverr)
├── package.json           # Unified NPM dependencies
├── data/
│   ├── server.js          # Main HTTP Webhook & Queue Manager
│   ├── main.js            # Playwright + FlareSolverr Logic (Fallback)
│   └── main-cloak.mjs     # CloakBrowser Logic (Primary)
├── .env.example           # Environment template
└── .gitignore            
```

---

### Author
[fklnc94](https://github.com/fklnc94) - Created for automated billing architectures.
