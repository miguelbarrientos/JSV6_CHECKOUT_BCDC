# Solution Design Document — PayPal Checkout + BCDC Integration with PayPal JavaScript SDK v6 (server-side architecture)

| Metadata | Value |
|----------|-------|
| **Document type** | Solution Design Document (SDD) |
| **Solution** | Web checkout payment processing using PayPal Checkout, PayLater, PayPal Credit, and Branded Card-Direct Checkout (BCDC) via the PayPal JavaScript SDK v6 with a server-side architecture |
| **Technical components** | PayPal Web SDK v6 (`web-sdk/v6/core`) · `paypal-payments` · `paypal-guest-payments` · One-Time Payment Sessions (PayPal, PayLater, PayPal Credit, Guest) · Risk Transaction Contexts (STC) · Backend-for-Frontend (BFF) |
| **Functional capabilities** | Pay with PayPal account (One-Time) · Pay with PayLater · Pay with PayPal Credit · Pay with credit/debit card as guest (BCDC) · Server-side risk pre-evaluation (STC) · Per-operation idempotency (`createRequestId`, `captureRequestId`) · Risk correlation via `PayPal-Client-Metadata-Id` |
| **REST APIs involved** | `/v1/oauth2/token`, `/v2/checkout/orders`, `/v2/checkout/orders/{id}`, `/v2/checkout/orders/{id}/capture`, `/v1/risk/transaction-contexts/{merchant_id}/{cmid}` |
| **Conventions** | REST → `snake_case` · JavaScript SDK v6 → `camelCase` |
| **Audience** | Solution Architecture, Integration Engineering, Product, e-commerce, Risk, and Compliance teams of the merchant implementing the integration in production |

---

## Table of contents

### Part I — Solution context
1. [Executive summary](#1-executive-summary)
2. [Business context and drivers](#2-business-context-and-drivers)
3. [Solution scope](#3-solution-scope)
4. [Stakeholders and audience](#4-stakeholders-and-audience)
5. [Glossary of terms and acronyms](#5-glossary-of-terms-and-acronyms)

### Part II — Solution definition
6. [Solution overview](#6-solution-overview)
7. [Functional requirements](#7-functional-requirements)
8. [Non-functional requirements](#8-non-functional-requirements)
9. [Solution architecture](#9-solution-architecture)
10. [Prerequisites and environment configuration](#10-prerequisites-and-environment-configuration)

### Part III — Detailed design
11. [OAuth2 authentication (client_credentials)](#11-oauth2-authentication-client_credentials)
12. [Client Metadata ID (CMID) generation](#12-client-metadata-id-cmid-generation)
13. [Set Transaction Context (STC)](#13-set-transaction-context-stc)
14. [Loading the PayPal Web SDK v6](#14-loading-the-paypal-web-sdk-v6)
15. [SDK initialization and eligible-method discovery](#15-sdk-initialization-and-eligible-method-discovery)
16. [HTML structure and session activation pattern](#16-html-structure-and-session-activation-pattern)
17. [PayPal Checkout session (PayPal account)](#17-paypal-checkout-session-paypal-account)
18. [PayLater session](#18-paylater-session)
19. [PayPal Credit session](#19-paypal-credit-session)
20. [BCDC session — Guest Card Checkout](#20-bcdc-session--guest-card-checkout)
21. [Order creation and capture](#21-order-creation-and-capture)

### Part IV — Integration and operations
22. [End-to-end orchestration](#22-end-to-end-orchestration)
23. [Integration points (endpoint map)](#23-integration-points-endpoint-map)
24. [Security considerations](#24-security-considerations)
25. [Operational considerations](#25-operational-considerations)

### Part V — Validation and governance
26. [Testing strategy and Sandbox environment](#26-testing-strategy-and-sandbox-environment)
27. [REST vs SDK naming conventions](#27-rest-vs-sdk-naming-conventions)
28. [Assumptions, dependencies, and constraints](#28-assumptions-dependencies-and-constraints)
29. [Risks and mitigations](#29-risks-and-mitigations)
30. [Acceptance criteria and pre-production checklist](#30-acceptance-criteria-and-pre-production-checklist)

### Appendices
- [Appendix A — Common errors troubleshooting](#appendix-a--common-errors-troubleshooting)
- [Appendix B — Limitations and future work](#appendix-b--limitations-and-future-work)

---

# Part I — Solution context

## 1. Executive summary

This Solution Design Document defines the integration of **PayPal Checkout + Branded Card-Direct Checkout (BCDC)** on the **PayPal JavaScript SDK v6** (`web-sdk/v6/core`) within a web checkout experience, using a **server-side architecture**. The solution enables four payment methods under a single SDK and a single session-activation pattern:

- **PayPal** — payment with the buyer's PayPal account.
- **PayLater** — installment payments financed by PayPal in eligible markets.
- **PayPal Credit** — PayPal credit line in eligible markets.
- **BCDC** — credit or debit card payment as a guest (no PayPal account), with the capture UI hosted by PayPal.

The architecture follows the **Backend-for-Frontend (BFF)** pattern: the buyer's browser interacts with the PayPal SDK and with the merchant's private backend, and the latter is the only component authorized to talk to the PayPal REST API. `client_secret` and `merchant_id` remain on the backend; the frontend only receives the public `client_id`.

The solution targets merchants that require:

- **Broad payment method coverage** with a single SDK and minimal maintenance surface.
- **Sensitive credential isolation** on the backend, removing `client_secret` from the browser.
- **Optimized conversion** through a *transient activation*-based session activation pattern that prevents pop-up blocking by modern browsers.
- **Traceability and risk correlation** via a Client Metadata ID (CMID) consistent across frontend, backend, STC, and Create/Capture Order headers.
- **Transactional idempotency** via per-operation `PayPal-Request-Id` keys (`createRequestId`, `captureRequestId`) for safe retries against network failures.

This document describes the end-to-end solution: business context, requirements, architecture, detailed design per component, orchestration, security, operations, testing, risks, and acceptance criteria.

---

## 2. Business context and drivers

### 2.1 Business drivers

| Driver | Description |
|--------|-------------|
| **Payment method coverage with a single SDK** | The v6 SDK exposes PayPal, PayLater, PayPal Credit, and BCDC under a single instance (`createInstance`) and a homogeneous session API (`createPayPalOneTimePaymentSession`, `createPayLaterOneTimePaymentSession`, `createPayPalCreditOneTimePaymentSession`, `createPayPalGuestOneTimePaymentSession`). This reduces maintenance cost compared with integrating each method separately. |
| **Conversion and user experience** | The *transient activation*-based activation pattern preserves the user gesture that triggers the session, allowing PayPal to open its pop-up or full-page modal without browser blocking. |
| **Reduced friction for guest buyers** | BCDC enables credit/debit card payments without forcing the buyer to create a PayPal account. The capture UI is hosted by PayPal: the merchant only renders a button. |
| **Credential isolation** | The server-side architecture moves `client_secret` and `merchant_id` out of the browser, eliminating the "secret leaked in HTML" incident category typical of legacy integrations. |
| **Financing methods with no extra code** | PayLater and PayPal Credit are exposed via APIs symmetric to PayPal Checkout's. Per-market eligibility is discovered via `findEligibleMethods`, with no manual configuration required from the merchant. |

### 2.2 Regulatory and compliance drivers

| Driver | Description |
|--------|-------------|
| **PCI DSS** | Across all flows covered by this SDD, the merchant **does not process, transmit, or store buyer cardholder data**: PayPal/PayLater/Credit do not involve card data from the merchant's perspective, and in BCDC capture happens entirely in the PayPal-hosted UI. This allows the scope to remain under the simplified **SAQ A** questionnaire. |
| **Secret custody (merchant internal standards and local regulations)** | `client_secret` resides exclusively on the backend, managed by a secrets manager. This eases compliance with internal credential-handling policies and reduces audit scope. |
| **Local regulations for PayLater / Credit** | The presentation of financing to the buyer (legal text, rates, conditions) is subject to local regulations. The PayLater/Credit flow UI is hosted by PayPal and meets the requirements of the market in which the SDK detects eligibility. |

---

## 3. Solution scope

### 3.1 In-scope capabilities

| Capability | Description |
|-----------|-------------|
| **Pay with PayPal account (One-Time)** | Charge against the buyer's PayPal account via `createPayPalOneTimePaymentSession`. |
| **Pay with PayLater** | PayPal-financed installments via `createPayLaterOneTimePaymentSession`. Per-market and per-product eligibility is discovered via `findEligibleMethods` and `paymentMethods.getDetails('paylater')`. |
| **Pay with PayPal Credit** | PayPal credit line via `createPayPalCreditOneTimePaymentSession` in eligible markets. |
| **BCDC — Guest Card Checkout** | Credit/debit card payment as a guest via `createPayPalGuestOneTimePaymentSession`. The capture UI is hosted by PayPal; the merchant mounts the custom elements `<paypal-basic-card-container>` + `<paypal-basic-card-button>` and attaches the click listener on the button. |
| **Activation pattern with *transient activation*** | Building the Create Order promise **without `await`** inside the click handler, to preserve the user gesture and avoid pop-up blocking. |
| **Set Transaction Context (STC)** | Sending buyer context to the PayPal risk engine **before each Create Order**. **Non-blocking** operation. |
| **Transactional idempotency** | Safe retries via per-operation `PayPal-Request-Id` keys (`createRequestId` for Create, `captureRequestId` for Capture), persisted server-side. |
| **Post-approval capture** | Payment capture in `onApprove` via `POST /v2/checkout/orders/{id}/capture`. |
| **Enriched post-capture lookup** | `GET /v2/checkout/orders/{id}` to obtain enriched `payment_source`, capture identifiers, and reconciliation data. |

### 3.2 Out-of-scope capabilities

| Category | Detail |
|-----------|---------|
| **Advanced card capabilities** | Card capture in merchant-owned iframes, explicit control of strong customer authentication and its result, installment payments, and card reuse across sessions are out of scope for this integration. |
| **Additional risk telemetry** | The v6 SDK automatically injects the required telemetry; the merchant does not integrate additional scripts. |
| **Back-office operations** | Webhooks, refunds, settlement, disputes, and financial reconciliation are out of scope. They require a complementary SDD. |
| **Other payment methods** | Local APMs (regional wallets, transfers) and recurring subscriptions can be integrated with the same v6 SDK in complementary solutions. |
| **Capture modes other than `CAPTURE`** | `AUTHORIZE` with deferred capture is out of scope. |

---

## 4. Stakeholders and audience

| Role | Responsibility regarding this SDD |
|-----|-----------------------------------|
| **Solution Architect** | Validates the architecture, ensures consistency with the merchant's portfolio, and approves the document. |
| **Product Manager (e-commerce)** | Validates that the functional scope covers business requirements: payment method coverage, target markets, and checkout experience. |
| **Integration Engineer (PayPal)** | Supports the merchant during implementation, validates commercial configurations (PayLater/Credit, BCDC, STC enablement), and assists in the migration from legacy integrations. |
| **Integration Engineer / Tech Lead (merchant)** | Leads the technical implementation and owns the frontend and backend code. |
| **Merchant development team** | Implements and maintains the integration. |
| **Risk and Antifraud team (merchant)** | Defines the `additional_data` field set for STC, monitors fraud metrics, and validates correct CMID propagation. |
| **PCI Compliance team (merchant)** | Verifies that the integration maintains SAQ A scope and that there are no paths through which buyer cardholder data could reach the merchant infrastructure. |
| **QA team (merchant)** | Executes the test plan in Sandbox prior to Live promotion. |
| **Operations (merchant)** | Monitors checkout in production, manages alerts and incidents (SDK outage, anomalous Create/Capture latency, OAuth errors). |

---

## 5. Glossary of terms and acronyms

| Term | Definition |
|---------|------------|
| **PayPal Web SDK v6** | Version 6 of the PayPal JavaScript SDK, distributed from `https://www.paypal.com/web-sdk/v6/core` (Live) or `https://www.sandbox.paypal.com/web-sdk/v6/core` (Sandbox). Loaded via `<script async src="...">` with no query string parameters. |
| **`createInstance`** | v6 SDK function (`window.paypal.createInstance({...})`) that returns an instance configured with `clientId`, `components`, `pageType`, and `locale`. It is the mandatory first step before any payment session. |
| **`findEligibleMethods`** | SDK instance method that returns the payment methods eligible for a given `currencyCode`. Used to decide which buttons to render in the UI. |
| **`paymentMethods.getDetails('paylater')`** | Helper exposed by the result of `findEligibleMethods` returning PayLater-specific metadata for the buyer's market (includes `productCode` and `countryCode`). |
| **One-Time Payment Session** | Non-recurring payment session. The v6 SDK exposes a separate constructor per payment method (`createPayPalOneTimePaymentSession`, `createPayLaterOneTimePaymentSession`, `createPayPalCreditOneTimePaymentSession`, `createPayPalGuestOneTimePaymentSession`). All share the same shape: `onApprove`, `onCancel`, `onError` callbacks (and `onWarn` in BCDC) and a `start(...)` method. |
| **`session.start(options, orderPromise)`** | Method that activates the session and opens the PayPal-hosted UI. Receives an `options` object (with `presentationMode`) and the Create Order **promise**. The promise **must not be `await`-ed** at the moment it is passed, in order to preserve *transient activation*. The promise must resolve to `{ orderId: <ORDER_ID> }`. |
| **`presentationMode`** | `options` attribute that controls how PayPal presents its UI. Typical values: `'auto'` (adaptive decision per device and browser), `'modal'`, `'popup'`. |
| **`<paypal-basic-card-button>` / `<paypal-basic-card-container>`** | Custom elements registered by the v6 SDK when the `'paypal-guest-payments'` component is enabled. They are the canonical elements for activating the BCDC session. The merchant attaches the listener to `<paypal-basic-card-button>` and triggers `session.start(...)`. |
| **`targetElement`** | `options` attribute applicable to programmatic-open or *auto-start* variants of the v6 SDK (the session is initiated without depending on the recommended click handler; the element acts as a visual anchor for the BCDC experience). It is **not** used in this SDD's canonical flow, which uses an explicit click handler on `<paypal-basic-card-button>`. |
| **Transient activation** | Browser state, propagated by the HTML API, indicating that the user has performed a recent gesture (typically a click). It is consumed when opening a window or executing an operation requiring implicit consent. **Using `await` before invoking `session.start` consumes the state** and browsers will block the pop-up. |
| **Order** | REST resource (`/v2/checkout/orders`) representing the intent to charge: amount, breakdown, items, buyer. Identified by `order_id`. |
| **Capture** | Operation that executes the actual charge against the approved payment method (`POST /v2/checkout/orders/{id}/capture`). |
| **`intent`** | Order field indicating `CAPTURE` (charge upon approval) or `AUTHORIZE` (only hold funds). The typical e-commerce use, and the one covered by this SDD, is `CAPTURE`. |
| **`access_token`** | OAuth2 Bearer token that the merchant backend uses to authenticate against the PayPal REST API. **Must never** be sent to the browser. |
| **`client_credentials`** | OAuth2 grant type used by this integration to obtain the `access_token`. **No** `response_type=id_token` is requested; the v6 SDK does not require an `id_token` to initialize. |
| **CMID** | *Client Metadata ID.* Alphanumeric identifier of **up to 32 characters with no hyphens**, generated **once per checkout session**. Recommended practice is a UUID v4 without hyphens (32 characters). It acts as a correlation thread between the frontend, the STC URL, and the `PayPal-Client-Metadata-Id` headers of Create Order and Capture Order. |
| **STC** | *Set Transaction Context.* Endpoint `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` through which the merchant sends buyer context to PayPal Risk **before each Create Order**. It is **non-blocking**: errors must never stop the checkout. |
| **`PayPal-Client-Metadata-Id`** | HTTP header injected by the merchant backend on Create Order and Capture Order. Carries the session CMID and lets PayPal Risk correlate the transaction with SDK telemetry and STC context. |
| **`PayPal-Request-Id`** | HTTP **per-operation idempotency** header. Each operation (Create Order, Capture Order) has its own key (`createRequestId`, `captureRequestId`). The same key is reused only for retries of the **same** request (timeouts or transient `5xx`). The key is **never** reused across different operations. |
| **BFF** | *Backend-for-Frontend.* Architectural pattern in which the merchant backend exposes only the endpoints required by the checkout flow, custodies secrets, and acts as an authenticated proxy to the PayPal REST API. |
| **BCDC** | *Branded Card-Direct Checkout.* PayPal product for processing credit/debit cards as a guest, with PayPal-hosted capture UI. **Must not** be confused with ACDC. |
| **PCI DSS** | *Payment Card Industry Data Security Standard.* Security standard for handling card data. Because capture happens in the PayPal-hosted UI, the merchant can remain in **SAQ A** scope. |
| **SAQ A** | *Self-Assessment Questionnaire A.* Simplified PCI questionnaire applicable when the merchant does not store, process, or transmit account data. |
| **`pageType`** | `createInstance` parameter that signals to PayPal the type of page where the SDK operates (`'checkout'`, `'product-details'`, `'cart'`, etc.). It influences metrics and presentation of some methods. For this integration the value is `'checkout'`. |
| **`locale`** | `createInstance` parameter in BCP-47 format (`'es-MX'`, `'en-US'`, `'pt-BR'`, etc.). Defines the language of the PayPal-hosted UI. |
| **`currencyCode`** | `findEligibleMethods` parameter in ISO 4217 format (`'MXN'`, `'USD'`, `'BRL'`, etc.). Determines per-market method eligibility. |
| **NFR** | *Non-Functional Requirement.* |

---

# Part II — Solution definition

## 6. Solution overview

The solution comprises **three planes** with strictly delimited responsibilities and a **correlation identifier** (CMID) that crosses all three throughout the entire checkout session.

| Plane | Responsibility | What it does NOT do |
|-------|----------------|----------------------|
| **Buyer browser** | Generates the CMID, loads the v6 SDK, calls `createInstance` and `findEligibleMethods`, instantiates payment sessions, renders the buttons, triggers `session.start(...)` with the Create Order promise, and reacts to callbacks. | Never knows `CLIENT_SECRET`, `access_token`, or `MERCHANT_ID`. Never calls the PayPal REST API directly for business operations. |
| **Merchant backend** | Custodies credentials, obtains `access_token` via OAuth2 `client_credentials`, exposes proxy endpoints to PayPal, injects `PayPal-Request-Id` (with separate idempotency keys for Create and Capture) and `PayPal-Client-Metadata-Id` headers, runs STC server-side before each Create Order, and builds the Create Order payload from the authenticated cart state. | Never receives nor handles buyer cardholder data (in any flow: PayPal, PayLater, Credit, or BCDC). Never exposes `access_token`, `client_secret`, or `merchant_id` to the frontend. **Never accepts order payload, amount, items, or breakdown sent by the client.** |
| **PayPal REST API** | Processes orders, captures, and risk context (STC). | It is the single source of transactional truth. |

### 6.1 Solution components

| Component | Plane | Function |
|-----------|-------|----------|
| **PayPal Web SDK v6** | Browser | Renders the PayPal-hosted UI, manages the lifecycle of payment sessions, and handles communication with `paypal.com`. |
| **Merchant buttons** | Browser | Merchant-owned `<button>` HTML elements that trigger `session.start(...)`. Branding and style belong to the merchant. |
| **OAuth2 Service** | Backend | Obtains and caches `access_token` via `client_credentials`. |
| **Orders Proxy** | Backend | Creates, looks up, and captures orders. Injects idempotency and correlation headers. |
| **STC Caller** | Backend | Calls `/v1/risk/transaction-contexts` server-side inside the `POST /api/orders` handler, before Create Order. Does not expose a public endpoint to the frontend. |
| **PayPal REST API** | PayPal | Actual processing. |

### 6.2 Correlation identifier: the CMID

The **CMID** (Client Metadata ID) is an alphanumeric identifier of up to 32 characters with no hyphens, generated once per checkout session. The recommended implementation is a UUID v4 without hyphens (32 characters). It crosses all three planes:

```
Browser                           Merchant backend                  PayPal API
─────────                         ────────────────                  ──────────
1. generates CMID
2. CMID → body._cmid of /api/orders ──→  (server-side, in strict order)
                                          PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}  (STC, non-blocking)
                                          PayPal-Client-Metadata-Id ──→ POST /v2/checkout/orders
3. CMID → body._cmid of /api/orders/:id/capture
                                     ──→  PayPal-Client-Metadata-Id ──→ POST /v2/checkout/orders/{id}/capture
```

Without a consistent CMID across the three planes, PayPal Risk cannot correlate the STC context with the actual transaction, which degrades the quality of the risk evaluation.

> **NOTE — Fraudnet on JSv6:** Unlike legacy integrations based on the classic SDK, the v6 SDK automatically injects the required telemetry. **The merchant must not inject additional Fraudnet scripts.** The CMID is propagated via backend HTTP headers, not via attributes of the SDK `<script>`.

### 6.3 Payment methods under a single SDK

Once the `sdkInstance` is created, the four payment methods are exposed via symmetric constructors:

| Method | Session constructor | Required component in `createInstance` |
|--------|----------------------|----------------------------------------|
| **PayPal** | `sdkInstance.createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **PayLater** | `sdkInstance.createPayLaterOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **PayPal Credit** | `sdkInstance.createPayPalCreditOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **BCDC (Guest)** | `sdkInstance.createPayPalGuestOneTimePaymentSession({ onApprove, onCancel, onWarn, onError })` | `'paypal-guest-payments'` |

> **MANDATORY:** The `components` array passed to `createInstance` must **explicitly** include the components corresponding to the methods the merchant will expose. For a complete integration: `['paypal-payments', 'paypal-guest-payments']`.

---

## 7. Functional requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| **FR-01** | The system must allow the buyer to complete a charge against their PayPal account via `createPayPalOneTimePaymentSession`. | Mandatory |
| **FR-02** | The system must allow the buyer to complete a credit/debit card charge as a guest via BCDC (`createPayPalGuestOneTimePaymentSession`), with card data capture fully delegated to the PayPal-hosted UI. The merchant does not capture, transmit, or store cardholder data. | Mandatory |
| **FR-03** | The system must offer **PayLater** and **PayPal Credit** when `findEligibleMethods` reports them as eligible for the session's currency and market. | Mandatory (when applicable) |
| **FR-04** | The system must create each order with `intent: "CAPTURE"` and a mathematically consistent breakdown (`item_total + tax_total + shipping − discount = amount.value`). | Mandatory |
| **FR-05** | The system must execute payment capture in `onApprove`, via a `POST /v2/checkout/orders/{id}/capture` call performed by the merchant backend. | Mandatory |
| **FR-06** | The system must activate each payment session preserving the browser's *transient activation*: the Create Order promise **must not** be `await`-ed before being passed to `session.start(...)`. | Mandatory |
| **FR-07** | The system must transmit buyer context to PayPal Risk before each Create Order, without blocking the checkout in case of STC error. | Mandatory |
| **FR-08** | The system must generate a CMID unique per checkout session and propagate it as the `PayPal-Client-Metadata-Id` header on Create Order and Capture Order, and as a URL segment in the STC call. | Mandatory |
| **FR-09** | The system must allow buyer retries within the same checkout session without regenerating the CMID. | Mandatory |
| **FR-10** | The system must enrich the post-capture response via `GET /v2/checkout/orders/{id}` to obtain capture identifiers and reconciliation data. | Mandatory |
| **FR-11** | The system must show the buyer a clear, actionable message when a payment fails (`onError`) or is canceled by the buyer (`onCancel`). | Mandatory |
| **FR-12** | The system must degrade gracefully when a payment method is not eligible: the corresponding button is not rendered and the UI does not present invalid options to the buyer. | Mandatory |

---

## 8. Non-functional requirements

| ID | Category | Requirement |
|----|----------|-------------|
| **NFR-01** | **Security — PCI DSS** | The merchant must not process, transmit, or store buyer cardholder data at any point in the flow. The integration must allow SAQ A compliance. |
| **NFR-02** | **Security — secrets** | `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, and `access_token` must never be transmitted to the browser, stored in versioned source code, or appear in logs. |
| **NFR-03** | **Security — transport** | All communications (browser ↔ backend, backend ↔ PayPal) must use TLS 1.2 or higher. |
| **NFR-04** | **Security — CSP** | The site must declare a Content Security Policy explicitly listing PayPal origins: `www.paypal.com`, `www.sandbox.paypal.com`, `www.paypalobjects.com`, `c.paypal.com`, `api-m.paypal.com` (and their Sandbox equivalents). |
| **NFR-05** | **Availability** | Outages of accessory services (STC) **must not** interrupt the payment flow. STC operates non-blockingly. |
| **NFR-06** | **Idempotency** | The system must guarantee that retries of Create Order or Capture Order do not produce duplicate orders or captures, via `PayPal-Request-Id` using **per-operation independent keys** (`createRequestId` for Create, `captureRequestId` for Capture). |
| **NFR-07** | **Latency (p95)** | The total time between the button click and the response to the user must not exceed the merchant's internal SLOs. The `access_token` cache (§11.3) and non-blocking STC processing are essential to meet it. |
| **NFR-08** | **Traceability** | The system must log `order_id`, `capture_id`, `status`, PayPal error code, and CMID, without logging backend secrets (`access_token`, `client_secret`, full `Authorization` header). The merchant does not handle buyer cardholder data, so there is no risk of accidentally logging it. |
| **NFR-09** | **Internationalization** | The SDK must initialize with the `locale` corresponding to the target market and error messages must be translated to the buyer's language. |
| **NFR-10** | **Accessibility** | The merchant buttons that activate sessions must comply with WCAG 2.1 AA: visible focus, accessible labels, sufficient contrast, minimum touch area 44×44 px. |
| **NFR-11** | **Scalability** | The backend must cache `access_token` up to 90% of `expires_in` to avoid saturating `/v1/oauth2/token` under load. |
| **NFR-12** | **Browser compatibility** | The integration must call `findEligibleMethods` before rendering any button and omit those methods that are not eligible. |
| **NFR-13** | **Auditability** | Each transaction must be reconstructible from logs: CMID, `createRequestId`, `captureRequestId`, `order_id`, `invoice_id`, `custom_id`. |
| **NFR-14** | **Transient activation preservation** | The button click handler **must not** contain `await` before invoking `session.start(...)`. The Create Order promise must be built and immediately passed to the SDK. |

---

## 9. Solution architecture

### 9.1 Logical diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  BUYER BROWSER (public zone)                                            │
│                                                                         │
│   Merchant checkout HTML/JS           PayPal Web SDK v6                 │
│   ┌───────────────────────────┐       ┌───────────────────────────┐     │
│   │ - CMID generation         │ uses→ │ paypal.createInstance()   │     │
│   │ - Button rendering        │       │ sdkInstance.findEligible  │     │
│   │ - addEventListener click  │       │ Methods()                 │     │
│   │ - Calls to /api/* of the  │       │ createPayPalOneTime…      │     │
│   │   backend                 │       │ createPayLaterOneTime…    │     │
│   │                           │       │ createPayPalCreditOneTime…│     │
│   │                           │       │ createPayPalGuestOneTime… │     │
│   └─────────────┬─────────────┘       │ session.start(...)        │     │
│                 │ HTTPS /api/*        │ (PayPal-hosted UI)        │     │
│                 │                     └─────────────┬─────────────┘     │
│                 │                                   │ HTTPS direct      │
│                 │                                   │ to PayPal domains │
└─────────────────┼───────────────────────────────────┼───────────────────┘
                  ↓                                   ↓
┌──────────────────────────────────┐       ┌───────────────────────────────┐
│  MERCHANT BACKEND (private)      │       │  PayPal REST API              │
│                                  │       │                               │
│  - PAYPAL_CLIENT_ID              │ HTTPS │  api-m.sandbox.paypal.com     │
│  - PAYPAL_CLIENT_SECRET ←────────┼──────→│  api-m.paypal.com (Live)      │
│  - PAYPAL_MERCHANT_ID            │       │                               │
│  - access_token (in memory)      │       │  /v1/oauth2/token             │
│                                  │       │  /v2/checkout/orders          │
│  Endpoints exposed to frontend   │       │  /v2/checkout/orders/{id}     │
│  (suggested):                    │       │  /v2/checkout/orders/{id}/    │
│  - GET    /api/config            │       │     capture                   │
│  - POST   /api/orders            │       │  /v1/risk/transaction-        │
│  - GET    /api/orders/:id        │       │     contexts/{mid}/{cmid}     │
│  - POST   /api/orders/:id/       │       │                               │
│           capture                │       │                               │
│  (STC is invoked internally     │       │                               │
│   in POST /api/orders, never    │       │                               │
│   exposed to the frontend)      │       │                               │
└──────────────────────────────────┘       └───────────────────────────────┘
```

### 9.2 Non-negotiable architectural rules

1. **`PAYPAL_CLIENT_SECRET` resides only in backend environment variables.** Never versioned, never sent to the browser.
2. **The browser never calls `api-m.paypal.com` directly** for business operations. All communication with the REST API goes through the merchant backend, which acts as an authenticated proxy.
3. **The browser never receives the `access_token`.** It only receives the public `client_id` (via `GET /api/config`) and identifiers returned by proxy calls (`order_id`, `capture_id`).
4. **Buyer cardholder data never touches the merchant.** In PayPal, PayLater, and Credit the flow does not involve buyer card data from the merchant's perspective (the PayPal account and the financing are the abstraction). In BCDC, capture happens entirely in the PayPal-hosted UI. The merchant does not implement Card Fields or its own capture iframes.
5. **Cart, buyer, and shipping address data is never hardcoded in the frontend code.** It comes from the authenticated session and the cart state on the backend.
6. **The backend does not return sensitive fields (`client_secret`, `access_token`, `merchant_id`) to the frontend under any circumstance**, not even in configuration or telemetry endpoints.

### 9.3 Security boundary by asset

| Asset | Frontend | Backend | PayPal API |
|-------|:-------:|:------:|:----------:|
| `CLIENT_ID` | Yes | Yes | — |
| `CLIENT_SECRET` | **No** | **Yes (env)** | — |
| `MERCHANT_ID` | **No** | **Yes (env)** | — |
| `access_token` | **No** | Yes (memory) | — |
| Buyer cardholder data | **PayPal-hosted UI** (only in BCDC) | **No** | Yes |
| `order_id` | Yes (reference) | Yes | Yes |
| `capture_id` | Yes (reference) | Yes | Yes |
| `CMID` | Yes (generates) | Yes (received in body) | Yes (header) |

### 9.4 Architectural pattern: Backend-for-Frontend (BFF) over PayPal

The merchant backend implements the **Backend-for-Frontend** pattern over the PayPal REST API. The `/api/*` endpoints are not a generic API; they exist for the specific needs of checkout and they custody secrets, idempotency, and correlation headers that the frontend must not handle.

The practical consequences are:

- The frontend **does not** know about `api-m.paypal.com`. It only knows the `/api/*` routes of its own backend.
- The backend **does not** expose a generalized PayPal API. Each endpoint maps to a checkout business operation (create order, capture order, register risk context).
- Credential rotation and environment switching (Sandbox ↔ Live) are transparent for the frontend: only backend environment variables change.

---

## 10. Prerequisites and environment configuration

### 10.1 Required commercial entitlements

Before starting the implementation, the merchant must have the following enabled on its PayPal account:

| Capability | Applies to |
|-----------|------------|
| **PayPal Checkout (One-Time Payments)** | Pay with PayPal account. |
| **BCDC (Branded Card-Direct Checkout)** | Pay with credit/debit card as guest. |
| **PayLater** | When the merchant intends to offer PayLater in eligible markets. |
| **PayPal Credit** | When the merchant intends to offer the PayPal credit line. |
| **Set Transaction Context (STC)** | Access to the `/v1/risk/transaction-contexts` endpoint. |

### 10.2 Backend credentials and configuration

| Environment variable | Source | Visibility |
|--------------------|--------|-------------|
| `PAYPAL_CLIENT_ID` | PayPal Developer Dashboard → merchant app. | Public (may be exposed to the frontend via `GET /api/config`). |
| `PAYPAL_CLIENT_SECRET` | PayPal Developer Dashboard → merchant app. | **Secret — backend only.** |
| `PAYPAL_MERCHANT_ID` | Merchant account profile in PayPal. | Private — backend only (required for STC). |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` (Sandbox) · `https://api-m.paypal.com` (Live). | Private. |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` (Sandbox) · `https://www.paypal.com/web-sdk/v6/core` (Live). | Public (may be exposed to the frontend so the `<script>` loads the correct SDK URL). |

> **MANDATORY:** Sandbox and Live credentials and URLs are different. `PAYPAL_API_BASE`, `PAYPAL_SDK_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_MERCHANT_ID` must all correspond to the **same environment**. Mixing them produces `401 Unauthorized` on the first OAuth call or opaque errors during SDK initialization.

### 10.3 Environment requirements

- **TLS / HTTPS mandatory in production.** The v6 SDK does not operate over HTTP.
- **Content Security Policy (CSP):** must allow at minimum:
  - `script-src https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com` (plus Sandbox equivalents when applicable).
  - `frame-src https://www.paypal.com` (plus Sandbox equivalents).
  - `connect-src https://api-m.paypal.com https://api-m.sandbox.paypal.com`.
- **Web Crypto API support** in the browser (for `crypto.randomUUID()`). To support legacy browsers, implement a fallback (see §12.2).
- **Pop-up support for the merchant domain.** The user must not have pop-ups blocked for `paypal.com`. The *transient activation*-based activation pattern (§16) is designed precisely so that the browser allows the pop-up without requiring user configuration.

### 10.4 Public configuration endpoint

The backend must expose an endpoint that delivers to the frontend **only** the public values needed to initialize the SDK:

```http
GET /api/config
→ 200 OK
{
  "clientId": "<PAYPAL_CLIENT_ID>",
  "sdkUrl":   "<PAYPAL_SDK_URL>"
}
```

| Field | Decision rationale |
|-------|--------------------|
| `clientId` | Required for `paypal.createInstance(...)`. Not hardcoded in HTML because the merchant typically alternates between multiple environments (Sandbox / Live, possibly UAT) across deployments. |
| `sdkUrl` | **Merchant architectural decision.** A valid alternative —and one used in official PayPal samples— is to hardcode `<script async src="https://www.paypal.com/web-sdk/v6/core">` directly in the HTML per environment. Serving `sdkUrl` from the backend simplifies multi-environment operations (Sandbox/Live decided by backend environment variables, not by the frontend build). |

> **MANDATORY:** This endpoint **must never** return `client_secret`, `access_token`, or `merchant_id`. Automated tests must validate that the response does not contain these keys.

> **NOTE:** If the merchant prefers to hardcode the SDK `<script>` in its HTML per environment (separate Sandbox/Live deployments), `GET /api/config` may be simplified to return only `clientId`. Both strategies are valid; the SDD documents the version with server-side `sdkUrl` because it is the more flexible one for multi-environment operations.

---

# Part III — Detailed design

## 11. OAuth2 authentication (`client_credentials`)

The merchant backend is the only component authorized to talk OAuth2 with PayPal. The purpose of this step is to obtain a Bearer **`access_token`** so that the backend can invoke the PayPal REST API.

> **MANDATORY:** Unlike integrations based on the classic SDK, **this solution does not require an `id_token`**. The v6 SDK initializes only with the public `client_id`; there is no `data-sdk-client-token` attribute. The grant is strictly `client_credentials`.

### 11.1 Request

```http
POST {PAYPAL_API_BASE}/v1/oauth2/token
Authorization: Basic <BASE64(CLIENT_ID:CLIENT_SECRET)>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

### 11.2 Response (relevant fields)

```json
{
  "access_token": "<ACCESS_TOKEN>",
  "expires_in":   32400,
  "token_type":   "Bearer",
  "app_id":       "<APP_ID>",
  "scope":        "https://api.paypal.com/v1/payments/.* ..."
}
```

### 11.3 `access_token` cache

| Practice | Rationale |
|----------|-----------|
| Cache the `access_token` in the backend process memory up to **90% of `expires_in`** and refresh proactively. | Avoids unnecessary calls to `/v1/oauth2/token` and reduces latency on the Create Order critical path. |
| **Do not** persist the `access_token` to disk, database, or logs. | Bearer token with transactional power; exposing it compromises the account. |
| Refresh immediately upon a `401` from any call and retry **once**. | Covers the edge case of a token revoked by credential rotation. |
| Invalidate the cache upon a manual `CLIENT_SECRET` rotation. | A rotation leaves the cached token invalid; the backend must force refresh on the next call. |

### 11.4 Reference implementation (Node.js)

```javascript
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${process.env.PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    throw new Error(`OAuth failed: ${response.status} ${await response.text()}`);
  }

  const json = await response.json();
  cachedToken          = json.access_token;
  cachedTokenExpiresAt = now + (json.expires_in * 1000 * 0.9);
  return cachedToken;
}
```

### 11.5 Non-exposure to the frontend

The `access_token` is **never** returned to the browser. The backend `/api/*` routes use `getAccessToken()` internally and return only the (masked, when applicable) business response to the frontend.

> **WARNING:** Any endpoint that leaks `access_token` to the browser allows an attacker to operate the merchant's PayPal account. Integration tests must validate that the JSON response of every `/api/*` does not contain the `access_token` key or its value.

---

## 12. Client Metadata ID (CMID) generation

The **CMID** is the first piece of data materialized when the browser initializes the checkout. It is a **unique alphanumeric identifier of up to 32 characters with no hyphens** acting as a correlation thread between three points:

1. The **STC** endpoint URL (`/v1/risk/transaction-contexts/{merchant_id}/{cmid}`).
2. The `PayPal-Client-Metadata-Id` header sent on **Create Order**.
3. The `PayPal-Client-Metadata-Id` header sent on **Capture Order**.

### 12.1 Lifecycle rules

| Rule | Detail |
|------|--------|
| **Unique per checkout session** | Generated **once** at checkout page initialization. |
| **Persistent across retries** | If the buyer fails a payment and retries within the same session, the CMID **is not** regenerated. |
| **Persistent across payment methods** | If the buyer alternates between PayPal, PayLater, Credit, and BCDC in the same session, the CMID is preserved. |
| **Regenerated on a new transaction** | Only after the previous transaction has been completed or definitively canceled is a new CMID generated for a new checkout session. |
| **Propagated server-side by the backend** | The frontend delivers it to the backend in the body of Create Order/Capture Order; the backend forwards it as an HTTP header to PayPal. |

### 12.2 Reference implementation

The recommended implementation is a UUID v4 without hyphens, which fills the available 32 characters and offers the maximum entropy possible within the limit.

```javascript
function generateCMID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, ""); // 32 hex characters
  }
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const cmid = generateCMID();
```

> **NOTE:** Although the PayPal contract accepts up to 32 characters, using maximum-length identifiers (UUID v4 without hyphens) is the recommendation: it maximizes uniqueness and removes ambiguity over the API's accepted range.

### 12.3 Validation

The CMID must satisfy:

- Length between **1 and 32 characters** (inclusive maximum).
- Alphanumeric characters only.
- No hyphens, separators, or whitespace.

```javascript
const isValidCMID = (cmid) =>
  typeof cmid === "string" &&
  cmid.length >= 1 &&
  cmid.length <= 32 &&
  /^[0-9a-zA-Z]+$/.test(cmid);
```

The backend must apply this validation on the `_cmid` received from the frontend before propagating it as an HTTP header to PayPal. A malformed CMID must be rejected with `400 Bad Request` to avoid inconsistent payloads.

---

## 13. Set Transaction Context (STC)

STC allows the merchant to send **buyer context** to PayPal Risk **before** each Create Order. PayPal correlates it with the transaction via the CMID. The operation is **non-blocking**: any error must be logged but **must never** stop the checkout flow.

### 13.1 Endpoint

```http
PUT {PAYPAL_API_BASE}/v1/risk/transaction-contexts/<MERCHANT_ID>/<CMID>
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

| URL component | Source |
|---------------|--------|
| `<MERCHANT_ID>` | Environment variable `PAYPAL_MERCHANT_ID`. |
| `<CMID>` | The CMID generated in §12 for this session. |

### 13.2 Body — generic Retail set

```json
{
  "additional_data": [
    { "key": "sender_account_id",   "value": "<BUYER_ID_IN_THE_MERCHANT_PLATFORM>" },
    { "key": "sender_first_name",   "value": "<BUYER_FIRST_NAME>" },
    { "key": "sender_last_name",    "value": "<BUYER_LAST_NAME>" },
    { "key": "sender_email",        "value": "<BUYER_EMAIL>" },
    { "key": "sender_phone",        "value": "<PHONE_DIGITS_ONLY>" },
    { "key": "sender_country_code", "value": "<COUNTRY_ISO_ALPHA2>" },
    { "key": "sender_create_date",  "value": "<USER_SIGNUP_DATE>" },
    { "key": "highrisk_txn_flag",   "value": "0" },
    { "key": "vertical",            "value": "<BUSINESS_VERTICAL>" }
  ]
}
```

### 13.3 Field reference

| Field | Type | Description | Accepted values |
|-------|------|-------------|-----------------|
| `sender_account_id` | string | Unique buyer identifier in the merchant platform. | Stable alphanumeric across sessions. |
| `sender_first_name` | string | Buyer's registered first name. | Alphanumeric. |
| `sender_last_name` | string | Buyer's registered last name. | Alphanumeric. |
| `sender_email` | string | Buyer's validated email. | RFC 5322 format. |
| `sender_phone` | string | Buyer's phone, **digits only**, no formatting. | `[0-9]+` |
| `sender_country_code` | string | Buyer's country in ISO 3166-1 Alpha-2. | `MX`, `US`, `BR`, etc. |
| `sender_create_date` | string | Date the user signed up to the merchant platform. | Accepted formats: `yyyy-mm-ddThh:mm:ss.000-00:00`, `yyyy-mm-ddThh:mm:ss.0000000Z`, `yyyy-mm-ddThh:mm:ss+00:00`, `yyyy-mm-ddThh:mm:ssZ`, `yyyy-mm-dd`, `yyyymmdd`. |
| `highrisk_txn_flag` | string | Indicates whether the transaction is high-risk (gift cards, electronics, etc.). | `"0"` = normal, `"1"` = high risk. |
| `vertical` | string | Business vertical. | `Retail`, `Travel`, `Gaming`, etc. (consult industry pack with the Integration Engineer). |

> **NOTE — Industry packs:** The above set is the generic Retail one. Verticals such as Travel, OTAs, Financial Services, Gaming, and regulated platforms require specific additional fields. Request the corresponding industry pack from the assigned Integration Engineer.

### 13.4 Response handling — non-blocking behavior

| HTTP status | Meaning | Frontend/backend action |
|------------:|---------|--------------------------|
| `200` | OK. Context registered. | Continue with Create Order. |
| `400` | Invalid body (incorrect field type or format). | Log the error in detail, **continue** with Create Order. |
| `401` | No permissions or expired `access_token`. | Refresh token, log, **continue** with Create Order. |
| `5xx` | PayPal internal error. | Log, **continue** with Create Order. |

> **MANDATORY:** STC must never block the checkout. An STC failure reduces the quality of risk evaluation but **does not** prevent the transaction from being processed.

### 13.5 Reference implementation — server-side STC inside Create Order

STC runs **server-side**, inside the `POST /api/orders` handler itself, **sequenced before** the call to `POST /v2/checkout/orders` and wrapped in `try/catch`. This guarantees two properties not obtained by firing STC from the frontend in *fire-and-forget* mode:

1. **Strict ordering:** STC always reaches PayPal Risk **before** Create Order, not in parallel.
2. **True non-blocking behavior:** an STC failure is logged but does not stop order creation.

#### 13.5.1 `callSTC` helper function on the backend

```javascript
async function callSTC({ cmid, additionalData }) {
  const accessToken = await getAccessToken();
  const response = await fetch(
    `${process.env.PAYPAL_API_BASE}/v1/risk/transaction-contexts/${process.env.PAYPAL_MERCHANT_ID}/${cmid}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify({ additional_data: additionalData })
    }
  );

  if (!response.ok) {
    throw new Error(`STC failed: ${response.status}`);
  }
}
```

#### 13.5.2 Usage inside `POST /api/orders`

```javascript
// Inside the POST /api/orders handler (see §21.7 for the full handler):
try {
  await callSTC({
    cmid: _cmid,
    additionalData: buildAdditionalDataFromTrustedState(req.user)
  });
} catch (err) {
  logger.warn({ err, cmid: _cmid }, "STC failed; continuing checkout");
}

// Continue with Create Order regardless of the STC result
const order = await createPayPalOrder({ ... });
```

> **MANDATORY:** STC runs **before** **every** Create Order, regardless of payment method (PayPal, PayLater, Credit, or BCDC). The frontend **does not** invoke STC directly; it only sends `_cmid` to the backend in the body of `POST /api/orders`.

> **MANDATORY — Non-blocking semantics:** "Non-blocking" means "STC failures must never stop the checkout", **not** "STC runs in parallel with no ordering guarantee". That is why the `await` inside `try/catch` is mandatory: it sequences the call before Create Order and isolates errors.

> **NOTE:** A public `PUT /api/stc` endpoint is not exposed to the frontend. All propagation of CMID and buyer context to STC happens inside the merchant backend, the component with access to the `access_token` and the user's authenticated state.

---

## 14. Loading the PayPal Web SDK v6

The v6 SDK is loaded via `<script async>` directly in the checkout HTML. It **does not** accept query string parameters like the classic SDK.

### 14.1 SDK URLs

| Environment | URL |
|-------------|-----|
| **Sandbox** | `https://www.sandbox.paypal.com/web-sdk/v6/core` |
| **Live** | `https://www.paypal.com/web-sdk/v6/core` |

### 14.2 Insertion in the HTML

The exact URL must be selected by environment and delivered to the frontend via `GET /api/config` (§10.4). The `<script>` is inserted in `<head>` or at the end of `<body>`:

```html
<script async src="<PAYPAL_SDK_URL>"></script>
```

Relevant attributes:

| Attribute | Value | Function |
|-----------|-------|----------|
| `async` | (present) | Enables download without blocking the parser. |
| `src` | SDK URL per environment. | Defines which environment (Sandbox/Live) is used. |

> **MANDATORY:** Do not add `data-*` attributes to the `<script>`. The v6 SDK is not configured via tag attributes; all configuration goes through `paypal.createInstance(...)` (§15).

### 14.3 Load detection

The frontend must wait until `window.paypal.createInstance` is available before initializing the session. When the `<script>` is inserted dynamically, the `onload` listener is the standard path:

```javascript
function loadSDK(sdkUrl) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.async   = true;
    s.src     = sdkUrl;
    s.onload  = () => resolve(window.paypal);
    s.onerror = () => reject(new Error("PayPal SDK failed to load"));
    document.body.appendChild(s);
  });
}
```

### 14.4 Environment switching (Sandbox ↔ Live)

> **MANDATORY:** Switching between Sandbox and Live requires a page reload. The v6 SDK registers *custom elements* and these cannot be re-registered in the same session. Any logic intending to switch environments at runtime will fail silently.

In production, the environment is determined at backend startup and remains stable for the life of the process. There is no real use case requiring runtime environment switching.

---

## 15. SDK initialization and eligible-method discovery

Once the SDK `<script>` is loaded, the next step is to call `createInstance` and then `findEligibleMethods` to decide which buttons to render.

### 15.1 `paypal.createInstance(...)`

```javascript
const sdkInstance = await window.paypal.createInstance({
  clientId:         "<PAYPAL_CLIENT_ID>",
  components:       ["paypal-payments", "paypal-guest-payments"],
  pageType:         "checkout",
  locale:           "<LOCALE_BCP47>",
  clientMetadataId: cmid   // optional but recommended — see §15.1.1
});
```

| Parameter | Value | Notes |
|-----------|-------|-------|
| `clientId` | `<PAYPAL_CLIENT_ID>` | Received from the backend in `GET /api/config`. It is the only public PayPal identifier that travels to the frontend. **Not** a secret: it can appear in HTML, in developer tools, and in public logs without risk. |
| `components` | Array containing `'paypal-payments'`, `'paypal-guest-payments'`. | `paypal-payments` enables PayPal, PayLater, and PayPal Credit. `paypal-guest-payments` enables BCDC. For a complete integration, both. |
| `pageType` | `'checkout'` | Tells the SDK it operates on a checkout page (affects metrics and presentation). Other possible values (`'cart'`, `'product-details'`) do not apply to this integration. |
| `locale` | `'es-MX'`, `'en-US'`, `'pt-BR'`, etc. | Language of the PayPal-hosted UI. BCP-47 format with hyphen. Must match the buyer's market. |
| `clientMetadataId` *(optional)* | Same CMID generated in §12. | Passes the CMID to the SDK so that the telemetry the SDK sends to PayPal Risk is correlated with the session, just like the server-side `PayPal-Client-Metadata-Id` headers. |

> **MANDATORY:** `createInstance` returns a `Promise`. It **must** be `await`-ed (this happens during the initialization phase, not in the click handler; there is no risk of consuming *transient activation*).

> **NOTE:** `clientId` is the only public PayPal identifier the frontend knows. Not a secret. **No** `id_token` is required in JSv6.

#### 15.1.1 `clientMetadataId` and STC correlation

The v6 SDK accepts the optional `clientMetadataId` parameter in `createInstance(...)` to correlate SDK telemetry with the buyer session in PayPal's server-side logs. The recommendation is to pass **exactly the same CMID** that will be used in STC and in the `PayPal-Client-Metadata-Id` headers:

| Where the CMID appears | How it is injected |
|------------------------|--------------------|
| v6 SDK (telemetry) | `clientMetadataId` in `createInstance(...)` (optional) |
| STC | URL segment `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` (server-side) |
| Create Order | Header `PayPal-Client-Metadata-Id` (server-side) |
| Capture Order | Header `PayPal-Client-Metadata-Id` (server-side) |

> **Recommendation:** Confirm with the assigned Integration Engineer whether the merchant's case justifies passing `clientMetadataId` to the SDK. When that decision is made, it must be **the same value** generated in §12 for the checkout session.

### 15.2 `sdkInstance.findEligibleMethods(...)`

```javascript
const paymentMethods = await sdkInstance.findEligibleMethods({
  currencyCode: "<CURRENCY_ISO_4217>"
});
```

| Parameter | Value | Notes |
|-----------|-------|-------|
| `currencyCode` | `'MXN'`, `'USD'`, `'BRL'`, etc. | Checkout currency in ISO 4217. Determines per-market eligibility. |

`paymentMethods` exposes the methods available for the combination `clientId` + `currencyCode` + buyer market. The merchant must check eligibility before rendering each button:

```javascript
if (paymentMethods.isEligible("paypal")) {
  renderPayPalButton();
}
if (paymentMethods.isEligible("paylater")) {
  renderPayLaterButton();
}
if (paymentMethods.isEligible("credit")) {
  const creditDetails = paymentMethods.getDetails("credit");
  renderPayPalCreditButton(creditDetails);
}
if (paymentMethods.isEligible("guest")) {
  renderGuestCardButton();
}
```

> **MANDATORY (NFR-12):** Do not render a button whose method is not eligible. Doing so produces opaque errors in `session.start(...)` and damages the buyer experience.

> **NOTE — Eligibility keys:** The keys accepted by `isEligible(...)` and `getDetails(...)` are the v6 SDK's functional identifiers: `"paypal"`, `"paylater"`, **`"credit"`** (not `"paypal-credit"`), and `"guest"`. The "PayPal Credit" marketing label is kept only in the UI; in code, always use the `"credit"` key.

### 15.3 PayLater-specific details

For PayLater, the buyer's market-specific `productCode` and `countryCode` are required. The SDK exposes them via `paymentMethods.getDetails('paylater')`:

```javascript
const paylaterDetails = paymentMethods.getDetails("paylater");
// paylaterDetails: { productCode: "<...>", countryCode: "<...>" }
```

These values are subsequently used when building the PayLater session (§18) when the merchant flow requires them.

---

## 16. HTML structure and session activation pattern

### 16.1 Merchant buttons

Unlike integrations based on `paypal.Buttons().render(...)` of the classic SDK, the v6 SDK distinguishes two families of elements for activating a session:

| Family | Methods | Markup |
|--------|---------|--------|
| **Merchant HTML button** | `paypal`, `paylater`, `credit` | Merchant-owned `<button>`. Style and branding are the merchant's. The merchant attaches `addEventListener('click', ...)` and triggers `session.start(...)`. |
| **PayPal-hosted custom element** | `guest` (BCDC) | `<paypal-basic-card-container>` + `<paypal-basic-card-button>`. Card button presentation is controlled by PayPal; the merchant attaches the listener to `paypal-basic-card-button` and triggers `session.start(...)` just like with a merchant button. |

```html
<!-- PayPal, PayLater, PayPal Credit: merchant buttons -->
<button id="btn-paypal"        type="button">Pay with PayPal</button>
<button id="btn-paylater"      type="button">Pay with PayLater</button>
<button id="btn-paypal-credit" type="button">Pay with PayPal Credit</button>

<!-- BCDC: PayPal-hosted custom element -->
<paypal-basic-card-container>
  <paypal-basic-card-button id="paypal-basic-card-button"></paypal-basic-card-button>
</paypal-basic-card-container>

<div id="payment-result" role="status" aria-live="polite"></div>
```

Style, branding, and layout of the HTML buttons belong to the merchant. The appearance of `<paypal-basic-card-button>` is controlled by PayPal and complies with card brand guidelines. The merchant may dynamically hide elements whose methods are not eligible (§15.2).

> **MANDATORY:** For `<paypal-basic-card-container>` and `<paypal-basic-card-button>` to register correctly, the `'paypal-guest-payments'` component must be included in the `components` array of `createInstance(...)` (§15.1) and the SDK must have finished loading before the HTML is rendered or dynamically mounted.

### 16.2 Session activation pattern — preserving *transient activation*

This is the **most critical** rule of the integration. Modern browsers require a recent user gesture (*transient activation*) to open a pop-up or full-page modal. Any `await` before invoking `session.start(...)` consumes the state and the browser blocks the opening.

#### 16.2.1 Correct pattern

```javascript
const session = sdkInstance.createPayPalOneTimePaymentSession({
  onApprove,
  onCancel,
  onError
});

document.getElementById("btn-paypal").addEventListener("click", () => {
  // Build the promise WITHOUT await — preserves transient activation
  const orderPromise = createOrder({ paymentMethod: "paypal" });

  session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

#### 16.2.2 Incorrect pattern (do not implement)

```javascript
// INCORRECT — the await consumes transient activation
document.getElementById("btn-paypal").addEventListener("click", async () => {
  const orderId = await createOrder({ paymentMethod: "paypal" });
  session.start({ presentationMode: "auto" }, Promise.resolve({ id: orderId }))
    .catch(onError);
});
```

> **MANDATORY (NFR-14):** Build the Create Order promise **inside** the click handler and pass it **immediately** to `session.start(...)` without `await`. The promise may take seconds to resolve; the SDK awaits it internally without consuming *transient activation*.

### 16.3 Pattern variants per method

#### 16.3.1 PayPal, PayLater, PayPal Credit

```javascript
session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
```

`presentationMode: 'auto'` lets the SDK decide the best way to present the UI based on the buyer's device and browser (typically pop-up on desktop, full-page on mobile).

#### 16.3.2 BCDC (Guest Card Checkout)

The **recommended** pattern for BCDC attaches the listener to the `<paypal-basic-card-button>` custom element and triggers `session.start(...)` with the same shape as the other sessions (without `targetElement`):

```javascript
const cardBtn = document.getElementById("paypal-basic-card-button");

cardBtn.addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "guest" });
  guestSession.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

| Attribute | Function |
|-----------|----------|
| `presentationMode` | `'auto'` for adaptive presentation. |

> **NOTE — `targetElement`:** The v6 SDK supports programmatic-open or *auto-start* variants where the session is initiated without depending exclusively on the click handler. In those cases `targetElement` acts as a **visual anchor** of the BCDC experience (it references the same `<paypal-basic-card-button>` or the equivalent merchant button). The canonical flow of this SDD is the explicit click handler on `<paypal-basic-card-button>` and **does not** require `targetElement`. Any deviation toward auto-start with `targetElement` must be validated with the assigned Integration Engineer.

### 16.4 Create Order promise shape

The v6 SDK accepts a `Promise` resolving to an object with the property **`orderId`** (the `order_id` returned by PayPal). The frontend must send the backend only controlled references (not the full payload): the authenticated cart identifier, the selected payment method, and the CMID. The backend rebuilds the payload from the cart's trusted state (see §21.7).

```javascript
async function createOrder({ paymentMethod }) {
  const response = await fetch("/api/orders", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      _cmid:         cmid,
      paymentMethod: paymentMethod, // 'paypal' | 'paylater' | 'credit' | 'guest'
      cartId:        getCurrentCartId() // reference to the authenticated cart
    })
  });

  if (!response.ok) {
    throw new Error(`Create Order failed: ${response.status}`);
  }

  const order = await response.json();
  return { orderId: order.id }; // The v6 SDK requires the shape { orderId: <ORDER_ID> }
}
```

> **MANDATORY:** The promise must resolve to `{ orderId: <ORDER_ID> }`. **Do not** use `{ id: ... }`: the v6 SDK specifically expects the `orderId` property. Returning the wrong shape causes `data.orderId` to be `undefined` in the `onApprove` callback.

> **NOTE:** The `createOrder` callback may be an async function because the SDK invokes it internally with `await`. What is critical is that **the click handler** does not block with `await` before `session.start(...)`.

> **NOTE — STC:** The STC call runs **server-side** inside the `POST /api/orders` endpoint itself, sequenced before Create Order but wrapped in `try/catch` to preserve its non-blocking nature (see §13.5 and §21.7). The frontend **does not** invoke STC directly.

### 16.5 Session callbacks

All sessions receive an object with callbacks. The exact shape varies minimally between methods.

| Callback | PayPal / PayLater / Credit | BCDC | Function |
|----------|:--------------------------:|:----:|----------|
| `onApprove(data)` | Yes | Yes | The buyer approved the payment. `data.orderId` contains the `order_id`. The merchant triggers the capture. |
| `onCancel(data)` | Yes | Yes | The buyer closed the UI without completing the payment. Show a sober message and allow retry. |
| `onError(err)` | Yes | Yes | Technical error during the session. Log and show an actionable message. |
| `onWarn(warn)` | — | **Yes** | BCDC-specific non-fatal warning (e.g. invalid card field in the hosted UI). The SDK already shows feedback to the user; the merchant typically just logs. |

> **MANDATORY:** In BCDC, do not omit `onWarn`. The callback exists specifically for hosted-UI warnings; ignoring it leaves the merchant with no telemetry on capture friction.

---

## 17. PayPal Checkout session (PayPal account)

Session activated by `createPayPalOneTimePaymentSession`. It is the buyer's PayPal-account payment flow.

### 17.1 Initialization

```javascript
const paypalSession = sdkInstance.createPayPalOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => {
    showInfo("Payment canceled by the buyer.");
  },
  onError: (err) => {
    console.error("PayPal session error:", err);
    showError("Could not complete the payment. Please try again.");
  }
});
```

### 17.2 Activation

```javascript
document.getElementById("btn-paypal").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "paypal" });
  paypalSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 17.3 Expected behavior

1. PayPal opens its hosted UI (pop-up or full-page) with the buyer's login screen.
2. The buyer authenticates, reviews the summary, and confirms the payment.
3. The hosted UI closes. The SDK invokes `onApprove(data)` with `data.orderId`.
4. The merchant triggers `POST /api/orders/:id/capture` and handles the response.

---

## 18. PayLater session

Session activated by `createPayLaterOneTimePaymentSession`. Offers PayPal-financed installments in eligible markets.

### 18.1 Eligibility pre-check

```javascript
if (!paymentMethods.isEligible("paylater")) {
  document.getElementById("btn-paylater").style.display = "none";
  return;
}
const paylaterDetails = paymentMethods.getDetails("paylater");
// paylaterDetails: { productCode: "<...>", countryCode: "<...>" }
```

`productCode` and `countryCode` describe the PayLater product eligible for the buyer's market (e.g. "Pay in 4" in US, "3x" in MX/BR depending on availability).

### 18.2 Initialization

```javascript
const paylaterSession = sdkInstance.createPayLaterOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Financing canceled."),
  onError:  (err)  => { console.error(err); showError("Error starting PayLater."); }
});
```

### 18.3 Activation

```javascript
document.getElementById("btn-paylater").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "paylater" });
  paylaterSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 18.4 Operational notes

- Product presentation (legal text, rates, conditions) is controlled by the PayPal-hosted UI and complies with the market's regulatory requirements.
- Eligibility may change between sessions (depends on the buyer, the amount, and product availability). The merchant **must** call `findEligibleMethods` every time it initializes the checkout.
- After approval, the capture flow is identical to PayPal Checkout (§17): `POST /v2/checkout/orders/{id}/capture`.

---

## 19. PayPal Credit session

Session activated by `createPayPalCreditOneTimePaymentSession`. Offers the PayPal credit line in markets where the product is available.

### 19.1 Eligibility pre-check

```javascript
if (!paymentMethods.isEligible("credit")) {
  document.getElementById("btn-paypal-credit").style.display = "none";
  return;
}
const creditDetails = paymentMethods.getDetails("credit");
// creditDetails: { productCode: "<...>", countryCode: "<...>" }
```

> **MANDATORY:** The eligibility key is **`"credit"`**, not `"paypal-credit"`. The "PayPal Credit" label is UI only.

### 19.2 Initialization

```javascript
const creditSession = sdkInstance.createPayPalCreditOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Operation canceled."),
  onError:  (err)  => { console.error(err); showError("Error starting PayPal Credit."); }
});
```

### 19.3 Activation

```javascript
document.getElementById("btn-paypal-credit").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "credit" });
  creditSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 19.4 Operational notes

- PayPal Credit is available in a subset of markets. Per-market eligibility is determined via `findEligibleMethods`.
- The hosted UI presents the credit line conditions to the buyer and manages authentication.
- After approval, the capture flow is identical to PayPal Checkout (§17).

---

## 20. BCDC session — Guest Card Checkout

Session activated by `createPayPalGuestOneTimePaymentSession`. Allows the buyer to pay with credit/debit card **without** creating a PayPal account. The card capture UI is **PayPal-hosted**: buyer cardholder data never touches the merchant DOM or backend.

### 20.1 Key differences vs other sessions

| Aspect | PayPal / PayLater / Credit | BCDC |
|--------|---------------------------|------|
| Required component in `createInstance` | `'paypal-payments'` | `'paypal-guest-payments'` |
| Constructor | `createPayPal*OneTimePaymentSession` | `createPayPalGuestOneTimePaymentSession` |
| Callbacks | `onApprove`, `onCancel`, `onError` | `onApprove`, `onCancel`, `onWarn`, `onError` |
| Element triggering the session | Merchant `<button>` | `<paypal-basic-card-button>` inside `<paypal-basic-card-container>` (custom elements registered by the SDK) |
| Arguments to `session.start(...)` | `{ presentationMode: 'auto' }` + `orderPromise` | `{ presentationMode: 'auto' }` + `orderPromise` (identical) |
| Card capture | N/A (PayPal account or financing) | PayPal-hosted UI |

### 20.2 HTML markup

```html
<paypal-basic-card-container>
  <paypal-basic-card-button id="paypal-basic-card-button"></paypal-basic-card-button>
</paypal-basic-card-container>
```

These custom elements are registered by the v6 SDK when `'paypal-guest-payments'` is included in `components` of `createInstance(...)`. If the component is not included, the elements do not hydrate and remain as inert tags in the DOM.

### 20.3 Initialization

```javascript
const guestSession = sdkInstance.createPayPalGuestOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Card payment canceled."),
  onWarn:   (warn) => console.warn("BCDC warning:", warn),
  onError:  (err)  => { console.error(err); showError("Could not process the card."); }
});
```

### 20.4 Activation (recommended click-handler pattern)

```javascript
document
  .getElementById("paypal-basic-card-button")
  .addEventListener("click", () => {
    const orderPromise = createOrder({ paymentMethod: "guest" });
    guestSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
  });
```

> **MANDATORY:** The listener is attached to `<paypal-basic-card-button>` (PayPal-hosted custom element). The handler **must not** contain `await` before `session.start(...)` (the *transient activation* rule of §16.2).

> **NOTE — `targetElement`:** The v6 SDK supports programmatic-open or *auto-start* variants (for example, triggering the session from an `onload` handler instead of a click). In those variants, `options.targetElement` acts as a **visual anchor** of the BCDC experience and is invoked as:
>
> ```javascript
> session.start(
>   { targetElement: <ANCHOR_ELEMENT>, presentationMode: "auto" },
>   orderPromise
> );
> ```
>
> That variant is **not** the recommended one for the checkout flow covered by this SDD; the canonical pattern is the explicit listener on `<paypal-basic-card-button>` documented above. Any deviation must be validated with the Integration Engineer.

### 20.5 Eligibility pre-check

```javascript
if (!paymentMethods.isEligible("guest")) {
  // Hide the container so the hosted button is not shown to the buyer
  document.querySelector("paypal-basic-card-container").style.display = "none";
  return;
}
```

### 20.6 PCI isolation

The hosted UI lives on `paypal.com`. The practical consequences are:

- The merchant **does not** implement capture iframes, **does not** handle card input events, **does not** validate or transform card data. All card interaction lives in the PayPal domain.
- The merchant backend **does not** receive payload with buyer cardholder data. Its only participation in the flow is to expose Create Order and Capture Order, which operate exclusively with opaque identifiers (`order_id`, `capture_id`).
- The merchant can certify under **SAQ A**.

### 20.7 Expected behavior

1. The buyer clicks `<paypal-basic-card-button>`.
2. PayPal opens its hosted card capture UI.
3. The buyer enters card data and confirms the payment.
4. PayPal processes the charge internally. If the issuing bank requires it, it triggers challenges (3DS or others) transparently to the merchant.
5. The hosted UI closes. The SDK invokes `onApprove(data)` with `data.orderId`.
6. The merchant triggers `POST /api/orders/:id/capture` and handles the response.

> **NOTE:** In the BCDC flow of the v6 SDK covered by this SDD, the merchant **does not** receive or evaluate `liabilityShift` or `enrollment_status`. Any 3DS execution by PayPal is transparent.

---

## 21. Order creation and capture

The merchant backend exposes three routes that act as authenticated proxies to the PayPal REST API:

| Backend route (suggested) | PayPal API | Purpose |
|----------------------------|------------|---------|
| `POST /api/orders` | `POST /v2/checkout/orders` | Create the order with `intent: "CAPTURE"`. |
| `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` | Lookup enriched details (typically post-capture, for reconciliation). |
| `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` | Execute the actual charge. |

### 21.1 Mandatory HTTP headers

| Header | Create Order | Capture Order | Description |
|--------|:-----------:|:-------------:|-------------|
| `Authorization: Bearer <ACCESS_TOKEN>` | Yes | Yes | Bearer token obtained in §11. |
| `Content-Type: application/json` | Yes | Yes | The body is JSON. |
| `PayPal-Request-Id` | `<CREATE_REQUEST_ID>` | `<CAPTURE_REQUEST_ID>` | **Per-operation idempotency.** **Different** key for Create and Capture. The same key is reused only for retries of the **same** request (timeouts or transient `5xx`). |
| `PayPal-Client-Metadata-Id: <CMID>` | Yes | Yes | Links the transaction to the STC context. **Same CMID** in Create and Capture (it is the checkout-session identifier, not the operation's). |

> **MANDATORY — Idempotency (NFR-06):** `<CREATE_REQUEST_ID>` and `<CAPTURE_REQUEST_ID>` keys are independent. Reusing the same key for Create and Capture violates PayPal's idempotency guideline and may produce inconsistent behavior. Each operation has its own key; each key is reused only for retries of the same request. A new transaction produces a new `<CREATE_REQUEST_ID>`; its associated capture produces a new `<CAPTURE_REQUEST_ID>`. See §25.2 for the complete strategy.

### 21.2 Create Order — base payload

```json
{
  "intent": "CAPTURE",
  "application_context": {
    "brand_name":          "<MERCHANT_DISPLAY_NAME>",
    "locale":              "<LOCALE_BCP47>",
    "shipping_preference": "SET_PROVIDED_ADDRESS",
    "user_action":         "PAY_NOW",
    "return_url":          "<MERCHANT_REAL_RETURN_URL>",
    "cancel_url":          "<MERCHANT_REAL_CANCEL_URL>"
  },
  "payer": {
    "email_address": "<BUYER_EMAIL>",
    "name": {
      "given_name": "<BUYER_FIRST_NAME>",
      "surname":    "<BUYER_LAST_NAME>"
    },
    "phone": {
      "phone_type": "MOBILE",
      "phone_number": {
        "national_number": "<PHONE_DIGITS_ONLY>"
      }
    }
  },
  "purchase_units": [
    {
      "invoice_id":  "<MERCHANT_UNIQUE_INVOICE_ID>",
      "custom_id":   "<MERCHANT_INTERNAL_ORDER_ID>",
      "description": "<SHORT_ORDER_DESCRIPTION>",
      "amount": {
        "currency_code": "<CURRENCY_ISO_4217>",
        "value":         "<CART_TOTAL>",
        "breakdown": {
          "item_total": { "currency_code": "<CURRENCY>", "value": "<SUM_UNIT_AMOUNT_X_QTY>" },
          "tax_total":  { "currency_code": "<CURRENCY>", "value": "<SUM_TAX_X_QTY>" },
          "shipping":   { "currency_code": "<CURRENCY>", "value": "<SHIPPING_COST>" },
          "discount":   { "currency_code": "<CURRENCY>", "value": "<DISCOUNT_APPLIED>" }
        }
      },
      "items": [
        {
          "name":        "<PRODUCT_NAME>",
          "description": "<PRODUCT_DESCRIPTION>",
          "sku":         "<CATALOG_SKU>",
          "quantity":    "<QUANTITY>",
          "unit_amount": { "currency_code": "<CURRENCY>", "value": "<UNIT_PRICE_PRE_TAX>" },
          "tax":         { "currency_code": "<CURRENCY>", "value": "<TAX_PER_UNIT>" },
          "category":    "PHYSICAL_GOODS"
        }
      ],
      "shipping": {
        "name":    { "full_name": "<RECIPIENT_FULL_NAME>" },
        "address": {
          "address_line_1": "<STREET_AND_NUMBER>",
          "address_line_2": "<NEIGHBORHOOD_OR_REFERENCE>",
          "admin_area_2":   "<CITY_OR_MUNICIPALITY>",
          "admin_area_1":   "<STATE_CODE>",
          "postal_code":    "<POSTAL_CODE>",
          "country_code":   "<COUNTRY_ISO_ALPHA2>"
        }
      }
    }
  ]
}
```

### 21.3 Justification of each block

| Block | Why it is mandatory in production |
|-------|------------------------------------|
| `intent: "CAPTURE"` | Immediate-charge model covered by this SDD. `AUTHORIZE` requires a deferred-capture flow that is out of scope. |
| `application_context.shipping_preference: SET_PROVIDED_ADDRESS` | Tells PayPal to use the address included in `purchase_units[].shipping`. Improves the quality of risk signals. |
| `application_context.return_url` / `cancel_url` | Required for flows that at some point in the cycle need redirection (e.g. issuer-bank challenges in BCDC). Must be real URLs from the merchant's domain. |
| `payer.email_address`, `payer.name`, `payer.phone` | Identify the buyer for risk evaluation and dispute support. In BCDC, also serve as guest-buyer contact. |
| `invoice_id` | Merchant-unique identifier for accounting reconciliation and logical idempotency. Avoids duplicating orders on retries. |
| `custom_id` | Additional internal ID for the merchant (e.g. order ID in its backoffice). |
| `breakdown` + `items` | The total amount must be **mathematically consistent** with the breakdown and the line items. PayPal validates consistency and rejects with `422` if it does not match. |
| `items[].tax` | Per-line tax, required for `tax_total` to balance. |
| `items[].category` | `PHYSICAL_GOODS`, `DIGITAL_GOODS`, or `DONATION`. Influences risk processing. |
| `shipping.address` | Required when `shipping_preference` is `SET_PROVIDED_ADDRESS`. |

> **NOTE:** The Create Order payload is **identical** for the four payment methods (PayPal, PayLater, PayPal Credit, BCDC). In this integration, the merchant **does not** send `payment_source`. PayPal automatically associates the order with the payment method corresponding to the session constructor that was invoked.

### 21.4 Breakdown validation rules

```
amount.value === item_total + tax_total + shipping − discount
item_total   === Σ (item.unit_amount × item.quantity) per line
tax_total    === Σ (item.tax × item.quantity) per line
```

If the values do not match, PayPal responds with `422 UNPROCESSABLE_ENTITY` with detail of the inconsistent field.

### 21.5 Capture Order

```http
POST {PAYPAL_API_BASE}/v2/checkout/orders/<ORDER_ID>/capture
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
PayPal-Request-Id: <CAPTURE_REQUEST_ID>
PayPal-Client-Metadata-Id: <CMID>

{}
```

> **MANDATORY:** `<CAPTURE_REQUEST_ID>` is an idempotency key **different** from the one used in Create Order. The same `<CAPTURE_REQUEST_ID>` is reused only for retries of the same Capture (timeouts or transient `5xx`). See §25.2.

The response contains `purchase_units[0].payments.captures[0]` with `id` (transaction ID), `status: "COMPLETED"`, `amount`, `create_time`, and `seller_protection`.

### 21.6 Enriched post-capture lookup

After a successful capture, a lookup to `GET /v2/checkout/orders/{id}` returns the order with the enriched `payment_source` (includes card brand and last 4 digits when BCDC applies, or the buyer's `email_address` in PayPal flows). It is the canonical data point to register in the merchant backoffice.

```http
GET {PAYPAL_API_BASE}/v2/checkout/orders/<ORDER_ID>
Authorization: Bearer <ACCESS_TOKEN>
```

### 21.7 Frontend → backend contract and server-side payload construction

#### 21.7.1 Request contract

The frontend **does not** build the Create Order payload. It sends only controlled references that allow the backend to rebuild the payload from trusted state (authenticated cart in session):

| Field | Type | Source | Purpose |
|-------|------|--------|---------|
| `_cmid` | string (1–32 alphanumeric) | Frontend (generated in §12) | `PayPal-Client-Metadata-Id` header and STC URL. |
| `paymentMethod` | enum (`paypal` / `paylater` / `credit` / `guest`) | Frontend (per the button clicked) | Telemetry and validation. |
| `cartId` | string | Frontend (cart state already held by the merchant in session) | Reference to the authenticated cart for server-side payload reconstruction. |

> **MANDATORY:** The frontend **does not** send amount, items, breakdown, buyer data, or shipping address. These are obtained on the backend from `cartId` and the user's authenticated session. Accepting amounts sent by the client exposes the merchant to price manipulation and inconsistencies between what is charged and what is invoiced.

#### 21.7.2 Frontend — `createOrder` callback

```javascript
async function createOrder({ paymentMethod }) {
  const response = await fetch("/api/orders", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      _cmid:         cmid,
      paymentMethod: paymentMethod,
      cartId:        getCurrentCartId()
    })
  });

  if (!response.ok) {
    throw new Error(`Create Order failed: ${response.status}`);
  }

  const order = await response.json();
  return { orderId: order.id }; // Shape required by the v6 SDK
}
```

#### 21.7.3 Backend — `POST /api/orders`

The backend executes four steps in strict order: validation, STC (non-blocking), payload construction from trusted state, and Create Order with per-operation idempotency.

```javascript
app.post("/api/orders", async (req, res) => {
  const { _cmid, paymentMethod, cartId } = req.body;

  // 1) Input validation
  if (!isValidCMID(_cmid))                       return res.status(400).json({ error: "invalid cmid" });
  if (!isAllowedPaymentMethod(paymentMethod))    return res.status(400).json({ error: "invalid paymentMethod" });
  const cart = await loadCartForUser(cartId, req.user); // validates ownership
  if (!cart)                                     return res.status(404).json({ error: "cart not found" });

  // 2) Server-side STC, sequenced, non-blocking
  try {
    await callSTC({
      cmid: _cmid,
      additionalData: buildAdditionalDataFromTrustedState(req.user)
    });
  } catch (err) {
    logger.warn({ err, cmid: _cmid }, "STC failed; continuing checkout");
  }

  // 3) Build payload from trusted state
  const orderPayload = buildOrderPayloadFromTrustedState({ cart, user: req.user });

  // 4) Create Order with per-operation idempotency
  const accessToken     = await getAccessToken();
  const createRequestId = await getOrCreateCreateRequestId(cartId); // same UUID on retries of the SAME Create

  const response = await fetch(`${process.env.PAYPAL_API_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Authorization":             `Bearer ${accessToken}`,
      "Content-Type":              "application/json",
      "PayPal-Request-Id":         createRequestId,
      "PayPal-Client-Metadata-Id": _cmid
    },
    body: JSON.stringify(orderPayload)
  });

  const body = await response.json();

  // Persist { orderId, cartId, _cmid, createRequestId } for future retries / capture
  if (response.ok) {
    await persistOrderContext({ orderId: body.id, cartId, cmid: _cmid, createRequestId });
  }

  res.status(response.status).json(body);
});
```

> **NOTE:** The `_` prefix in `_cmid` is a convention indicating an internal control field between frontend and backend, **not** part of the payload that travels to PayPal.

> **MANDATORY:** `getOrCreateCreateRequestId(cartId)` must return **the same UUID** on Create Order retries for the same `cartId` (see §25.2 for the complete idempotency strategy).

### 21.8 Reference implementation — `POST /api/orders/:id/capture`

The capture uses an **idempotency key different** from the Create Order one. The frontend sends `_cmid` in the body so the backend can inject `PayPal-Client-Metadata-Id`.

```javascript
app.post("/api/orders/:id/capture", async (req, res) => {
  const { id } = req.params;
  const { _cmid } = req.body || {};
  if (!isValidCMID(_cmid)) return res.status(400).json({ error: "invalid cmid" });

  const accessToken      = await getAccessToken();
  const captureRequestId = await getOrCreateCaptureRequestId(id); // same UUID on retries of the SAME Capture

  const response = await fetch(
    `${process.env.PAYPAL_API_BASE}/v2/checkout/orders/${id}/capture`,
    {
      method: "POST",
      headers: {
        "Authorization":             `Bearer ${accessToken}`,
        "Content-Type":              "application/json",
        "PayPal-Request-Id":         captureRequestId,
        "PayPal-Client-Metadata-Id": _cmid
      },
      body: "{}"
    }
  );

  res.status(response.status).json(await response.json());
});
```

> **MANDATORY:** `createRequestId` and `captureRequestId` are **independent** keys. Reusing the same key for Create and Capture violates PayPal's idempotency guideline (see §25.2, NFR-06).

---

# Part IV — Integration and operations

## 22. End-to-end orchestration

The complete integration breaks down into five moments. The distinction matters because it defines **what runs once** vs **what runs on every charge attempt**.

### 22.1 Moment 1 — Checkout initialization (once per session)

```
1. cmid = generateCMID()                                                [§12]
2. { clientId, sdkUrl } = GET /api/config                               [§10.4]
3. await loadSDK(sdkUrl)                                                [§14.3]
4. sdkInstance = await paypal.createInstance({ clientId, components,
                                              pageType, locale })      [§15.1]
5. paymentMethods = await sdkInstance.findEligibleMethods({
                       currencyCode })                                  [§15.2]
6. If paymentMethods.isEligible('paylater'):
       paylaterDetails = paymentMethods.getDetails('paylater')          [§15.3]
7. Build the sessions (each with its callbacks):                        [§17, §18, §19, §20]
       paypalSession   = sdkInstance.createPayPalOneTimePaymentSession({...})
       paylaterSession = sdkInstance.createPayLaterOneTimePaymentSession({...})
       creditSession   = sdkInstance.createPayPalCreditOneTimePaymentSession({...})
       guestSession    = sdkInstance.createPayPalGuestOneTimePaymentSession({...})
8. Render/show only the buttons whose method is eligible.               [§16.1]
9. Attach addEventListener('click', ...) to each button using the
   correct activation pattern.                                          [§16.2]
```

### 22.2 Moment 2 — Buyer click (no `await` before `start`)

```
btn.addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod });   // no await
  session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

`createOrder({ paymentMethod })` (frontend) internally:

```
a) POST /api/orders
   body = { _cmid: cmid, paymentMethod, cartId }
b) return { orderId: order.id }
```

The backend, inside `POST /api/orders`, runs in strict order:

```
1) Validate _cmid, paymentMethod, and ownership of cartId.
2) await callSTC({ cmid, additionalData })            // §13 — try/catch, non-blocking
3) Build orderPayload from trusted state              // §21.7
4) createRequestId = getOrCreateCreateRequestId(cartId)
5) POST /v2/checkout/orders + headers:
       PayPal-Request-Id:         <CREATE_REQUEST_ID>
       PayPal-Client-Metadata-Id: <CMID>
6) Persist { orderId, cartId, _cmid, createRequestId }
7) Reply to the frontend with { id: orderId }
```

### 22.3 Moment 3 — Approval (`onApprove` callback)

```
onApprove(data) {
  const result = await captureOrder(data.orderId);
  showSuccess(result);
}
```

### 22.4 Moment 4 — Capture

```
POST /api/orders/<ORDER_ID>/capture + body._cmid = cmid
   → backend internally:
       captureRequestId = getOrCreateCaptureRequestId(orderId)
       injects headers:
           PayPal-Request-Id:         <CAPTURE_REQUEST_ID>   ← different from Create
           PayPal-Client-Metadata-Id: <CMID>                  ← same session CMID
```

### 22.5 Moment 5 — Enriched lookup and backoffice registration

```
GET /api/orders/<ORDER_ID>
   → enriched response with payment_source and capture data.
Persist in the merchant backoffice: order_id, capture_id, status,
payment_source, invoice_id, custom_id, CMID, createRequestId, captureRequestId.
```

### 22.6 Mnemonic rule

| Component | Frequency |
|-----------|-----------|
| **CMID** | Once per checkout session. Reused in STC, Create, and Capture. |
| **`createInstance` + `findEligibleMethods`** | Once per checkout session (after loading the SDK). |
| **Server-side STC** | Before each Create Order, inside the `POST /api/orders` handler. |
| **`createRequestId`** | One UUID per Create Order intent (typically per `cartId`). Reused on retries of the **same** Create. |
| **`captureRequestId`** | One UUID per Capture Order intent (typically per `orderId`). Reused on retries of the **same** Capture. **Different** from `createRequestId`. |
| **`PayPal-Client-Metadata-Id`** | Same CMID on Create and Capture. |
| **`session.start(...)`** | Once per charge attempt, inside the click handler, with no preceding `await`. |

---

## 23. Integration points (endpoint map)

| Operation | Merchant backend (suggested) | PayPal API |
|-----------|------------------------------|------------|
| Public configuration for the frontend | `GET /api/config` | — (does not reach PayPal) |
| OAuth token (internal backend use) | (internal) | `POST /v1/oauth2/token` |
| Set Transaction Context (internal use, called from `POST /api/orders`) | (internal) | `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` |
| Create order (includes server-side STC and payload construction) | `POST /api/orders` | `POST /v2/checkout/orders` |
| Lookup order | `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` |
| Capture order | `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` |

> **NOTE:** A public `/api/stc` endpoint is not exposed to the frontend. STC runs server-side inside `POST /api/orders` (§13.5, §21.7) to guarantee the strict STC → Create Order order and so the frontend has no knowledge of the risk flow.

---

## 24. Security considerations

This section consolidates security decisions scattered throughout the design. Each control responds to one or more NFRs from §8.

### 24.1 Credential custody (NFR-02)

| Asset | Storage | Transmission |
|-------|---------|--------------|
| `PAYPAL_CLIENT_SECRET` | Backend environment variable, managed by a secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, etc.). Never in source code. | Backend only → `/v1/oauth2/token` encoded in `Authorization: Basic`. |
| `PAYPAL_MERCHANT_ID` | Backend environment variable. | Backend only → STC URL. |
| `access_token` | Backend process memory. Cache with TTL lower than `expires_in`. Never persisted. | Backend only → PayPal REST API in `Authorization: Bearer`. |

### 24.2 PCI isolation (NFR-01)

- In PayPal, PayLater, and Credit, the flow does not involve buyer card data from the merchant's perspective: the buyer authenticates with their PayPal account or accepts the financing offer in the PayPal-hosted UI.
- In BCDC, the buyer's cardholder data is captured entirely in the PayPal-hosted UI. It never enters the merchant DOM or backend.
- The merchant can certify under **SAQ A**.

### 24.3 Transport (NFR-03)

- TLS 1.2 minimum in production.
- HSTS recommended.
- Certificates with valid trust chain; automated renewal.

### 24.4 Content Security Policy (NFR-04)

Recommended minimum CSP for the checkout domain:

```
script-src   'self' https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com;
frame-src    https://www.paypal.com;
connect-src  'self' https://api-m.paypal.com https://api-m.sandbox.paypal.com;
img-src      'self' https://www.paypalobjects.com data:;
style-src    'self' https://www.paypalobjects.com 'unsafe-inline';
```

In Sandbox environments, additionally add `https://www.sandbox.paypal.com` to `script-src` and `frame-src`.

### 24.5 Logging and handling of sensitive data (NFR-08)

Allowed in logs:

- `order_id`, `capture_id`, `invoice_id`, `custom_id`, `CMID`, `createRequestId`, `captureRequestId`.
- Capture `status`, PayPal error code, and validation messages.
- Name of the chosen payment method (`paypal`, `paylater`, `credit`, `guest`).

**Forbidden** in logs:

- `access_token`, `client_secret`, `merchant_id`, full `Authorization` header.
- PayPal response bodies with unmasked secrets (when logging responses, mask `access_token`, `nonce`, `app_id`).
- Enriched responses from `GET /v2/checkout/orders/{id}` that include partial card fields returned by PayPal (e.g. brand and last 4 digits for reconciliation), if the merchant chooses to log them: apply masking or limit them to strictly necessary fields.

> **NOTE:** The merchant **does not capture** PAN, CVV, or expiration date from the buyer in any flow, so those data cannot leak accidentally from the merchant's code. The logging rule focuses on protecting **backend secrets** (credentials and tokens) and on masking the partial card data that PayPal may return post-capture.

### 24.6 Backend input validation

The backend must validate before forwarding to PayPal:

- That `_cmid` received from the frontend is an alphanumeric identifier between 1 and 32 characters, with no hyphens or separators (validation rule from §12.3).
- That the payload's amount, currency, and breakdown are consistent with the user's authenticated cart (do not trust values sent by the client).
- That `invoice_id` corresponds to a valid order for the user in session (avoid IDOR).
- That `paymentMethod` declared by the frontend belongs to the allowed set (`paypal`, `paylater`, `credit`, `guest`).

### 24.7 Frontend isolation

The frontend must know only:

- `client_id` (public, via `GET /api/config`).
- `/api/*` URLs of the merchant backend.
- `order_id` and `capture_id` (opaque references).

The frontend **must not** know:

- `client_secret`, `merchant_id`, `access_token`.
- `api-m.paypal.com` URLs (it must not build direct requests to the PayPal REST API).

---

## 25. Operational considerations

### 25.1 Metrics and observability

Minimum metrics to instrument in production:

| Metric | Granularity | Suggested alarm |
|--------|-------------|-----------------|
| `POST /v1/oauth2/token` success rate | Per minute | < 99% over a 5-min window. |
| Create Order and Capture Order p95 latency | Per minute | Exceeds internal SLO. |
| STC `≠ 200` response rate | Per minute | > 5% over a 5-min window (does not block, but degrades risk). |
| Capture success rate by method (PayPal, PayLater, Credit, BCDC) | Per hour | Anomaly vs historical baseline. |
| `onCancel` rate by method | Per hour | Unusual peak suggests UI friction. |
| `onError` rate by method | Per hour | Indicates technical problem (SDK, network, configuration). |
| `UNPROCESSABLE_ENTITY` rate on Create Order | Per minute | > 0.5% indicates a bug in breakdown construction. |
| Empty-eligibility rate (`findEligibleMethods` with no methods) | Per hour | Unusual peak suggests a configuration or market issue. |

### 25.2 Idempotency (NFR-06)

PayPal applies idempotency **per operation**: each REST API call has its own `PayPal-Request-Id` key, and the same key is reused only on retries of the **same** request. Reusing the same key across different operations (for example, between Create and Capture) violates the official guideline.

#### 25.2.1 Per-operation keys

| Operation | Recommended key | Reuse |
|-----------|-----------------|-------|
| Create Order | `createRequestId` (UUID generated server-side, associated with `cartId`) | Retries of the same Create (timeouts, network errors, transient `5xx`). |
| Capture Order | `captureRequestId` (UUID generated server-side, associated with `orderId`) | Retries of the same Capture. |
| New order | New `createRequestId` | Even though the CMID may be preserved within the same checkout session. |
| New capture against a new order | New `captureRequestId` | — |

#### 25.2.2 Recommended strategy

1. **`createRequestId`** is generated the first time the frontend invokes `POST /api/orders` for a given `cartId`. The backend persists the association `<cartId> → <createRequestId>` for the lifetime of the checkout.
2. If the frontend retries `POST /api/orders` for the same `cartId` (timeout or `5xx`), the backend returns the same `createRequestId` and therefore the same order.
3. **`captureRequestId`** is generated the first time the frontend invokes `POST /api/orders/:id/capture` for a given `orderId`. The backend persists `<orderId> → <captureRequestId>`.
4. If the frontend retries the Capture, the backend returns the same `captureRequestId` and PayPal returns the previous capture.
5. Both `createRequestId` and `captureRequestId` must be persisted alongside the order in the merchant backoffice for audit and to support retries throughout the lifecycle.

#### 25.2.3 Reference implementation

```javascript
// Helpers that materialize the per-operation idempotency rule
async function getOrCreateCreateRequestId(cartId) {
  const existing = await store.get(`create-request-id:${cartId}`);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await store.set(`create-request-id:${cartId}`, id, { ttl: CHECKOUT_TTL });
  return id;
}

async function getOrCreateCaptureRequestId(orderId) {
  const existing = await store.get(`capture-request-id:${orderId}`);
  if (existing) return existing;
  const id = crypto.randomUUID();
  await store.set(`capture-request-id:${orderId}`, id, { ttl: ORDER_TTL });
  return id;
}
```

> **MANDATORY:** Do not use the same UUID for Create and Capture. The per-operation separation aligns with PayPal's [official idempotency guidelines](https://developer.paypal.com/reference/guidelines/idempotency/) and prevents undefined behavior.

### 25.3 Fault tolerance

| Service | Strategy |
|---------|----------|
| `POST /v1/oauth2/token` | Retry once after `401/5xx`; if it persists, abort and alert (the integration stops working). |
| `POST /v2/checkout/orders` | Retry with the same `createRequestId` on `5xx` or transient network errors. |
| `POST /v2/checkout/orders/{id}/capture` | Same as Create Order. |
| `PUT /v1/risk/transaction-contexts/...` (STC) | **Do not** retry. Log the failure and continue checkout. |
| Loading the v6 SDK | If the `<script>` does not load, disable payment buttons and show a degradation message to the user. Client-side telemetry to detect incidents on PayPal domains. |

### 25.4 Credential rotation

- `PAYPAL_CLIENT_SECRET`: rotation coordinated with the PayPal Developer Dashboard. The rotation invalidates the cached `access_token`; the system must refresh it automatically upon the first `401`.
- `PAYPAL_CLIENT_ID`: changes very rarely. Any change requires updating the `clientId` the frontend receives from `GET /api/config`. Because `clientId` is used in `paypal.createInstance(...)`, a rotation forces a page reload so the SDK reinitializes with the new value.

### 25.5 Sandbox → Live promotion

| Item | Change |
|------|--------|
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` → `https://api-m.paypal.com` |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` → `https://www.paypal.com/web-sdk/v6/core` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Live app credentials, **not** Sandbox. |
| `PAYPAL_MERCHANT_ID` | Merchant ID of the Live account. |
| `application_context.return_url` / `cancel_url` | Real URLs from the merchant production domain. |
| STC `additional_data` | Real authenticated user data, not test values. |
| CSP | Add/remove Sandbox domains as needed. |

### 25.6 Runtime environment-switching rules

> **MANDATORY:** The v6 SDK registers *custom elements* upon initialization. It is **not possible** to switch between Sandbox and Live without reloading the page. The environment selection must be made at backend startup (environment variable) and remain stable for the entire buyer session.

---

# Part V — Validation and governance

## 26. Testing strategy and Sandbox environment

The test plan must be executed in full in the Sandbox environment before Live promotion.

### 26.1 Sandbox environment configuration

| Variable | Sandbox value |
|----------|---------------|
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Credentials of the **Sandbox** app (Developer Dashboard). |
| `PAYPAL_MERCHANT_ID` | Merchant ID of the Sandbox account. |

### 26.2 Sandbox buyer accounts

For PayPal, PayLater, and PayPal Credit testing, the merchant must have Sandbox buyer accounts created from the Developer Dashboard. PayPal assigns each Sandbox buyer account:

- An email and password to authenticate in the hosted UI.
- A simulated balance.
- One or more associated cards (for flows in which the buyer chooses a card inside their PayPal account).

### 26.3 Sandbox cards for BCDC

For BCDC testing, PayPal publishes a set of Sandbox cards. Common rules:

- **Expiration date:** any future date.
- **Card security code:** any 3-digit value (4 digits for Amex). The buyer (or QA acting as a buyer) enters it in the PayPal Sandbox-hosted UI; it never reaches the merchant.
- **Cardholder name:** free.

> **NOTE:** The current set of Sandbox cards must be consulted in PayPal Developer's official documentation. PayPal may update the published set.

### 26.4 Minimum test cases (matrix)

| ID | Case | Expected result | Meets FR |
|----|------|------------------|----------|
| TC-01 | Pay with PayPal account (valid Sandbox account) | Successful capture, `purchase_units[0].payments.captures[0].status === "COMPLETED"`. | FR-01, FR-04, FR-05 |
| TC-02 | Pay with PayLater in eligible market | Successful capture. | FR-03, FR-05 |
| TC-03 | Pay with PayPal Credit in eligible market | Successful capture. | FR-03, FR-05 |
| TC-04 | Pay by card via BCDC (valid Sandbox card) | Successful capture. DOM and network inspection confirms that no merchant payload contains buyer cardholder data. Capture happens in the PayPal-hosted UI. | FR-02, FR-04, FR-05, NFR-01 |
| TC-05 | Cancellation by the buyer (`onCancel`) | UI shows a sober message, capture is not invoked. | FR-11 |
| TC-06 | Technical error during the session (`onError`) | UI shows actionable message, log with error detail. | FR-11 |
| TC-07a | Technical retry of Create on timeout/`5xx` (same `cartId`) | Same CMID, **same `createRequestId`**, same `orderId` returned (idempotent operation). | NFR-06 |
| TC-07b | New buyer attempt after rejection or cancellation (same cart) | Same CMID if still in the same session, **new `createRequestId`**, new order. | FR-09 |
| TC-08 | Idempotent retry of Capture (same `captureRequestId` for the same `orderId`) | PayPal returns the previous capture, no duplicate generated. | NFR-06 |
| TC-09 | STC responds 400 | Checkout is not interrupted; order is created correctly. | FR-07, NFR-05 |
| TC-10 | Eligibility inspection: market without PayLater | PayLater button is not rendered. | FR-12, NFR-12 |
| TC-11 | Eligibility inspection: currency without PayPal Credit | PayPal Credit button is not rendered. | FR-12, NFR-12 |
| TC-12 | Transient activation validation | The PayPal pop-up/modal opens without browser blocking on Chrome, Firefox, Safari, and Edge. | FR-06, NFR-14 |
| TC-13 | `GET /api/config` does not expose secrets | Response contains `clientId` and `sdkUrl`; does not contain `client_secret`, `merchant_id`, or `access_token`. | NFR-02 |
| TC-14 | CSP validation | Loading the SDK and opening the hosted UI produce no CSP violations in the console. | NFR-04 |
| TC-15 | Sandbox → Live environment switch | After changing environment variables and reloading the page, the SDK operates against the correct environment. | §25.5, §25.6 |
| TC-16 | CMID validation | Network inspection confirms the same CMID in STC, in `PayPal-Client-Metadata-Id` of Create Order, and in that of Capture Order. | FR-08 |

### 26.5 Recommended manual checks

- **DevTools → Network:** confirm that no browser call goes directly to `api-m.paypal.com`. All business calls go to `/api/*` of the backend.
- **DevTools → Network:** confirm that the `GET /api/config` response does not contain `client_secret`, `access_token`, or `merchant_id`.
- **DevTools → Application → Storage:** confirm that the `access_token` is not persisted in `localStorage`, `sessionStorage`, or merchant cookies.
- **DevTools → Console:** confirm the absence of CSP violations on checkout startup and when triggering sessions.
- **Backend → Logs:** confirm that no log contains `access_token`, `client_secret`, or the full `Authorization` header. Masked values must preserve the prefix and replace the rest. (Buyer cardholder data should not appear in logs because the merchant does not receive it; any appearance indicates a serious bug or an enriched PayPal field that was not masked.)

---

## 27. REST vs SDK naming conventions

The inconsistency between `snake_case` (REST) and `camelCase` (SDK) is a frequent cause of bugs in integrations that mix both layers. Equivalence table for this integration:

| Concept | REST API (`snake_case`) | JavaScript SDK v6 (`camelCase`) |
|---------|-------------------------|---------------------------------|
| Order identifier | `id` (in response) / `order_id` (in internal headers) | `orderId` (in `data.orderId` of `onApprove`) |
| Currency code | `currency_code` | `currencyCode` |
| Country code | `country_code` | `countryCode` |
| SDK component | (N/A in REST) | `components: ['paypal-payments', 'paypal-guest-payments']` |
| Page type | (N/A in REST) | `pageType: 'checkout'` |
| PayPal client identifier | `client_id` (in OAuth form-encoded body) | `clientId` (in `createInstance`) |
| UI presentation mode | (N/A in REST) | `presentationMode: 'auto'` |
| BCDC anchor element (custom element) | (N/A in REST) | `<paypal-basic-card-button>` registered by the SDK |
| Risk correlation header | `PayPal-Client-Metadata-Id` (HTTP header) | (N/A in SDK; injected server-side) |
| Idempotency header | `PayPal-Request-Id` (HTTP header, per-operation key) | (N/A in SDK; injected server-side) |

> **Mental rule:** If the data leaves or enters a REST endpoint (JSON body or HTTP headers), it is `snake_case` or `Pascal-Case` with hyphens (in headers). If you pass it to a method of the `paypal.*` object or receive it in an SDK callback, it is `camelCase`.

---

## 28. Assumptions, dependencies, and constraints

### 28.1 Assumptions

| ID | Assumption |
|----|------------|
| **A-01** | The merchant has a backend under its control where it can custody `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, and issue the `access_token`. |
| **A-02** | The merchant has a user authentication system and a cart service that produces a mathematically consistent breakdown. |
| **A-03** | The target market supports the configured currency and the eligibility of the desired payment methods (PayPal, PayLater, Credit, BCDC). |
| **A-04** | The buyer uses a modern browser with support for pop-ups, *transient activation*, ES2017+, and CSP. |
| **A-05** | The PayPal account has the commercial entitlements listed in §10.1 enabled. |
| **A-06** | The merchant manages the Sandbox → Live environment switch via backend environment variables; no runtime alternation is required. |

### 28.2 External dependencies

| ID | Dependency | Type |
|----|------------|------|
| **D-01** | PayPal REST API (`api-m.paypal.com`, `api-m.sandbox.paypal.com`). | Critical — blocking. |
| **D-02** | PayPal Web SDK v6 (`https://www.paypal.com/web-sdk/v6/core` and its Sandbox equivalent). | Critical — blocking. |
| **D-03** | OAuth2 endpoint (`/v1/oauth2/token`). | Critical — without it there is no `access_token`. |
| **D-04** | STC endpoint (`/v1/risk/transaction-contexts`). | Recommended — non-blocking. |
| **D-05** | Domains `www.paypal.com`, `www.paypalobjects.com`, `c.paypal.com` (and Sandbox equivalents) accessible from the buyer browser and allowed in CSP. | Critical — the hosted UI lives on these domains. |

### 28.3 Constraints

| ID | Constraint |
|----|------------|
| **R-01** | The v6 SDK does not accept query string parameters in its URL nor `data-*` configuration attributes. All configuration goes through `createInstance(...)`. |
| **R-02** | The v6 SDK registers *custom elements* and cannot be re-initialized in the same page. Switching environment (Sandbox ↔ Live) requires a reload. |
| **R-03** | The `createOrder` callback cannot be `await`-ed inside the click handler; the mandatory pattern is to build the promise and pass it immediately to `session.start(...)`. |
| **R-04** | The canonical BCDC flow is activated with an `addEventListener('click', ...)` on `<paypal-basic-card-button>`, without `targetElement`. The variant with `targetElement` (programmatic-open / auto-start) is valid but is outside this SDD's canonical flow and requires Integration Engineer validation. |
| **R-05** | The CMID is unique per checkout session and must not be reused across buyers or different sessions. |
| **R-06** | `PayPal-Request-Id` is managed with **per-operation independent keys**: `createRequestId` for Create Order, `captureRequestId` for Capture Order. Each key is reused only for retries of the **same** request. |
| **R-07** | `client_secret` and `merchant_id` cannot, under any circumstance, reach the browser. |
| **R-08** | The integration covered by this SDD uses exclusively `intent: "CAPTURE"`. `AUTHORIZE` is out of scope. |

---

## 29. Risks and mitigations

| ID | Risk | Probability | Impact | Mitigation |
|----|------|:-----------:|:------:|------------|
| **RG-01** | Exposure of `PAYPAL_CLIENT_SECRET` via accidental commit to the repository. | Medium | Critical | Pre-commit hooks that detect secret patterns; secrets manager; mandatory security review. Immediate rotation plan if exposure is detected. |
| **RG-02** | Exposure of `access_token` to the frontend via a bug in `GET /api/config` or in the `/api/*` response wrapper. | Low | Critical | Automated tests validating that responses do not contain `access_token`, `client_secret`, or `merchant_id`; mandatory code review; centralized masking on the backend. |
| **RG-03** | Pop-up blocked due to accidental consumption of *transient activation* (`await` before `session.start`). | **High** | High | Code review with explicit checklist; custom lint rule; E2E test confirming pop-up opens without requiring extra user interaction. |
| **RG-04** | BCDC with incorrect markup (own HTML button instead of `<paypal-basic-card-button>`, or `'paypal-guest-payments'` component missing in `createInstance`) → custom elements do not hydrate or session fails to activate. | Medium | High | E2E test verifying that `<paypal-basic-card-button>` is present, hydrated, and triggers the session. Startup validation that `'paypal-guest-payments'` is in `components`. |
| **RG-05** | Mixed Sandbox/Live credentials (cross-environment). | Low | Critical | Validation of the `CLIENT_ID` and `PAYPAL_API_BASE` prefixes at backend startup; alarm if there is incoherence between variables of the same block. |
| **RG-06** | Duplicated Order or Capture due to retry without idempotency, or key reused across operations. | Medium | High | Per-operation separate keys (`createRequestId`, `captureRequestId`), persisted server-side and reused only on retries of the **same** request (§21.1, §25.2). E2E test validating idempotent retries and a test validating that Create and Capture keys differ. |
| **RG-07** | Buttons of non-eligible methods rendered to the buyer. | Medium | Medium | Mandatory filtering by `findEligibleMethods` before rendering (§15.2). Per-market E2E test. |
| **RG-08** | CSP failure that blocks loading of the SDK or the hosted UI. | Medium | High | CSP tested in staging per environment (Sandbox and Live); detection fallback and clear user message if scripts do not load. |
| **RG-09** | Checkout blocked by an STC error (NFR-05 violation). | Low | Critical | STC implemented as non-blocking with `try/catch` and 200 response guaranteed to the frontend (§13.5.1). QA test: TC-09. |
| **RG-10** | SDK initialization against the wrong environment (URL or `client_id` crossed). | Low | Critical | `GET /api/config` is the only source of `clientId` and `sdkUrl` for the frontend; the backend validates coherence between `PAYPAL_API_BASE`, `PAYPAL_SDK_URL`, and credentials. |
| **RG-11** | SDK re-initialization in the same page on environment switch → custom-element conflict. | Low | High | Force page reload on environment switch; document the constraint for the operations team. |
| **RG-12** | Inconsistent `breakdown` → `422 UNPROCESSABLE_ENTITY`. | Medium | Medium | Pure function on the backend that builds `breakdown` and `items` with mathematical validation prior to sending. |
| **RG-13** | Logs leak backend secrets (`access_token`, `client_secret`) or partial card fields returned by PayPal post-capture without masking. | Medium | Critical | Logging wrapper that applies default masking to sensitive keys (`access_token`, `nonce`, `app_id`, `Authorization`); observability pipeline review. |
| **RG-14** | Merchant changes the `clientId` without reloading the page → SDK left with a stale instance. | Low | Medium | `clientId` changes always trigger a reload (`location.reload()` or navigation). |

---

## 30. Acceptance criteria and pre-production checklist

Before promoting the solution to Live, all the following criteria must be met.

### 30.1 Security

- [ ] `PAYPAL_CLIENT_SECRET` resides only in backend environment variables; never included in versioned source code or sent to the browser.
- [ ] `PAYPAL_MERCHANT_ID` resides only in backend environment variables.
- [ ] Configuration files with credentials (`.env`, equivalents) excluded from version control.
- [ ] The backend exposes only `clientId` and `sdkUrl` to the frontend via `GET /api/config`; never `access_token`, `client_secret`, or `merchant_id`.
- [ ] Logs do not record `access_token`, `client_secret`, full `Authorization` headers, or unmasked partial card fields returned by PayPal post-capture.
- [ ] Content Security Policy allows `https://www.paypal.com`, `https://www.paypalobjects.com`, and `https://c.paypal.com` (and their Sandbox equivalents when applicable).
- [ ] TLS 1.2+ enabled in production.

### 30.2 Configuration

- [ ] `PAYPAL_API_BASE` points to `https://api-m.paypal.com` in Live.
- [ ] `PAYPAL_SDK_URL` points to `https://www.paypal.com/web-sdk/v6/core` in Live.
- [ ] `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_MERCHANT_ID` correspond to the Live environment.
- [ ] `application_context.return_url` and `cancel_url` are real, accessible URLs from the merchant domain.
- [ ] The SDK `<script>` includes no `data-*` attributes or query string parameters.
- [ ] The `components` array of `createInstance` contains exactly `['paypal-payments', 'paypal-guest-payments']` (or the subset the merchant exposes).

### 30.3 Functional

- [ ] `findEligibleMethods` is invoked at every checkout initialization and only buttons whose methods are eligible are rendered.
- [ ] The click handler of every button **does not** contain `await` before `session.start(...)`.
- [ ] BCDC: the HTML contains `<paypal-basic-card-container>` with `<paypal-basic-card-button>` inside; the click listener is on `<paypal-basic-card-button>` and `session.start(...)` is invoked with `{ presentationMode: 'auto' }` (without `targetElement`).
- [ ] `breakdown` and `items` reflect the actual cart state and meet the rules of §21.4.
- [ ] `PayPal-Request-Id`: **independent** keys per operation (`createRequestId` and `captureRequestId`). Each is reused only on retries of the same request; the same key is never reused across Create and Capture.
- [ ] Error handling implemented in `onError`, `onCancel`, and (in BCDC) `onWarn`.
- [ ] `payer`, `shipping`, and `purchase_units` data come from the checkout state, not from placeholders.
- [ ] After capture, the merchant backoffice records `order_id`, `capture_id`, `status`, CMID, `createRequestId`, `captureRequestId`, `invoice_id`, and `custom_id`.

### 30.4 Risk

- [ ] CMID generated once per checkout session, propagated between frontend and backend.
- [ ] STC is called before **every** Create Order (regardless of method).
- [ ] STC `additional_data` comes from the buyer's authenticated session.
- [ ] STC does not block the checkout: errors are logged and the transaction continues.
- [ ] `PayPal-Client-Metadata-Id` header present on Create Order and Capture Order, with the same CMID.

### 30.5 Testing

- [ ] Test case matrix TC-01 to TC-16 executed and green in Sandbox.
- [ ] DevTools inspection confirms no browser call goes directly to `api-m.paypal.com`.
- [ ] DevTools inspection confirms `GET /api/config` does not expose `access_token`, `client_secret`, or `merchant_id`.
- [ ] Manual tests on Chrome, Firefox, Safari, and Edge confirm the pop-up/modal opens without blocking on the four methods.

### 30.6 Operations

- [ ] Metrics from §25.1 instrumented and connected to the observability system.
- [ ] Alarms configured for the suggested thresholds.
- [ ] Incident runbook documented: OAuth failure, Create Order failure, capture-rate anomaly per method, SDK outage.
- [ ] `CLIENT_SECRET` rotation plan documented and tested in Sandbox.
- [ ] Documented procedure for Sandbox → Live promotion (§25.5) and for coordinated environment-variable changes.

---

# Appendices

## Appendix A — Common errors troubleshooting

| Symptom | Most likely cause | How to diagnose |
|---------|-------------------|-----------------|
| `401 Unauthorized` on `/v1/oauth2/token` | `CLIENT_ID` / `CLIENT_SECRET` mistyped or cross-environment (Sandbox vs Live). | Verify that `PAYPAL_API_BASE`, `PAYPAL_SDK_URL`, and credentials all correspond to the **same environment**. |
| The PayPal pop-up gets blocked by the browser | The click handler contains `await` before `session.start(...)`, consuming *transient activation*. | Inspect the handler: the Create Order promise must be built and immediately passed to `session.start(...)` without preceding `await` (§16.2). |
| BCDC: `<paypal-basic-card-button>` does not render or remains inert | The `'paypal-guest-payments'` component is not included in `components` of `createInstance(...)`, or the custom-element HTML was mounted before the SDK finished loading. | Confirm `'paypal-guest-payments'` is in `components`. Make sure to call `createInstance(...)` before showing the container. |
| BCDC: the click does not trigger the session | The listener was attached to the wrong element (e.g. to `<paypal-basic-card-container>` instead of `<paypal-basic-card-button>`), or the element was replaced by the SDK after attaching the listener. | Attach the listener to `<paypal-basic-card-button>` after the SDK has hydrated the custom elements. |
| `findEligibleMethods` returns an empty set for the market | `client_id` + `currencyCode` + buyer country combination without sufficient entitlements. | Verify commercial entitlement in the Developer Dashboard; verify `currencyCode` ISO 4217; consult the Integration Engineer. |
| PayLater button rendered but the session fails to activate | It was rendered without validating `paymentMethods.isEligible('paylater')`. | Filter by `isEligible(...)` before showing each button (§15.2). |
| `422 UNPROCESSABLE_ENTITY` on Create Order | `breakdown` does not match `amount.value` and/or items sum. | Apply the rules of §21.4 manually; PayPal returns the specific inconsistent field in the response. |
| Capture executes twice on a browser retry | The backend generates a new `captureRequestId` on every call instead of looking it up in its store by `orderId`. | Implement `getOrCreateCaptureRequestId(orderId)` with persistence to return the same UUID on retries of the same Capture (§25.2). |
| Contradictory messages when retrying Create after a timeout | The backend generates a new `createRequestId` on retry → PayPal creates an additional order. | Persist `createRequestId` per `cartId` and reuse it on retries of the same Create (§25.2). |
| Switching environment (Sandbox ↔ Live) leaves the page broken | An attempt was made to re-initialize the SDK without reloading the page. | Force a reload (`location.reload()`) after changing environment variables (§14.4, §25.6). |
| `GET /api/config` returns `access_token` or `client_secret` | Bug in the endpoint implementation: the full configuration object is serialized. | Implement a field allow-list (`{ clientId, sdkUrl }`) instead of `res.json(config)` directly (§24.1, RG-02). |
| STC responds 400 | Wrong field type in `additional_data`. | Validate formats per §13.3 (especially `sender_create_date` and `sender_phone`). |
| STC responds 401 | Wrong `MERCHANT_ID`, expired `access_token`, or no permission for `risk/transaction-contexts`. | Verify `PAYPAL_MERCHANT_ID`. Refresh the token. Validate entitlement with the Integration Engineer. |
| STC responds 5xx but the checkout is interrupted | The `POST /api/orders` handler is propagating the STC error instead of absorbing it inside its `try/catch`. | The `await callSTC(...)` block must be wrapped in `try/catch`; any exception is logged as `warn` and the flow continues with Create Order (§13.5, §21.7). |
| Works in Postman but fails in the browser | The frontend is trying to call `api-m.paypal.com` directly. | The frontend always goes against `/api/*` of the backend; never directly to the PayPal REST API (§9.2). |
| `paypal.createInstance is not a function` | The SDK `<script>` did not finish loading before the call. | Wait for the `<script>`'s `onload` or use the `loadSDK(...)` helper with `Promise` (§14.3). |
| `onApprove` receives `data.orderId` `undefined` | Wrong shape returned by `createOrder`. | The callback must return **`{ orderId: <ORDER_ID> }`** (not `{ id: ... }` and not the bare `order_id`). The v6 SDK specifically reads the `orderId` property (§16.4). |
| Logs show full tokens | The backend logger serializes raw PayPal bodies. | Implement a logging wrapper that masks `access_token`, `nonce`, `app_id`, `Authorization` by default (§24.5). |
| The SDK does not display the UI in the expected language | `locale` is malformed or unsupported in the buyer's market. | Use BCP-47 format with hyphen (`'es-MX'`, not `'es_MX'`); validate that the `locale` is in PayPal's supported list. |

---

## Appendix B — Limitations and future work

### B.1 Known limitations

- **Runtime environment switching** is not supported by the v6 SDK (it registers *custom elements*). Sandbox/Live selection must happen at backend startup and remain stable for the buyer session.
- **`AUTHORIZE` + deferred capture** is out of scope. This integration uses `intent: "CAPTURE"` exclusively.
- **Advanced card capabilities** (capture in own iframes, explicit control of strong customer authentication and its result, installment payments, card reuse across sessions) are not part of this integration. A merchant requiring them must evaluate a complementary SDD or a parallel solution.

### B.2 Suggested future work

| Initiative | Description |
|------------|-------------|
| **Back-office operations** | Complementary SDD for webhooks (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CUSTOMER.DISPUTE.CREATED`), partial/total refunds, settlement, and financial reconciliation. |
| **Additional payment methods** | Extension of the solution to include local wallets or other methods available in the v6 SDK, adding the corresponding components to `createInstance`. |
| **Deferred capture (`AUTHORIZE`)** | For business models (preorders, dropshipping) where the capture happens after inventory or shipping confirmation. |
| **Industry pack** | Adoption of the extended STC `additional_data` set corresponding to the merchant's vertical (Travel, Gaming, Financial Services, etc.). |

---

*Solution Design Document for the integration of PayPal Checkout (PayPal, PayLater, PayPal Credit) and Branded Card-Direct Checkout (BCDC) on the PayPal JavaScript SDK v6 with a server-side architecture.*
