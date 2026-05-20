# Solution Design Document — Integración PayPal Checkout + BCDC con PayPal JavaScript SDK v6 (arquitectura server-side)

| Metadato | Valor |
|----------|-------|
| **Tipo de documento** | Solution Design Document (SDD) |
| **Solución** | Procesamiento de pagos en checkout web mediante PayPal Checkout, PayLater, PayPal Credit y Branded Card-Direct Checkout (BCDC) usando el PayPal JavaScript SDK v6 con arquitectura server-side |
| **Componentes técnicos** | PayPal Web SDK v6 (`web-sdk/v6/core`) · `paypal-payments` · `paypal-guest-payments` · One-Time Payment Sessions (PayPal, PayLater, PayPal Credit, Guest) · Risk Transaction Contexts (STC) · Backend-for-Frontend (BFF) |
| **Capacidades funcionales** | Pago con cuenta PayPal (One-Time) · Pago con PayLater · Pago con PayPal Credit · Pago con tarjeta de crédito/débito como invitado (BCDC) · Pre-evaluación de riesgo server-side (STC) · Idempotencia por operación (`createRequestId`, `captureRequestId`) · Correlación de riesgo con `PayPal-Client-Metadata-Id` |
| **APIs REST involucradas** | `/v1/oauth2/token`, `/v2/checkout/orders`, `/v2/checkout/orders/{id}`, `/v2/checkout/orders/{id}/capture`, `/v1/risk/transaction-contexts/{merchant_id}/{cmid}` |
| **Convenciones** | REST → `snake_case` · SDK JavaScript v6 → `camelCase` |
| **Audiencia** | Equipos de Solution Architecture, Integration Engineering, Product, e-commerce, Riesgo y Cumplimiento del comercio que implementará la integración en producción |

---

## Tabla de contenidos

### Parte I — Contexto de la solución
1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Contexto de negocio y drivers](#2-contexto-de-negocio-y-drivers)
3. [Alcance de la solución](#3-alcance-de-la-solución)
4. [Stakeholders y audiencia](#4-stakeholders-y-audiencia)
5. [Glosario de términos y acrónimos](#5-glosario-de-términos-y-acrónimos)

### Parte II — Definición de la solución
6. [Visión general de la solución](#6-visión-general-de-la-solución)
7. [Requisitos funcionales](#7-requisitos-funcionales)
8. [Requisitos no funcionales](#8-requisitos-no-funcionales)
9. [Arquitectura de la solución](#9-arquitectura-de-la-solución)
10. [Prerrequisitos y configuración del entorno](#10-prerrequisitos-y-configuración-del-entorno)

### Parte III — Diseño detallado
11. [Autenticación OAuth2 (client_credentials)](#11-autenticación-oauth2-client_credentials)
12. [Generación del Client Metadata ID (CMID)](#12-generación-del-client-metadata-id-cmid)
13. [Set Transaction Context (STC)](#13-set-transaction-context-stc)
14. [Carga del PayPal Web SDK v6](#14-carga-del-paypal-web-sdk-v6)
15. [Inicialización del SDK y descubrimiento de métodos elegibles](#15-inicialización-del-sdk-y-descubrimiento-de-métodos-elegibles)
16. [Estructura HTML y patrón de activación de sesión](#16-estructura-html-y-patrón-de-activación-de-sesión)
17. [Sesión de PayPal Checkout (cuenta PayPal)](#17-sesión-de-paypal-checkout-cuenta-paypal)
18. [Sesión de PayLater](#18-sesión-de-paylater)
19. [Sesión de PayPal Credit](#19-sesión-de-paypal-credit)
20. [Sesión de BCDC — Guest Card Checkout](#20-sesión-de-bcdc--guest-card-checkout)
21. [Creación y captura de órdenes](#21-creación-y-captura-de-órdenes)

### Parte IV — Integración y operación
22. [Orquestación end-to-end](#22-orquestación-end-to-end)
23. [Puntos de integración (mapa de endpoints)](#23-puntos-de-integración-mapa-de-endpoints)
24. [Consideraciones de seguridad](#24-consideraciones-de-seguridad)
25. [Consideraciones operativas](#25-consideraciones-operativas)

### Parte V — Validación y gobierno
26. [Estrategia de pruebas y entorno Sandbox](#26-estrategia-de-pruebas-y-entorno-sandbox)
27. [Convenciones de nombres REST vs SDK](#27-convenciones-de-nombres-rest-vs-sdk)
28. [Asunciones, dependencias y restricciones](#28-asunciones-dependencias-y-restricciones)
29. [Riesgos y mitigaciones](#29-riesgos-y-mitigaciones)
30. [Criterios de aceptación y checklist pre-producción](#30-criterios-de-aceptación-y-checklist-pre-producción)

### Apéndices
- [Apéndice A — Diagnóstico de errores frecuentes](#apéndice-a--diagnóstico-de-errores-frecuentes)
- [Apéndice B — Limitaciones y trabajo futuro](#apéndice-b--limitaciones-y-trabajo-futuro)

---

# Parte I — Contexto de la solución

## 1. Resumen ejecutivo

Este Solution Design Document define la integración de **PayPal Checkout + Branded Card-Direct Checkout (BCDC)** sobre el **PayPal JavaScript SDK v6** (`web-sdk/v6/core`) en una experiencia de checkout web con **arquitectura server-side**. La solución habilita cuatro métodos de pago bajo un único SDK y un único patrón de activación de sesión:

- **PayPal** — pago con cuenta PayPal del comprador.
- **PayLater** — pago a plazos financiado por PayPal en mercados elegibles.
- **PayPal Credit** — línea de crédito PayPal en mercados elegibles.
- **BCDC** — pago con tarjeta de crédito o débito como invitado (sin cuenta PayPal), con la UI de captura hospedada por PayPal.

La arquitectura sigue el patrón **Backend-for-Frontend (BFF)**: el navegador del comprador interactúa con el SDK de PayPal y con un backend privado del comercio, y este último es el único componente autorizado para hablar con la API REST de PayPal. El `client_secret` y el `merchant_id` permanecen en el backend; el frontend recibe únicamente el `client_id` público.

La solución está dirigida a comercios que requieren:

- **Cobertura amplia de métodos de pago** con un SDK único y una superficie de mantenimiento mínima.
- **Aislamiento de credenciales sensibles** en el backend, eliminando el `client_secret` del navegador.
- **Conversión optimizada** mediante el patrón de activación basado en *transient activation*, que evita los bloqueos de pop-up de los navegadores modernos.
- **Trazabilidad y correlación de riesgo** mediante un Client Metadata ID (CMID) consistente entre frontend, backend, STC y los headers de Create/Capture Order.
- **Idempotencia transaccional** mediante llaves `PayPal-Request-Id` independientes por operación (`createRequestId`, `captureRequestId`) para reintentos seguros frente a fallas de red.

El presente documento describe la solución de extremo a extremo: contexto de negocio, requisitos, arquitectura, diseño detallado por componente, orquestación, seguridad, operación, pruebas, riesgos y criterios de aceptación.

---

## 2. Contexto de negocio y drivers

### 2.1 Drivers de negocio

| Driver | Descripción |
|--------|-------------|
| **Cobertura de métodos de pago con un SDK único** | El SDK v6 expone PayPal, PayLater, PayPal Credit y BCDC bajo una única instancia (`createInstance`) y una API homogénea de sesiones (`createPayPalOneTimePaymentSession`, `createPayLaterOneTimePaymentSession`, `createPayPalCreditOneTimePaymentSession`, `createPayPalGuestOneTimePaymentSession`). Esto reduce el costo de mantenimiento frente a integrar cada método por separado. |
| **Conversión y experiencia de usuario** | El patrón de activación basado en *transient activation* preserva el gesto de usuario que dispara la sesión, permitiendo que PayPal abra su pop-up o full-page modal sin que el navegador lo bloquee. |
| **Reducción de fricción para el comprador invitado** | BCDC permite cobrar con tarjeta de crédito/débito sin obligar al comprador a crear una cuenta PayPal. La UI de captura es hospedada por PayPal: el comercio solo renderiza un botón. |
| **Aislamiento de credenciales** | La arquitectura server-side mueve el `client_secret` y el `merchant_id` fuera del navegador, eliminando la categoría de incidente "secret leaked in HTML" propia de integraciones legacy. |
| **Métodos de financiamiento sin código adicional** | PayLater y PayPal Credit se exponen mediante APIs simétricas a la de PayPal Checkout. La elegibilidad por mercado se descubre vía `findEligibleMethods`, sin necesidad de configuración manual por el comercio. |

### 2.2 Drivers regulatorios y de cumplimiento

| Driver | Descripción |
|--------|-------------|
| **PCI DSS** | En todos los flujos cubiertos por este SDD, el comercio **no procesa, transmite ni almacena datos de cuenta de tarjeta del comprador**: PayPal/PayLater/Credit no involucran tarjeta desde la perspectiva del comercio, y en BCDC la captura ocurre íntegramente en la UI hospedada por PayPal. Esto permite mantener el alcance bajo el cuestionario simplificado **SAQ A**. |
| **Custodia de secretos (estándares internos del comercio y normativas locales)** | El `client_secret` reside únicamente en el backend, gestionado por un secrets manager. Esto facilita el cumplimiento de políticas internas de manejo de credenciales y reduce el alcance de auditorías. |
| **Regulaciones locales para PayLater / Credit** | La presentación de financiamiento al comprador (texto legal, tasas, condiciones) está sujeta a regulaciones locales. La UI del flujo PayLater/Credit es hospedada por PayPal y cumple los requisitos del mercado en el que el SDK detecta elegibilidad. |

---

## 3. Alcance de la solución

### 3.1 Capacidades en alcance

| Capacidad | Descripción |
|-----------|-------------|
| **Pago con cuenta PayPal (One-Time)** | Cobro con cuenta PayPal del comprador mediante `createPayPalOneTimePaymentSession`. |
| **Pago con PayLater** | Financiamiento PayLater mediante `createPayLaterOneTimePaymentSession`. La elegibilidad por mercado y producto se descubre con `findEligibleMethods` y `paymentMethods.getDetails('paylater')`. |
| **Pago con PayPal Credit** | Línea de crédito PayPal mediante `createPayPalCreditOneTimePaymentSession` en mercados elegibles. |
| **BCDC — Guest Card Checkout** | Cobro con tarjeta de crédito/débito como invitado mediante `createPayPalGuestOneTimePaymentSession`. La UI de captura es hospedada por PayPal; el comercio monta los custom elements `<paypal-basic-card-container>` + `<paypal-basic-card-button>` y adjunta el listener de clic al botón. |
| **Patrón de activación con *transient activation*** | Construcción de la promesa de Create Order **sin `await`** dentro del handler del clic, para preservar el gesto de usuario y evitar bloqueos de pop-up. |
| **Set Transaction Context (STC)** | Envío de contexto del comprador al motor de riesgo de PayPal **antes de cada Create Order**. Operación **no bloqueante**. |
| **Idempotencia transaccional** | Reintentos seguros mediante llaves `PayPal-Request-Id` independientes por operación (`createRequestId` para Create, `captureRequestId` para Capture), persistidas server-side. |
| **Captura post-aprobación** | Captura del pago en `onApprove` mediante `POST /v2/checkout/orders/{id}/capture`. |
| **Consulta de detalles enriquecidos post-capture** | `GET /v2/checkout/orders/{id}` para obtener `payment_source` enriquecido, identificadores de captura y datos para reconciliación. |

### 3.2 Capacidades fuera de alcance

| Categoría | Detalle |
|-----------|---------|
| **Capacidades de tarjeta avanzadas** | Captura de tarjeta en iframes propios del comercio, control explícito de autenticación reforzada del comprador y resultado correspondiente, pagos a meses y reuso de tarjeta entre sesiones quedan fuera del alcance de esta integración. |
| **Telemetría adicional de riesgo** | El SDK v6 inyecta automáticamente la telemetría necesaria; el comercio no integra scripts adicionales. |
| **Operaciones de back-office** | Webhooks, reembolsos, settlement, disputas y conciliación financiera quedan fuera. Requieren un SDD complementario. |
| **Otros métodos de pago** | APMs locales (billeteras regionales, transferencias) y suscripciones recurrentes pueden integrarse con el mismo SDK v6 en soluciones complementarias. |
| **Modos de captura distintos a `CAPTURE`** | `AUTHORIZE` con captura diferida queda fuera. |

---

## 4. Stakeholders y audiencia

| Rol | Responsabilidad respecto a este SDD |
|-----|-------------------------------------|
| **Solution Architect** | Valida la arquitectura, asegura consistencia con el portafolio del comercio y aprueba el documento. |
| **Product Manager (e-commerce)** | Valida que el alcance funcional cubre los requisitos de negocio: cobertura de métodos de pago, mercados objetivo y experiencia de checkout. |
| **Integration Engineer (PayPal)** | Apoya al comercio en la implementación, valida configuraciones comerciales (habilitación de PayLater/Credit, BCDC, STC) y asiste en la migración desde integraciones legacy. |
| **Integration Engineer / Tech Lead (comercio)** | Lidera la implementación técnica y es propietario del código del frontend y del backend. |
| **Equipo de desarrollo del comercio** | Implementa y mantiene la integración. |
| **Equipo de Riesgo y Antifraude (comercio)** | Define el set de campos `additional_data` para STC, monitorea métricas de fraude y valida la propagación correcta del CMID. |
| **Equipo de Cumplimiento PCI (comercio)** | Verifica que la integración mantiene el alcance SAQ A y que no hay rutas por las que datos de cuenta de tarjeta del comprador alcancen la infraestructura del comercio. |
| **Equipo de QA (comercio)** | Ejecuta el plan de pruebas en Sandbox antes de la promoción a Live. |
| **Operaciones (comercio)** | Monitorea el checkout en producción, gestiona alertas e incidentes (caída de SDK, latencia anómala de Create/Capture, errores de OAuth). |

---

## 5. Glosario de términos y acrónimos

| Término | Definición |
|---------|------------|
| **PayPal Web SDK v6** | Versión 6 del SDK JavaScript de PayPal, distribuida desde `https://www.paypal.com/web-sdk/v6/core` (Live) o `https://www.sandbox.paypal.com/web-sdk/v6/core` (Sandbox). Se carga con `<script async src="...">` sin parámetros de query string. |
| **`createInstance`** | Función del SDK v6 (`window.paypal.createInstance({...})`) que devuelve una instancia configurada con `clientId`, `components`, `pageType` y `locale`. Es el primer paso obligatorio antes de cualquier sesión de pago. |
| **`findEligibleMethods`** | Método de la instancia del SDK que devuelve los métodos de pago elegibles para una `currencyCode` dada. Se usa para decidir qué botones renderizar en la UI. |
| **`paymentMethods.getDetails('paylater')`** | Helper expuesto por el resultado de `findEligibleMethods` que devuelve metadatos específicos de PayLater para el mercado del comprador (incluye `productCode` y `countryCode`). |
| **One-Time Payment Session** | Sesión de pago no recurrente. El SDK v6 expone un constructor distinto por método de pago (`createPayPalOneTimePaymentSession`, `createPayLaterOneTimePaymentSession`, `createPayPalCreditOneTimePaymentSession`, `createPayPalGuestOneTimePaymentSession`). Todas comparten la misma forma: callbacks `onApprove`, `onCancel`, `onError` (y `onWarn` en BCDC) y un método `start(...)`. |
| **`session.start(options, orderPromise)`** | Método que activa la sesión y abre la UI hospedada por PayPal. Recibe un objeto `options` (con `presentationMode`) y la **promesa** de Create Order. La promesa **no debe estar `await`-eada** en el momento de pasarla, para preservar el *transient activation*. La promesa debe resolver a `{ orderId: <ORDER_ID> }`. |
| **`presentationMode`** | Atributo de `options` que controla cómo PayPal presenta su UI. Valores típicos: `'auto'` (decisión adaptativa por dispositivo y navegador), `'modal'`, `'popup'`. |
| **`<paypal-basic-card-button>` / `<paypal-basic-card-container>`** | Custom elements registrados por el SDK v6 cuando el componente `'paypal-guest-payments'` está habilitado. Son los elementos canónicos para activar la sesión BCDC. El comercio adjunta el listener al `<paypal-basic-card-button>` y dispara `session.start(...)`. |
| **`targetElement`** | Atributo de `options` aplicable a variantes de apertura programática o *auto-start* del SDK v6 (la sesión se inicia sin depender del click handler recomendado; el elemento sirve como ancla visual de la experiencia BCDC). **No** se usa en el flujo canónico de este SDD, que usa click handler explícito sobre `<paypal-basic-card-button>`. |
| **Transient activation** | Estado del navegador, propagado por la API HTML, que indica que el usuario ha realizado un gesto reciente (típicamente un clic). Se consume cuando se abre una ventana o se ejecuta una operación que requiere consentimiento implícito. **`await` antes de invocar `session.start` consume el estado** y los navegadores bloquearán la apertura del pop-up. |
| **Order** | Recurso REST (`/v2/checkout/orders`) que representa la intención de cobro: monto, breakdown, items, comprador. Identificado por `order_id`. |
| **Capture** | Operación que ejecuta el cobro real contra el método de pago aprobado (`POST /v2/checkout/orders/{id}/capture`). |
| **`intent`** | Campo de la orden que indica `CAPTURE` (cobrar al aprobar) o `AUTHORIZE` (solo retener fondos). El uso típico de e-commerce y el cubierto por este SDD es `CAPTURE`. |
| **`access_token`** | Token Bearer OAuth2 que el backend del comercio usa para autenticarse con la API REST de PayPal. **Nunca** debe enviarse al navegador. |
| **`client_credentials`** | Grant type de OAuth2 que esta integración usa para obtener el `access_token`. **No** se solicita `response_type=id_token`; el SDK v6 no requiere `id_token` para inicializarse. |
| **CMID** | *Client Metadata ID.* Identificador alfanumérico de **hasta 32 caracteres sin guiones**, generado **una sola vez por sesión de checkout**. La práctica recomendada es un UUID v4 sin guiones (32 caracteres). Funciona como hilo de correlación entre el frontend, la URL de STC y los headers `PayPal-Client-Metadata-Id` de Create Order y Capture Order. |
| **STC** | *Set Transaction Context.* Endpoint `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` mediante el cual el comercio envía contexto del comprador a PayPal Risk **antes de cada Create Order**. Es **no bloqueante**: errores nunca deben detener el checkout. |
| **`PayPal-Client-Metadata-Id`** | Header HTTP que el backend del comercio inyecta en Create Order y Capture Order. Contiene el CMID de la sesión y permite a PayPal Risk correlacionar la transacción con la telemetría del SDK y el contexto de STC. |
| **`PayPal-Request-Id`** | Header HTTP de **idempotencia por operación**. Cada operación (Create Order, Capture Order) tiene su propia llave (`createRequestId`, `captureRequestId`). La misma llave se reutiliza únicamente ante reintentos del **mismo** request (timeouts o `5xx` transitorios). **No** se reutiliza la llave entre operaciones distintas. |
| **BFF** | *Backend-for-Frontend.* Patrón arquitectónico en el que el backend del comercio expone únicamente los endpoints necesarios para el flujo de checkout, custodia los secretos y actúa como proxy autenticado hacia la API REST de PayPal. |
| **BCDC** | *Branded Card-Direct Checkout.* Producto de PayPal para procesar tarjetas de crédito/débito como invitado, con UI de captura hospedada por PayPal. **No** debe confundirse con ACDC. |
| **PCI DSS** | *Payment Card Industry Data Security Standard.* Estándar de seguridad para el manejo de datos de tarjeta. Como la captura ocurre en la UI hospedada por PayPal, el comercio puede mantenerse en alcance **SAQ A**. |
| **SAQ A** | *Self-Assessment Questionnaire A.* Cuestionario PCI simplificado aplicable cuando el comercio no almacena, procesa ni transmite datos de cuenta. |
| **`pageType`** | Parámetro de `createInstance` que indica a PayPal el tipo de página donde el SDK opera (`'checkout'`, `'product-details'`, `'cart'`, etc.). Influye en métricas y en la presentación de algunos métodos. Para esta integración el valor es `'checkout'`. |
| **`locale`** | Parámetro de `createInstance` con formato BCP-47 (`'es-MX'`, `'en-US'`, `'pt-BR'`, etc.). Define el idioma de la UI hospedada por PayPal. |
| **`currencyCode`** | Parámetro de `findEligibleMethods` en formato ISO 4217 (`'MXN'`, `'USD'`, `'BRL'`, etc.). Determina la elegibilidad de métodos por mercado. |
| **NFR** | *Non-Functional Requirement.* Requisito no funcional. |

---

# Parte II — Definición de la solución

## 6. Visión general de la solución

La solución se compone de **tres planos** con responsabilidades estrictamente delimitadas y un **identificador de correlación** (CMID) que atraviesa los tres durante toda la sesión de checkout.

| Plano | Responsabilidad | Lo que NO hace |
|-------|----------------|----------------|
| **Navegador del comprador** | Genera el CMID, carga el SDK v6, llama a `createInstance` y `findEligibleMethods`, instancia las sesiones de pago, renderiza los botones, dispara `session.start(...)` con la promesa de Create Order y reacciona a los callbacks. | Nunca conoce `CLIENT_SECRET`, `access_token` ni `MERCHANT_ID`. Nunca llama directamente a la API REST de PayPal para operaciones de negocio. |
| **Backend del comercio** | Custodia las credenciales, obtiene `access_token` mediante OAuth2 `client_credentials`, expone endpoints proxy hacia PayPal, inyecta los headers `PayPal-Request-Id` (con llaves de idempotencia separadas para Create y Capture) y `PayPal-Client-Metadata-Id`, ejecuta STC server-side antes de cada Create Order y construye el payload de Create Order a partir del estado del carrito autenticado. | Nunca recibe ni manipula datos de cuenta de tarjeta del comprador (en ningún flujo: PayPal, PayLater, Credit ni BCDC). Nunca expone `access_token`, `client_secret` ni `merchant_id` al frontend. **Nunca acepta payload de orden, monto, items ni breakdown enviados desde el cliente.** |
| **API REST de PayPal** | Procesa órdenes, capturas y contexto de riesgo (STC). | Es la única fuente de verdad transaccional. |

### 6.1 Componentes de la solución

| Componente | Plano | Función |
|-----------|-------|---------|
| **PayPal Web SDK v6** | Navegador | Renderiza la UI hospedada por PayPal, gestiona el ciclo de vida de las sesiones de pago y la comunicación con `paypal.com`. |
| **Botones del comercio** | Navegador | Elementos HTML `<button>` propios del comercio que disparan `session.start(...)`. La marca y estilo son del comercio. |
| **OAuth2 Service** | Backend | Obtiene y cachea `access_token` mediante `client_credentials`. |
| **Orders Proxy** | Backend | Crea, consulta y captura órdenes. Inyecta headers de idempotencia y correlación. |
| **STC Caller** | Backend | Llama a `/v1/risk/transaction-contexts` server-side dentro del handler de `POST /api/orders`, antes de Create Order. No expone un endpoint público al frontend. |
| **API REST PayPal** | PayPal | Procesamiento real. |

### 6.2 Identificador de correlación: el CMID

El **CMID** (Client Metadata ID) es un identificador alfanumérico de hasta 32 caracteres sin guiones, generado una sola vez por sesión de checkout. La implementación recomendada es un UUID v4 sin guiones (32 caracteres). Atraviesa los tres planos:

```
Navegador                         Backend del comercio              API PayPal
─────────                         ────────────────────              ──────────
1. genera CMID
2. CMID → body._cmid de /api/orders ──→  (server-side, en orden estricto)
                                          PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}  (STC, no bloqueante)
                                          PayPal-Client-Metadata-Id ──→ POST /v2/checkout/orders
3. CMID → body._cmid de /api/orders/:id/capture
                                     ──→  PayPal-Client-Metadata-Id ──→ POST /v2/checkout/orders/{id}/capture
```

Sin un CMID consistente entre los tres planos, PayPal Risk no puede correlacionar el contexto de STC con la transacción real, lo que degrada la calidad de la evaluación de riesgo.

> **NOTA — Fraudnet en JSv6:** A diferencia de integraciones legacy basadas en el SDK clásico, el SDK v6 inyecta automáticamente la telemetría necesaria. **El comercio no debe inyectar scripts adicionales de Fraudnet.** El CMID se propaga vía headers HTTP del backend, no vía atributos del `<script>` del SDK.

### 6.3 Métodos de pago bajo un único SDK

Una vez creada la `sdkInstance`, los cuatro métodos de pago se exponen mediante constructores simétricos:

| Método | Constructor de sesión | Componente requerido en `createInstance` |
|--------|------------------------|------------------------------------------|
| **PayPal** | `sdkInstance.createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **PayLater** | `sdkInstance.createPayLaterOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **PayPal Credit** | `sdkInstance.createPayPalCreditOneTimePaymentSession({ onApprove, onCancel, onError })` | `'paypal-payments'` |
| **BCDC (Guest)** | `sdkInstance.createPayPalGuestOneTimePaymentSession({ onApprove, onCancel, onWarn, onError })` | `'paypal-guest-payments'` |

> **OBLIGATORIO:** El array `components` que se pasa a `createInstance` debe incluir **explícitamente** los componentes correspondientes a los métodos que el comercio expondrá. Para una integración completa: `['paypal-payments', 'paypal-guest-payments']`.

---

## 7. Requisitos funcionales

| ID | Requisito | Prioridad |
|----|-----------|-----------|
| **RF-01** | El sistema debe permitir al comprador completar un cobro mediante su cuenta PayPal a través de `createPayPalOneTimePaymentSession`. | Obligatorio |
| **RF-02** | El sistema debe permitir al comprador completar un cobro con tarjeta de crédito o débito como invitado mediante BCDC (`createPayPalGuestOneTimePaymentSession`), con la captura de los datos de tarjeta delegada íntegramente a la UI hospedada por PayPal. El comercio no captura, transmite ni almacena datos de cuenta de tarjeta. | Obligatorio |
| **RF-03** | El sistema debe ofrecer **PayLater** y **PayPal Credit** cuando `findEligibleMethods` los reporte como elegibles para la moneda y mercado de la sesión. | Obligatorio (cuando aplica) |
| **RF-04** | El sistema debe crear cada orden con `intent: "CAPTURE"` y un breakdown matemáticamente consistente (`item_total + tax_total + shipping − discount = amount.value`). | Obligatorio |
| **RF-05** | El sistema debe ejecutar la captura del pago en `onApprove`, mediante una llamada a `POST /v2/checkout/orders/{id}/capture` ejecutada por el backend del comercio. | Obligatorio |
| **RF-06** | El sistema debe activar cada sesión de pago preservando el *transient activation* del navegador: la promesa de Create Order **no** debe ser `await`-eada antes de pasarla a `session.start(...)`. | Obligatorio |
| **RF-07** | El sistema debe transmitir a PayPal Risk el contexto del comprador antes de cada Create Order, sin bloquear el checkout en caso de error de STC. | Obligatorio |
| **RF-08** | El sistema debe generar un CMID único por sesión de checkout y propagarlo como header `PayPal-Client-Metadata-Id` en Create Order y Capture Order, y como segmento de URL en la llamada a STC. | Obligatorio |
| **RF-09** | El sistema debe permitir reintentos del comprador dentro de una misma sesión de checkout sin regenerar el CMID. | Obligatorio |
| **RF-10** | El sistema debe enriquecer la respuesta post-capture mediante `GET /v2/checkout/orders/{id}` para obtener identificadores de captura y datos para reconciliación. | Obligatorio |
| **RF-11** | El sistema debe mostrar al comprador un mensaje claro y accionable cuando un pago falle (`onError`) o sea cancelado por el comprador (`onCancel`). | Obligatorio |
| **RF-12** | El sistema debe degradar elegantemente cuando un método de pago no resulte elegible: el botón correspondiente no se renderiza y la UI no presenta opciones inválidas al comprador. | Obligatorio |

---

## 8. Requisitos no funcionales

| ID | Categoría | Requisito |
|----|-----------|-----------|
| **NFR-01** | **Seguridad — PCI DSS** | El comercio no debe procesar, transmitir ni almacenar datos de cuenta de tarjeta del comprador en ningún punto del flujo. La integración debe permitir cumplimiento bajo SAQ A. |
| **NFR-02** | **Seguridad — secretos** | `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` y `access_token` nunca deben transmitirse al navegador, ni almacenarse en código fuente versionado, ni aparecer en logs. |
| **NFR-03** | **Seguridad — transporte** | Todas las comunicaciones (navegador ↔ backend, backend ↔ PayPal) deben usar TLS 1.2 o superior. |
| **NFR-04** | **Seguridad — CSP** | El sitio debe declarar una Content Security Policy que liste explícitamente los orígenes de PayPal: `www.paypal.com`, `www.sandbox.paypal.com`, `www.paypalobjects.com`, `c.paypal.com`, `api-m.paypal.com` (y sus equivalentes Sandbox). |
| **NFR-05** | **Disponibilidad** | La caída de servicios accesorios (STC) **no** debe interrumpir el flujo de pago. STC opera de forma no bloqueante. |
| **NFR-06** | **Idempotencia** | El sistema debe garantizar que reintentos de Create Order o Capture Order no generen órdenes ni capturas duplicadas mediante `PayPal-Request-Id`, usando llaves **independientes por operación** (`createRequestId` para Create, `captureRequestId` para Capture). |
| **NFR-07** | **Latencia (p95)** | El tiempo total entre el clic del botón y la respuesta al usuario no debe exceder los SLOs internos del comercio. La caché del `access_token` (§11.3) y el procesamiento no bloqueante de STC son esenciales para cumplirlo. |
| **NFR-08** | **Trazabilidad** | El sistema debe loguear `order_id`, `capture_id`, `status`, código de error PayPal y CMID, sin loguear secretos del backend (`access_token`, `client_secret`, header `Authorization` completo). El comercio no maneja datos de tarjeta del comprador, por lo que no hay riesgo de loguearlos accidentalmente. |
| **NFR-09** | **Internacionalización** | El SDK debe inicializarse con el `locale` correspondiente al mercado destino y los mensajes de error deben traducirse al idioma del comprador. |
| **NFR-10** | **Accesibilidad** | Los botones del comercio que activan las sesiones deben cumplir WCAG 2.1 AA: foco visible, etiquetas accesibles, contraste suficiente, área táctil mínima 44×44 px. |
| **NFR-11** | **Escalabilidad** | El backend debe cachear el `access_token` hasta el 90 % de `expires_in` para no saturar `/v1/oauth2/token` bajo carga. |
| **NFR-12** | **Compatibilidad de navegador** | La integración debe ejecutar `findEligibleMethods` antes de renderizar cualquier botón y omitir aquellos métodos que no resulten elegibles. |
| **NFR-13** | **Auditabilidad** | Cada transacción debe ser reconstruible a partir de los logs: CMID, `createRequestId`, `captureRequestId`, `order_id`, `invoice_id`, `custom_id`. |
| **NFR-14** | **Preservación del transient activation** | El handler del clic del botón **no** debe contener `await` antes de invocar `session.start(...)`. La promesa de Create Order debe construirse e inmediatamente pasarse al SDK. |

---

## 9. Arquitectura de la solución

### 9.1 Diagrama lógico

```
┌─────────────────────────────────────────────────────────────────────────┐
│  NAVEGADOR DEL COMPRADOR (zona pública)                                 │
│                                                                         │
│   Checkout HTML/JS del comercio       PayPal Web SDK v6                 │
│   ┌───────────────────────────┐       ┌───────────────────────────┐     │
│   │ - Generación del CMID     │ usa→  │ paypal.createInstance()   │     │
│   │ - Renderizado de botones  │       │ sdkInstance.findEligible  │     │
│   │ - addEventListener click  │       │ Methods()                 │     │
│   │ - Llamadas a /api/* del   │       │ createPayPalOneTime…      │     │
│   │   backend                 │       │ createPayLaterOneTime…    │     │
│   │                           │       │ createPayPalCreditOneTime…│     │
│   │                           │       │ createPayPalGuestOneTime… │     │
│   └─────────────┬─────────────┘       │ session.start(...)        │     │
│                 │ HTTPS /api/*        │ (UI hospedada por PayPal) │     │
│                 │                     └─────────────┬─────────────┘     │
│                 │                                   │ HTTPS directo     │
│                 │                                   │ a dominios PayPal │
└─────────────────┼───────────────────────────────────┼───────────────────┘
                  ↓                                   ↓
┌──────────────────────────────────┐       ┌───────────────────────────────┐
│  BACKEND DEL COMERCIO (privado)  │       │  API REST de PayPal           │
│                                  │       │                               │
│  - PAYPAL_CLIENT_ID              │ HTTPS │  api-m.sandbox.paypal.com     │
│  - PAYPAL_CLIENT_SECRET ←────────┼──────→│  api-m.paypal.com (Live)      │
│  - PAYPAL_MERCHANT_ID            │       │                               │
│  - access_token (en memoria)     │       │  /v1/oauth2/token             │
│                                  │       │  /v2/checkout/orders          │
│  Endpoints expuestos al frontend │       │  /v2/checkout/orders/{id}     │
│  (sugerencia):                   │       │  /v2/checkout/orders/{id}/    │
│  - GET    /api/config            │       │     capture                   │
│  - POST   /api/orders            │       │  /v1/risk/transaction-        │
│  - GET    /api/orders/:id        │       │     contexts/{mid}/{cmid}     │
│  - POST   /api/orders/:id/       │       │                               │
│           capture                │       │                               │
│  (STC se invoca interno en      │       │                               │
│   POST /api/orders, no se       │       │                               │
│   expone al frontend)           │       │                               │
└──────────────────────────────────┘       └───────────────────────────────┘
```

### 9.2 Reglas no negociables de la arquitectura

1. **`PAYPAL_CLIENT_SECRET` reside únicamente en variables de entorno del backend.** Jamás se versiona, jamás se envía al navegador.
2. **El navegador nunca llama directamente a `api-m.paypal.com`** para operaciones de negocio. Toda comunicación con la API REST pasa por el backend del comercio, que actúa como proxy autenticado.
3. **El navegador nunca recibe el `access_token`.** Recibe únicamente el `client_id` público (vía `GET /api/config`) y los identificadores devueltos por las llamadas proxy (`order_id`, `capture_id`).
4. **Los datos de cuenta de tarjeta del comprador nunca tocan el comercio.** En PayPal, PayLater y Credit el flujo no involucra tarjeta del comprador desde la perspectiva del comercio (la cuenta PayPal y el financiamiento son la abstracción). En BCDC la captura ocurre íntegramente en la UI hospedada por PayPal. El comercio no implementa Card Fields ni iframes de captura propios.
5. **Los datos de carrito, comprador y dirección de envío nunca son hardcoded en el código del frontend.** Provienen de la sesión autenticada y del estado del carrito en el backend.
6. **El backend no devuelve campos sensibles (`client_secret`, `access_token`, `merchant_id`) al frontend bajo ninguna circunstancia**, ni siquiera en endpoints de configuración o telemetría.

### 9.3 Frontera de seguridad por asset

| Asset | Frontend | Backend | API PayPal |
|-------|:-------:|:------:|:---------:|
| `CLIENT_ID` | Sí | Sí | — |
| `CLIENT_SECRET` | **No** | **Sí (env)** | — |
| `MERCHANT_ID` | **No** | **Sí (env)** | — |
| `access_token` | **No** | Sí (memoria) | — |
| Datos de cuenta de tarjeta del comprador | **UI hospedada PayPal** (solo en BCDC) | **No** | Sí |
| `order_id` | Sí (referencia) | Sí | Sí |
| `capture_id` | Sí (referencia) | Sí | Sí |
| `CMID` | Sí (genera) | Sí (recibe en body) | Sí (header) |

### 9.4 Patrón arquitectónico: Backend-for-Frontend (BFF) sobre PayPal

El backend del comercio implementa el patrón **Backend-for-Frontend** sobre la API REST de PayPal. Los endpoints `/api/*` no son una API genérica; existen para las necesidades específicas del checkout y custodian secretos, idempotencia y headers de correlación que el frontend no debe manejar.

Las consecuencias prácticas son:

- El frontend **no** conoce la existencia de `api-m.paypal.com`. Solo conoce las rutas `/api/*` de su propio backend.
- El backend **no** expone una API generalizada de PayPal. Cada endpoint mapea a una operación de negocio del checkout (crear orden, capturar orden, registrar contexto de riesgo).
- La rotación de credenciales y el cambio de entorno (Sandbox ↔ Live) son transparentes para el frontend: solo cambian variables de entorno del backend.

---

## 10. Prerrequisitos y configuración del entorno

### 10.1 Habilitaciones comerciales requeridas

Antes de iniciar la implementación, el comercio debe tener activadas en su cuenta de PayPal:

| Capacidad | Aplica a |
|-----------|----------|
| **PayPal Checkout (One-Time Payments)** | Pago con cuenta PayPal. |
| **BCDC (Branded Card-Direct Checkout)** | Pago con tarjeta de crédito/débito como invitado. |
| **PayLater** | Cuando el comercio desee ofrecer PayLater en mercados elegibles. |
| **PayPal Credit** | Cuando el comercio desee ofrecer la línea de crédito PayPal. |
| **Set Transaction Context (STC)** | Acceso al endpoint `/v1/risk/transaction-contexts`. |

### 10.2 Credenciales y configuración del backend

| Variable de entorno | Origen | Visibilidad |
|--------------------|--------|-------------|
| `PAYPAL_CLIENT_ID` | PayPal Developer Dashboard → app del comercio. | Pública (puede exponerse al frontend mediante `GET /api/config`). |
| `PAYPAL_CLIENT_SECRET` | PayPal Developer Dashboard → app del comercio. | **Secreta — solo backend.** |
| `PAYPAL_MERCHANT_ID` | Perfil de la cuenta merchant en PayPal. | Privada — solo backend (requerida para STC). |
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` (Sandbox) · `https://api-m.paypal.com` (Live). | Privada. |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` (Sandbox) · `https://www.paypal.com/web-sdk/v6/core` (Live). | Pública (puede exponerse al frontend para que el `<script>` cargue la URL correcta del SDK). |

> **OBLIGATORIO:** Las credenciales y URLs de Sandbox y Live son distintas. `PAYPAL_API_BASE`, `PAYPAL_SDK_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y `PAYPAL_MERCHANT_ID` deben corresponder al **mismo entorno**. Una mezcla produce `401 Unauthorized` en la primera llamada a OAuth o errores opacos en la inicialización del SDK.

### 10.3 Requisitos del entorno

- **TLS / HTTPS obligatorio en producción.** El SDK v6 no opera sobre HTTP.
- **Content Security Policy (CSP):** debe permitir como mínimo:
  - `script-src https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com` (más equivalentes Sandbox cuando aplica).
  - `frame-src https://www.paypal.com` (más equivalentes Sandbox).
  - `connect-src https://api-m.paypal.com https://api-m.sandbox.paypal.com`.
- **Soporte de Web Crypto API** en el navegador (para `crypto.randomUUID()`). Para soportar navegadores legacy, implementar fallback (ver §12.2).
- **Soporte de pop-ups del dominio del comercio.** El usuario no debe tener bloqueados los pop-ups para `paypal.com`. El patrón de activación basado en *transient activation* (§16) está diseñado precisamente para que el navegador permita el pop-up sin requerir configuración del usuario.

### 10.4 Endpoint de configuración pública

El backend debe exponer un endpoint que entregue al frontend **únicamente** los valores públicos necesarios para inicializar el SDK:

```http
GET /api/config
→ 200 OK
{
  "clientId": "<PAYPAL_CLIENT_ID>",
  "sdkUrl":   "<PAYPAL_SDK_URL>"
}
```

| Campo | Justificación de la decisión |
|-------|------------------------------|
| `clientId` | Necesario para `paypal.createInstance(...)`. No se hardcodea en el HTML porque el comercio típicamente alterna entre múltiples entornos (Sandbox / Live, eventualmente UAT) en distintos despliegues. |
| `sdkUrl` | **Decisión arquitectónica del comercio.** Una alternativa válida —y usada en samples oficiales de PayPal— es hardcodear el `<script async src="https://www.paypal.com/web-sdk/v6/core">` directamente en el HTML por entorno. Servir `sdkUrl` desde el backend simplifica la operación multi-entorno (Sandbox/Live se decide en variables de entorno del backend, no en el build del frontend). |

> **OBLIGATORIO:** Este endpoint **nunca** debe devolver `client_secret`, `access_token` ni `merchant_id`. Tests automatizados deben validar que la respuesta no contenga estas claves.

> **NOTA:** Si el comercio prefiere hardcodear el `<script>` del SDK en su HTML por entorno (despliegues separados Sandbox/Live), `GET /api/config` puede simplificarse a devolver solo `clientId`. Ambas estrategias son válidas; el SDD documenta la versión con `sdkUrl` server-side por ser la más flexible para operaciones multi-entorno.

---

# Parte III — Diseño detallado

## 11. Autenticación OAuth2 (`client_credentials`)

El backend del comercio es el único componente autorizado para hablar OAuth2 con PayPal. El propósito de este paso es obtener un **`access_token`** Bearer para que el backend invoque la API REST de PayPal.

> **OBLIGATORIO:** A diferencia de integraciones basadas en el SDK clásico, **esta solución no requiere `id_token`**. El SDK v6 se inicializa únicamente con el `client_id` público; no hay atributo `data-sdk-client-token`. El grant es estrictamente `client_credentials`.

### 11.1 Request

```http
POST {PAYPAL_API_BASE}/v1/oauth2/token
Authorization: Basic <BASE64(CLIENT_ID:CLIENT_SECRET)>
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

### 11.2 Response (campos relevantes)

```json
{
  "access_token": "<ACCESS_TOKEN>",
  "expires_in":   32400,
  "token_type":   "Bearer",
  "app_id":       "<APP_ID>",
  "scope":        "https://api.paypal.com/v1/payments/.* ..."
}
```

### 11.3 Caché del `access_token`

| Práctica | Justificación |
|----------|--------------|
| Cachear el `access_token` en memoria del proceso del backend hasta el **90 % de `expires_in`** y refrescarlo proactivamente. | Evita llamadas innecesarias a `/v1/oauth2/token` y reduce latencia en el camino crítico de Create Order. |
| **No** persistir el `access_token` en disco, base de datos ni logs. | Token Bearer con poder transaccional; su exposición compromete la cuenta. |
| Refrescar inmediatamente ante un `401` de cualquier llamada y reintentar **una vez**. | Cubre el edge case de token revocado por rotación de credenciales. |
| Invalidar la caché ante una rotación manual de `CLIENT_SECRET`. | Una rotación deja el token cacheado inválido; el backend debe forzar refresh en la próxima llamada. |

### 11.4 Implementación de referencia (Node.js)

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

### 11.5 No exposición al frontend

El `access_token` **nunca** es retornado al navegador. Las rutas `/api/*` del backend usan internamente `getAccessToken()` y devuelven al frontend únicamente la respuesta de negocio enmascarada cuando aplica.

> **ADVERTENCIA:** Cualquier endpoint que filtre `access_token` al navegador permite a un atacante operar la cuenta de PayPal del comercio. Tests de integración deben validar que el JSON de respuesta de cada `/api/*` no contiene la clave `access_token` ni su valor.

---

## 12. Generación del Client Metadata ID (CMID)

El **CMID** es el primer dato que se materializa cuando el navegador inicializa el checkout. Es un **identificador único alfanumérico de hasta 32 caracteres sin guiones** que actúa como hilo de correlación entre tres puntos:

1. La URL del endpoint de **STC** (`/v1/risk/transaction-contexts/{merchant_id}/{cmid}`).
2. El header `PayPal-Client-Metadata-Id` enviado al **Create Order**.
3. El header `PayPal-Client-Metadata-Id` enviado al **Capture Order**.

### 12.1 Reglas de ciclo de vida

| Regla | Detalle |
|-------|---------|
| **Único por sesión de checkout** | Se genera **una sola vez** al inicializar la página del checkout. |
| **Persistente entre reintentos** | Si el comprador falla un pago y reintenta dentro de la misma sesión, el CMID **no** se regenera. |
| **Persistente entre métodos de pago** | Si el comprador alterna entre PayPal, PayLater, Credit y BCDC en la misma sesión, el CMID se conserva. |
| **Se regenera en transacción nueva** | Solo después de que la transacción anterior fue completada o cancelada definitivamente se genera un nuevo CMID en una nueva sesión de checkout. |
| **Se propaga server-side por el backend** | El frontend lo entrega al backend en el body de Create Order/Capture Order y como segmento de URL en STC; el backend lo reenvía como header HTTP a PayPal. |

### 12.2 Implementación de referencia

La implementación recomendada es un UUID v4 sin guiones, que ocupa los 32 caracteres disponibles y ofrece la mayor entropía posible dentro del límite.

```javascript
function generateCMID() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, ""); // 32 caracteres hex
  }
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const cmid = generateCMID();
```

> **NOTA:** Aunque el contrato de PayPal acepta hasta 32 caracteres, usar identificadores de longitud máxima (UUID v4 sin guiones) es la recomendación: maximiza la unicidad y elimina ambigüedades sobre el rango aceptado por la API.

### 12.3 Validación

El CMID debe cumplir:

- Longitud entre **1 y 32 caracteres** (máximo inclusivo).
- Únicamente caracteres alfanuméricos.
- Sin guiones, sin separadores, sin espacios.

```javascript
const isValidCMID = (cmid) =>
  typeof cmid === "string" &&
  cmid.length >= 1 &&
  cmid.length <= 32 &&
  /^[0-9a-zA-Z]+$/.test(cmid);
```

El backend debe aplicar esta validación al `_cmid` recibido del frontend antes de propagarlo como header HTTP a PayPal. Un CMID malformado debe rechazarse con `400 Bad Request` para evitar payloads inconsistentes.

---

## 13. Set Transaction Context (STC)

STC permite al comercio enviar **contexto del comprador** a PayPal Risk **antes** de cada Create Order. PayPal lo correlaciona con la transacción mediante el CMID. La operación es **no bloqueante**: cualquier error debe loguearse pero **nunca** detener el flujo de checkout.

### 13.1 Endpoint

```http
PUT {PAYPAL_API_BASE}/v1/risk/transaction-contexts/<MERCHANT_ID>/<CMID>
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
```

| Componente de la URL | Origen |
|---------------------|--------|
| `<MERCHANT_ID>` | Variable de entorno `PAYPAL_MERCHANT_ID`. |
| `<CMID>` | El CMID generado en §12 para esta sesión. |

### 13.2 Body — set genérico para Retail

```json
{
  "additional_data": [
    { "key": "sender_account_id",   "value": "<ID_DEL_COMPRADOR_EN_LA_PLATAFORMA_DEL_COMERCIO>" },
    { "key": "sender_first_name",   "value": "<NOMBRE_DEL_COMPRADOR>" },
    { "key": "sender_last_name",    "value": "<APELLIDO_DEL_COMPRADOR>" },
    { "key": "sender_email",        "value": "<EMAIL_DEL_COMPRADOR>" },
    { "key": "sender_phone",        "value": "<TELEFONO_SOLO_DIGITOS>" },
    { "key": "sender_country_code", "value": "<PAIS_ISO_ALPHA2>" },
    { "key": "sender_create_date",  "value": "<FECHA_DE_ALTA_DEL_USUARIO>" },
    { "key": "highrisk_txn_flag",   "value": "0" },
    { "key": "vertical",            "value": "<VERTICAL_DEL_NEGOCIO>" }
  ]
}
```

### 13.3 Referencia de campos

| Campo | Tipo | Descripción | Valores aceptados |
|-------|------|-------------|-------------------|
| `sender_account_id` | string | Identificador único del comprador en la plataforma del comercio. | Alfanumérico estable entre sesiones. |
| `sender_first_name` | string | Nombre registrado del comprador. | Alfanumérico. |
| `sender_last_name` | string | Apellido registrado del comprador. | Alfanumérico. |
| `sender_email` | string | Email validado del comprador. | Formato RFC 5322. |
| `sender_phone` | string | Teléfono del comprador, **solo dígitos**, sin formato. | `[0-9]+` |
| `sender_country_code` | string | País del comprador en ISO 3166-1 Alpha-2. | `MX`, `US`, `BR`, etc. |
| `sender_create_date` | string | Fecha de alta del usuario en la plataforma del comercio. | Formatos aceptados: `yyyy-mm-ddThh:mm:ss.000-00:00`, `yyyy-mm-ddThh:mm:ss.0000000Z`, `yyyy-mm-ddThh:mm:ss+00:00`, `yyyy-mm-ddThh:mm:ssZ`, `yyyy-mm-dd`, `yyyymmdd`. |
| `highrisk_txn_flag` | string | Indica si la transacción es de alto riesgo (gift cards, electrónicos, etc.). | `"0"` = normal, `"1"` = alto riesgo. |
| `vertical` | string | Vertical del negocio. | `Retail`, `Travel`, `Gaming`, etc. (consultar industry pack con el Integration Engineer). |

> **NOTA — Industry packs:** El set anterior es el genérico para Retail. Verticales como Travel, OTAs, Financial Services, Gaming y plataformas reguladas requieren campos adicionales específicos. Solicitar el industry pack correspondiente al Integration Engineer asignado.

### 13.4 Manejo de respuesta — comportamiento no bloqueante

| Status HTTP | Significado | Acción del frontend/backend |
|------------:|-------------|------------------------------|
| `200` | OK. Contexto registrado. | Continuar con Create Order. |
| `400` | Body inválido (tipo de campo o formato incorrecto). | Loguear el error con detalle, **continuar** con Create Order. |
| `401` | Sin permisos o `access_token` expirado. | Refrescar token, loguear, **continuar** con Create Order. |
| `5xx` | Error interno de PayPal. | Loguear, **continuar** con Create Order. |

> **OBLIGATORIO:** STC nunca puede bloquear el checkout. Una falla de STC reduce la calidad de la evaluación de riesgo pero **no** impide procesar la transacción.

### 13.5 Implementación de referencia — STC server-side dentro de Create Order

STC se ejecuta **server-side**, dentro del propio handler de `POST /api/orders`, **secuenciada antes** de la llamada a `POST /v2/checkout/orders` y envuelta en `try/catch`. Esto garantiza dos propiedades que no se obtendrían disparando STC desde el frontend en modo *fire-and-forget*:

1. **Orden estricto:** STC siempre llega a PayPal Risk **antes** de Create Order, no en paralelo.
2. **No bloqueante real:** un fallo de STC se loguea pero no detiene la creación de la orden.

#### 13.5.1 Función auxiliar `callSTC` en el backend

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

#### 13.5.2 Uso dentro de `POST /api/orders`

```javascript
// Dentro del handler de POST /api/orders (ver §21.7 para el handler completo):
try {
  await callSTC({
    cmid: _cmid,
    additionalData: buildAdditionalDataFromTrustedState(req.user)
  });
} catch (err) {
  logger.warn({ err, cmid: _cmid }, "STC failed; continuing checkout");
}

// Continuar con Create Order independientemente del resultado de STC
const order = await createPayPalOrder({ ... });
```

> **OBLIGATORIO:** STC se ejecuta **antes** de **cada** Create Order, sin distinción del método de pago (PayPal, PayLater, Credit o BCDC). El frontend **no** invoca STC directamente; solo envía el `_cmid` al backend en el body de `POST /api/orders`.

> **OBLIGATORIO — Carácter no bloqueante:** "No bloqueante" significa "fallas en STC nunca detienen el checkout", **no** "STC se ejecuta en paralelo sin garantía de orden". Por eso el `await` dentro del `try/catch` es obligatorio: secuencia la llamada antes de Create Order y aísla los errores.

> **NOTA:** No se expone un endpoint público `PUT /api/stc` al frontend. Toda la propagación del CMID y el contexto del comprador hacia STC se realiza dentro del backend del comercio, que es el componente con acceso al `access_token` y al estado autenticado del usuario.

---

## 14. Carga del PayPal Web SDK v6

El SDK v6 se carga con un `<script async>` directamente en el HTML del checkout. **No** acepta parámetros de query string como el SDK clásico.

### 14.1 URLs del SDK

| Entorno | URL |
|---------|-----|
| **Sandbox** | `https://www.sandbox.paypal.com/web-sdk/v6/core` |
| **Live** | `https://www.paypal.com/web-sdk/v6/core` |

### 14.2 Inserción en el HTML

La URL exacta debe seleccionarse según el entorno y entregarse al frontend mediante `GET /api/config` (§10.4). El `<script>` se inserta en `<head>` o al final de `<body>`:

```html
<script async src="<PAYPAL_SDK_URL>"></script>
```

Atributos relevantes:

| Atributo | Valor | Función |
|----------|-------|---------|
| `async` | (presente) | Permite la descarga sin bloquear el parser. |
| `src` | URL del SDK según entorno. | Define qué entorno (Sandbox/Live) se usa. |

> **OBLIGATORIO:** No agregar atributos `data-*` al `<script>`. El SDK v6 no se configura mediante atributos del tag; toda la configuración pasa por `paypal.createInstance(...)` (§15).

### 14.3 Detección de carga

El frontend debe esperar a que `window.paypal.createInstance` esté disponible antes de inicializar la sesión. Cuando el `<script>` se inserta dinámicamente, el listener `onload` es la vía estándar:

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

### 14.4 Cambio de entorno (Sandbox ↔ Live)

> **OBLIGATORIO:** Un cambio entre Sandbox y Live requiere recargar la página. El SDK v6 registra *custom elements* y estos no pueden re-registrarse en la misma sesión. Cualquier lógica que pretenda alternar entornos en caliente fallará silenciosamente.

En producción, el entorno se determina en arranque del backend y permanece estable durante la vida del proceso. No existe un caso de uso real que requiera alternar entornos en caliente.

---

## 15. Inicialización del SDK y descubrimiento de métodos elegibles

Una vez cargado el `<script>` del SDK, el siguiente paso es invocar `createInstance` y luego `findEligibleMethods` para decidir qué botones renderizar.

### 15.1 `paypal.createInstance(...)`

```javascript
const sdkInstance = await window.paypal.createInstance({
  clientId:         "<PAYPAL_CLIENT_ID>",
  components:       ["paypal-payments", "paypal-guest-payments"],
  pageType:         "checkout",
  locale:           "<LOCALE_BCP47>",
  clientMetadataId: cmid   // opcional pero recomendado — ver §15.1.1
});
```

| Parámetro | Valor | Notas |
|-----------|-------|-------|
| `clientId` | `<PAYPAL_CLIENT_ID>` | Recibido del backend en `GET /api/config`. Es el único identificador público de PayPal que viaja al frontend. **No** es un secreto: puede aparecer en HTML, en herramientas de desarrollador y en logs públicos sin riesgo. |
| `components` | Array con `'paypal-payments'`, `'paypal-guest-payments'`. | `paypal-payments` habilita PayPal, PayLater y PayPal Credit. `paypal-guest-payments` habilita BCDC. Para una integración completa, ambos. |
| `pageType` | `'checkout'` | Indica al SDK que opera en página de checkout (afecta métricas y presentación). Otros valores posibles (`'cart'`, `'product-details'`) no aplican a esta integración. |
| `locale` | `'es-MX'`, `'en-US'`, `'pt-BR'`, etc. | Idioma de la UI hospedada por PayPal. Formato BCP-47 con guion. Debe corresponder al mercado del comprador. |
| `clientMetadataId` *(opcional)* | El mismo CMID generado en §12. | Pasa el CMID al SDK para que la telemetría que el SDK envía a PayPal Risk quede correlacionada con la sesión, igual que los headers `PayPal-Client-Metadata-Id` server-side. |

> **OBLIGATORIO:** `createInstance` devuelve una `Promise`. **Sí** debe ser `await`-eada (esto ocurre en la fase de inicialización, no en el handler del clic; no hay riesgo de consumir el *transient activation*).

> **NOTA:** `clientId` es el único identificador público de PayPal que el frontend conoce. No es un secreto. **No** se requiere `id_token` en JSv6.

#### 15.1.1 `clientMetadataId` y correlación con STC

El SDK v6 admite el parámetro opcional `clientMetadataId` en `createInstance(...)` para correlacionar la telemetría del SDK con la sesión del comprador en los logs server-side de PayPal. La recomendación es pasar **exactamente el mismo CMID** que se usará en STC y en los headers `PayPal-Client-Metadata-Id`:

| Punto donde aparece el CMID | Cómo se inyecta |
|-----------------------------|-----------------|
| SDK v6 (telemetría) | `clientMetadataId` en `createInstance(...)` (opcional) |
| STC | Segmento de URL `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` (server-side) |
| Create Order | Header `PayPal-Client-Metadata-Id` (server-side) |
| Capture Order | Header `PayPal-Client-Metadata-Id` (server-side) |

> **Recomendación:** Confirmar con el Integration Engineer asignado si el caso del comercio justifica pasar `clientMetadataId` al SDK. Cuando se decide hacerlo, debe ser **el mismo valor** generado en §12 para la sesión de checkout.

### 15.2 `sdkInstance.findEligibleMethods(...)`

```javascript
const paymentMethods = await sdkInstance.findEligibleMethods({
  currencyCode: "<MONEDA_ISO_4217>"
});
```

| Parámetro | Valor | Notas |
|-----------|-------|-------|
| `currencyCode` | `'MXN'`, `'USD'`, `'BRL'`, etc. | Moneda del checkout en ISO 4217. Determina la elegibilidad por mercado. |

`paymentMethods` expone los métodos disponibles para la combinación `clientId` + `currencyCode` + mercado del comprador. El comercio debe consultar la elegibilidad antes de renderizar cada botón:

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

> **OBLIGATORIO (NFR-12):** No renderizar un botón cuyo método no es elegible. Hacerlo produce errores opacos en `session.start(...)` y daña la experiencia del comprador.

> **NOTA — Claves de elegibilidad:** Las claves que acepta `isEligible(...)` y `getDetails(...)` son los identificadores funcionales del SDK v6: `"paypal"`, `"paylater"`, **`"credit"`** (no `"paypal-credit"`) y `"guest"`. La etiqueta de marketing "PayPal Credit" se mantiene únicamente en la UI; en código siempre se usa la clave `"credit"`.

### 15.3 Detalles específicos de PayLater

Para PayLater, se requieren `productCode` y `countryCode` específicos del mercado del comprador. El SDK los expone mediante `paymentMethods.getDetails('paylater')`:

```javascript
const paylaterDetails = paymentMethods.getDetails("paylater");
// paylaterDetails: { productCode: "<...>", countryCode: "<...>" }
```

Estos valores se usan posteriormente al construir la sesión de PayLater (§18) cuando el flujo del comercio lo requiere.

---

## 16. Estructura HTML y patrón de activación de sesión

### 16.1 Botones del comercio

A diferencia de integraciones basadas en `paypal.Buttons().render(...)` del SDK clásico, el SDK v6 distingue dos familias de elementos para activar una sesión:

| Familia | Métodos | Marcado |
|---------|---------|---------|
| **Botón HTML del comercio** | `paypal`, `paylater`, `credit` | `<button>` propio del comercio. Estilo y marca del comercio. El comercio adjunta `addEventListener('click', ...)` y dispara `session.start(...)`. |
| **Custom element hospedado por PayPal** | `guest` (BCDC) | `<paypal-basic-card-container>` + `<paypal-basic-card-button>`. La presentación del botón de tarjeta es controlada por PayPal; el comercio adjunta el listener al `paypal-basic-card-button` y dispara `session.start(...)` igual que con un botón propio. |

```html
<!-- PayPal, PayLater, PayPal Credit: botones del comercio -->
<button id="btn-paypal"        type="button">Pagar con PayPal</button>
<button id="btn-paylater"      type="button">Pagar con PayLater</button>
<button id="btn-paypal-credit" type="button">Pagar con PayPal Credit</button>

<!-- BCDC: custom element hospedado por PayPal -->
<paypal-basic-card-container>
  <paypal-basic-card-button id="paypal-basic-card-button"></paypal-basic-card-button>
</paypal-basic-card-container>

<div id="payment-result" role="status" aria-live="polite"></div>
```

Estilo, marca y layout de los botones HTML son del comercio. La apariencia del `<paypal-basic-card-button>` es controlada por PayPal y cumple los lineamientos de marca de tarjeta. El comercio puede ocultar dinámicamente los elementos cuyos métodos no resulten elegibles (§15.2).

> **OBLIGATORIO:** Para que `<paypal-basic-card-container>` y `<paypal-basic-card-button>` se registren correctamente, el componente `'paypal-guest-payments'` debe estar incluido en el array `components` de `createInstance(...)` (§15.1) y el SDK debe haber terminado de cargar antes de que el HTML se renderice o se monte dinámicamente.

### 16.2 Patrón de activación de sesión — preservación del *transient activation*

Esta es la regla **más crítica** de la integración. Los navegadores modernos requieren un gesto de usuario reciente (*transient activation*) para abrir un pop-up o un modal a pantalla completa. Cualquier `await` antes de invocar `session.start(...)` consume el estado y el navegador bloquea la apertura.

#### 16.2.1 Patrón correcto

```javascript
const session = sdkInstance.createPayPalOneTimePaymentSession({
  onApprove,
  onCancel,
  onError
});

document.getElementById("btn-paypal").addEventListener("click", () => {
  // Construir la promesa SIN await — preserva el transient activation
  const orderPromise = createOrder({ paymentMethod: "paypal" });

  session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

#### 16.2.2 Patrón incorrecto (no implementar)

```javascript
// INCORRECTO — el await consume el transient activation
document.getElementById("btn-paypal").addEventListener("click", async () => {
  const orderId = await createOrder({ paymentMethod: "paypal" });
  session.start({ presentationMode: "auto" }, Promise.resolve({ id: orderId }))
    .catch(onError);
});
```

> **OBLIGATORIO (NFR-14):** Construir la promesa de Create Order **dentro** del handler del clic y pasarla **inmediatamente** a `session.start(...)` sin `await`. La promesa puede tardar segundos en resolverse; el SDK la espera internamente sin consumir el *transient activation*.

### 16.3 Variantes del patrón por método

#### 16.3.1 PayPal, PayLater, PayPal Credit

```javascript
session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
```

`presentationMode: 'auto'` deja que el SDK decida la mejor forma de presentar la UI según el dispositivo y el navegador del comprador (típicamente pop-up en desktop, full-page en mobile).

#### 16.3.2 BCDC (Guest Card Checkout)

El patrón **recomendado** para BCDC adjunta el listener al custom element `<paypal-basic-card-button>` y dispara `session.start(...)` con la misma forma que las otras sesiones (sin `targetElement`):

```javascript
const cardBtn = document.getElementById("paypal-basic-card-button");

cardBtn.addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "guest" });
  guestSession.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

| Atributo | Función |
|----------|---------|
| `presentationMode` | `'auto'` para presentación adaptativa. |

> **NOTA — `targetElement`:** El SDK v6 admite variantes de apertura programática o *auto-start* en las que la sesión se inicia sin depender exclusivamente del click handler. En esos casos `targetElement` actúa como **ancla visual** de la experiencia BCDC (referencia el mismo `<paypal-basic-card-button>` o el botón equivalente del comercio). El flujo canónico de este SDD es el click handler explícito sobre `<paypal-basic-card-button>` y **no** requiere `targetElement`. Cualquier desviación hacia auto-start con `targetElement` debe validarse con el Integration Engineer asignado.

### 16.4 Forma de la promesa de Create Order

El SDK v6 acepta una `Promise` que resuelve a un objeto con la propiedad **`orderId`** (el `order_id` devuelto por PayPal). El frontend debe enviar al backend únicamente referencias controladas (no el payload completo): el identificador del carrito autenticado, el método de pago seleccionado y el CMID. El backend reconstruye el payload desde el estado confiable del carrito (ver §21.7).

```javascript
async function createOrder({ paymentMethod }) {
  const response = await fetch("/api/orders", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      _cmid:         cmid,
      paymentMethod: paymentMethod, // 'paypal' | 'paylater' | 'credit' | 'guest'
      cartId:        getCurrentCartId() // referencia al carrito autenticado
    })
  });

  if (!response.ok) {
    throw new Error(`Create Order failed: ${response.status}`);
  }

  const order = await response.json();
  return { orderId: order.id }; // El SDK v6 exige la forma { orderId: <ORDER_ID> }
}
```

> **OBLIGATORIO:** La promesa debe resolver a `{ orderId: <ORDER_ID> }`. **No** usar `{ id: ... }`: el SDK v6 espera específicamente la propiedad `orderId`. Devolver la forma incorrecta produce que `data.orderId` llegue `undefined` al callback `onApprove`.

> **NOTA:** El callback `createOrder` puede ser una función asíncrona porque el SDK la invoca internamente con `await`. Lo crítico es que **el handler del clic** no bloquee con `await` antes de `session.start(...)`.

> **NOTA — STC:** La llamada a STC se ejecuta **server-side** dentro del propio endpoint `POST /api/orders`, secuenciada antes de Create Order pero envuelta en `try/catch` para preservar el carácter no bloqueante (ver §13.5 y §21.7). El frontend **no** invoca STC directamente.

### 16.5 Callbacks de la sesión

Todas las sesiones reciben un objeto con callbacks. La forma exacta varía mínimamente entre métodos.

| Callback | PayPal / PayLater / Credit | BCDC | Función |
|----------|:--------------------------:|:----:|---------|
| `onApprove(data)` | Sí | Sí | El comprador aprobó el pago. `data.orderId` contiene el `order_id`. El comercio dispara la captura. |
| `onCancel(data)` | Sí | Sí | El comprador cerró la UI sin completar el pago. Mostrar mensaje sobrio y permitir reintento. |
| `onError(err)` | Sí | Sí | Error técnico durante la sesión. Loguear y mostrar mensaje accionable. |
| `onWarn(warn)` | — | **Sí** | Advertencia no fatal específica de BCDC (ej. campo de tarjeta inválido en la UI hospedada). El SDK ya muestra feedback al usuario; el comercio típicamente solo loguea. |

> **OBLIGATORIO:** En BCDC, no omitir `onWarn`. El callback existe específicamente para advertencias de la UI hospedada; ignorarlo deja al comercio sin telemetría sobre fricción de captura.

---

## 17. Sesión de PayPal Checkout (cuenta PayPal)

Sesión activada por `createPayPalOneTimePaymentSession`. Es el flujo de pago con cuenta PayPal del comprador.

### 17.1 Inicialización

```javascript
const paypalSession = sdkInstance.createPayPalOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => {
    showInfo("Pago cancelado por el comprador.");
  },
  onError: (err) => {
    console.error("PayPal session error:", err);
    showError("No fue posible completar el pago. Intente nuevamente.");
  }
});
```

### 17.2 Activación

```javascript
document.getElementById("btn-paypal").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "paypal" });
  paypalSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 17.3 Comportamiento esperado

1. PayPal abre su UI hospedada (pop-up o full-page) con la pantalla de login del comprador.
2. El comprador se autentica, revisa el resumen y confirma el pago.
3. La UI hospedada se cierra. El SDK invoca `onApprove(data)` con `data.orderId`.
4. El comercio dispara `POST /api/orders/:id/capture` y maneja la respuesta.

---

## 18. Sesión de PayLater

Sesión activada por `createPayLaterOneTimePaymentSession`. Ofrece financiamiento PayPal a plazos en mercados elegibles.

### 18.1 Validación previa de elegibilidad

```javascript
if (!paymentMethods.isEligible("paylater")) {
  document.getElementById("btn-paylater").style.display = "none";
  return;
}
const paylaterDetails = paymentMethods.getDetails("paylater");
// paylaterDetails: { productCode: "<...>", countryCode: "<...>" }
```

`productCode` y `countryCode` describen el producto PayLater elegible para el mercado del comprador (ej. "Pay in 4" en US, "3x" en MX/BR según disponibilidad).

### 18.2 Inicialización

```javascript
const paylaterSession = sdkInstance.createPayLaterOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Financiamiento cancelado."),
  onError:  (err)  => { console.error(err); showError("Error al iniciar PayLater."); }
});
```

### 18.3 Activación

```javascript
document.getElementById("btn-paylater").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "paylater" });
  paylaterSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 18.4 Notas operativas

- La presentación del producto (texto legal, tasas, condiciones) está controlada por la UI hospedada por PayPal y cumple los requisitos regulatorios del mercado.
- La elegibilidad puede cambiar entre sesiones (depende del comprador, del monto y de la disponibilidad del producto). El comercio **debe** consultar `findEligibleMethods` cada vez que inicializa el checkout.
- Tras la aprobación, el flujo de captura es idéntico al de PayPal Checkout (§17): `POST /v2/checkout/orders/{id}/capture`.

---

## 19. Sesión de PayPal Credit

Sesión activada por `createPayPalCreditOneTimePaymentSession`. Ofrece la línea de crédito PayPal en mercados donde el producto está disponible.

### 19.1 Validación previa de elegibilidad

```javascript
if (!paymentMethods.isEligible("credit")) {
  document.getElementById("btn-paypal-credit").style.display = "none";
  return;
}
const creditDetails = paymentMethods.getDetails("credit");
// creditDetails: { productCode: "<...>", countryCode: "<...>" }
```

> **OBLIGATORIO:** La clave de elegibilidad es **`"credit"`**, no `"paypal-credit"`. La etiqueta "PayPal Credit" es solo de UI.

### 19.2 Inicialización

```javascript
const creditSession = sdkInstance.createPayPalCreditOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Operación cancelada."),
  onError:  (err)  => { console.error(err); showError("Error al iniciar PayPal Credit."); }
});
```

### 19.3 Activación

```javascript
document.getElementById("btn-paypal-credit").addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod: "credit" });
  creditSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
});
```

### 19.4 Notas operativas

- PayPal Credit está disponible en un subconjunto de mercados. La elegibilidad por mercado se determina vía `findEligibleMethods`.
- La UI hospedada presenta al comprador las condiciones de la línea de crédito y gestiona la autenticación.
- Tras la aprobación, el flujo de captura es idéntico al de PayPal Checkout (§17).

---

## 20. Sesión de BCDC — Guest Card Checkout

Sesión activada por `createPayPalGuestOneTimePaymentSession`. Permite al comprador pagar con tarjeta de crédito/débito **sin** crear una cuenta PayPal. La UI de captura de tarjeta es **hospedada por PayPal**: los datos de cuenta de tarjeta del comprador nunca tocan el DOM ni el backend del comercio.

### 20.1 Diferencias clave frente a las otras sesiones

| Aspecto | PayPal / PayLater / Credit | BCDC |
|---------|---------------------------|------|
| Componente requerido en `createInstance` | `'paypal-payments'` | `'paypal-guest-payments'` |
| Constructor | `createPayPal*OneTimePaymentSession` | `createPayPalGuestOneTimePaymentSession` |
| Callbacks | `onApprove`, `onCancel`, `onError` | `onApprove`, `onCancel`, `onWarn`, `onError` |
| Elemento que dispara la sesión | `<button>` HTML del comercio | `<paypal-basic-card-button>` dentro de `<paypal-basic-card-container>` (custom elements registrados por el SDK) |
| Argumentos a `session.start(...)` | `{ presentationMode: 'auto' }` + `orderPromise` | `{ presentationMode: 'auto' }` + `orderPromise` (idéntico) |
| Captura de tarjeta | No aplica (cuenta PayPal o financiamiento) | UI hospedada por PayPal |

### 20.2 Marcado HTML

```html
<paypal-basic-card-container>
  <paypal-basic-card-button id="paypal-basic-card-button"></paypal-basic-card-button>
</paypal-basic-card-container>
```

Estos custom elements son registrados por el SDK v6 cuando `'paypal-guest-payments'` está incluido en `components` de `createInstance(...)`. Si el componente no está incluido, los elementos no se hidratan y permanecen como tags inertes en el DOM.

### 20.3 Inicialización

```javascript
const guestSession = sdkInstance.createPayPalGuestOneTimePaymentSession({
  onApprove: async (data) => {
    const result = await captureOrder(data.orderId);
    showSuccess(result);
  },
  onCancel: (data) => showInfo("Pago con tarjeta cancelado."),
  onWarn:   (warn) => console.warn("BCDC warning:", warn),
  onError:  (err)  => { console.error(err); showError("No fue posible procesar la tarjeta."); }
});
```

### 20.4 Activación (patrón recomendado por click handler)

```javascript
document
  .getElementById("paypal-basic-card-button")
  .addEventListener("click", () => {
    const orderPromise = createOrder({ paymentMethod: "guest" });
    guestSession.start({ presentationMode: "auto" }, orderPromise).catch(showError);
  });
```

> **OBLIGATORIO:** El listener se adjunta al `<paypal-basic-card-button>` (custom element hospedado por PayPal). El handler **no** debe contener `await` antes de `session.start(...)` (regla de *transient activation* de §16.2).

> **NOTA — `targetElement`:** El SDK v6 admite variantes de apertura programática o *auto-start* (por ejemplo, disparar la sesión desde un handler `onload` en lugar de un click). En esas variantes, `options.targetElement` actúa como **ancla visual** de la experiencia BCDC y se invoca como:
>
> ```javascript
> session.start(
>   { targetElement: <ELEMENTO_ANCLA>, presentationMode: "auto" },
>   orderPromise
> );
> ```
>
> Esa variante **no** es la recomendada para el flujo de checkout cubierto por este SDD; el patrón canónico es el listener explícito sobre `<paypal-basic-card-button>` documentado arriba. Cualquier desviación debe validarse con el Integration Engineer.

### 20.5 Validación previa de elegibilidad

```javascript
if (!paymentMethods.isEligible("guest")) {
  // Ocultar el contenedor para no presentar el botón hospedado al comprador
  document.querySelector("paypal-basic-card-container").style.display = "none";
  return;
}
```

### 20.6 Aislamiento PCI

La UI hospedada vive en `paypal.com`. Las consecuencias prácticas son:

- El comercio **no** implementa iframes de captura, **no** maneja eventos de input de tarjeta, **no** valida ni transforma datos de tarjeta. Toda la interacción con la tarjeta vive en el dominio de PayPal.
- El backend del comercio **no** recibe payload con datos de cuenta de tarjeta del comprador. Su única participación en el flujo es exponer Create Order y Capture Order, que operan únicamente con identificadores opacos (`order_id`, `capture_id`).
- El comercio puede certificarse bajo **SAQ A**.

### 20.7 Comportamiento esperado

1. El comprador hace clic sobre `<paypal-basic-card-button>`.
2. PayPal abre su UI hospedada de captura de tarjeta.
3. El comprador ingresa los datos de tarjeta y confirma el pago.
4. PayPal procesa el cobro internamente. Si el banco emisor lo requiere, lanza desafíos (3DS u otros) de forma transparente al comercio.
5. La UI hospedada se cierra. El SDK invoca `onApprove(data)` con `data.orderId`.
6. El comercio dispara `POST /api/orders/:id/capture` y maneja la respuesta.

> **NOTA:** En el flujo BCDC del SDK v6 cubierto por este SDD, el comercio **no** recibe ni evalúa `liabilityShift` ni `enrollment_status`. La eventual ejecución de 3DS por parte de PayPal es transparente.

---

## 21. Creación y captura de órdenes

El backend del comercio expone tres rutas que actúan como proxies autenticados hacia la API REST de PayPal:

| Ruta del backend (sugerida) | API de PayPal | Propósito |
|------------------------------|---------------|-----------|
| `POST /api/orders` | `POST /v2/checkout/orders` | Crear la orden con `intent: "CAPTURE"`. |
| `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` | Consultar detalles enriquecidos (típicamente post-capture, para reconciliación). |
| `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` | Ejecutar el cobro real. |

### 21.1 Headers HTTP obligatorios

| Header | Create Order | Capture Order | Descripción |
|--------|:-----------:|:-------------:|-------------|
| `Authorization: Bearer <ACCESS_TOKEN>` | Sí | Sí | Token Bearer obtenido en §11. |
| `Content-Type: application/json` | Sí | Sí | El body es JSON. |
| `PayPal-Request-Id` | `<CREATE_REQUEST_ID>` | `<CAPTURE_REQUEST_ID>` | **Idempotencia por operación.** Llave **distinta** para Create y Capture. La misma llave se reutiliza solo ante reintentos del **mismo** request (timeouts o `5xx` transitorios). |
| `PayPal-Client-Metadata-Id: <CMID>` | Sí | Sí | Vincula la transacción con el contexto de STC. **Mismo CMID** en Create y Capture (es el identificador de la sesión de checkout, no de la operación). |

> **OBLIGATORIO — Idempotencia (NFR-06):** Las llaves `<CREATE_REQUEST_ID>` y `<CAPTURE_REQUEST_ID>` son independientes. Reutilizar la misma llave para Create y Capture viola la guía de idempotencia de PayPal y puede producir comportamiento inconsistente. Cada operación tiene su propia llave; cada llave se reutiliza únicamente para reintentos del mismo request. Una transacción nueva produce un `<CREATE_REQUEST_ID>` nuevo; su captura asociada produce un `<CAPTURE_REQUEST_ID>` nuevo. Ver §25.2 para la estrategia completa.

### 21.2 Create Order — payload base

```json
{
  "intent": "CAPTURE",
  "application_context": {
    "brand_name":          "<NOMBRE_VISIBLE_DEL_COMERCIO>",
    "locale":              "<LOCALE_BCP47>",
    "shipping_preference": "SET_PROVIDED_ADDRESS",
    "user_action":         "PAY_NOW",
    "return_url":          "<URL_DE_RETORNO_REAL_DEL_COMERCIO>",
    "cancel_url":          "<URL_DE_CANCELACION_REAL_DEL_COMERCIO>"
  },
  "payer": {
    "email_address": "<EMAIL_DEL_COMPRADOR>",
    "name": {
      "given_name": "<NOMBRE_DEL_COMPRADOR>",
      "surname":    "<APELLIDO_DEL_COMPRADOR>"
    },
    "phone": {
      "phone_type": "MOBILE",
      "phone_number": {
        "national_number": "<TELEFONO_SOLO_DIGITOS>"
      }
    }
  },
  "purchase_units": [
    {
      "invoice_id":  "<INVOICE_ID_UNICO_DEL_COMERCIO>",
      "custom_id":   "<ORDER_ID_INTERNO_DEL_COMERCIO>",
      "description": "<DESCRIPCION_BREVE_DEL_PEDIDO>",
      "amount": {
        "currency_code": "<MONEDA_ISO_4217>",
        "value":         "<TOTAL_DEL_CARRITO>",
        "breakdown": {
          "item_total": { "currency_code": "<MONEDA>", "value": "<SUMA_UNIT_AMOUNT_X_QTY>" },
          "tax_total":  { "currency_code": "<MONEDA>", "value": "<SUMA_TAX_X_QTY>" },
          "shipping":   { "currency_code": "<MONEDA>", "value": "<COSTO_DE_ENVIO>" },
          "discount":   { "currency_code": "<MONEDA>", "value": "<DESCUENTO_APLICADO>" }
        }
      },
      "items": [
        {
          "name":        "<NOMBRE_DEL_PRODUCTO>",
          "description": "<DESCRIPCION_DEL_PRODUCTO>",
          "sku":         "<SKU_DEL_CATALOGO>",
          "quantity":    "<CANTIDAD>",
          "unit_amount": { "currency_code": "<MONEDA>", "value": "<PRECIO_UNITARIO_SIN_IMPUESTOS>" },
          "tax":         { "currency_code": "<MONEDA>", "value": "<IMPUESTO_POR_UNIDAD>" },
          "category":    "PHYSICAL_GOODS"
        }
      ],
      "shipping": {
        "name":    { "full_name": "<NOMBRE_COMPLETO_DEL_DESTINATARIO>" },
        "address": {
          "address_line_1": "<CALLE_Y_NUMERO>",
          "address_line_2": "<COLONIA_O_REFERENCIA>",
          "admin_area_2":   "<CIUDAD_O_MUNICIPIO>",
          "admin_area_1":   "<ESTADO_CODIGO>",
          "postal_code":    "<CODIGO_POSTAL>",
          "country_code":   "<PAIS_ISO_ALPHA2>"
        }
      }
    }
  ]
}
```

### 21.3 Justificación de cada bloque

| Bloque | Por qué es obligatorio en producción |
|--------|---------------------------------------|
| `intent: "CAPTURE"` | Modelo de cobro inmediato cubierto por este SDD. `AUTHORIZE` requiere un flujo de captura diferida fuera de alcance. |
| `application_context.shipping_preference: SET_PROVIDED_ADDRESS` | Indica a PayPal que use la dirección incluida en `purchase_units[].shipping`. Mejora la calidad de las señales de riesgo. |
| `application_context.return_url` / `cancel_url` | Requeridos para flujos que en algún momento del ciclo necesitan redirección (ej. desafíos del banco emisor en BCDC). Deben ser URLs reales del dominio del comercio. |
| `payer.email_address`, `payer.name`, `payer.phone` | Identifican al comprador para la evaluación de riesgo y para soporte de disputas. En BCDC, sirven además como contacto del comprador invitado. |
| `invoice_id` | Identificador único del comercio para reconciliación contable e idempotencia lógica. Evita duplicar pedidos en reintentos. |
| `custom_id` | ID interno adicional del comercio (ej. ID de pedido en su backoffice). |
| `breakdown` + `items` | El monto total debe ser **matemáticamente consistente** con el desglose y los line items. PayPal valida la consistencia y rechaza con `422` si no cuadra. |
| `items[].tax` | IVA por línea, necesario para que `tax_total` cuadre. |
| `items[].category` | `PHYSICAL_GOODS`, `DIGITAL_GOODS` o `DONATION`. Influye en el procesamiento de riesgo. |
| `shipping.address` | Requerido cuando `shipping_preference` es `SET_PROVIDED_ADDRESS`. |

> **NOTA:** El payload de Create Order es **idéntico** para los cuatro métodos de pago (PayPal, PayLater, PayPal Credit, BCDC). En esta integración, el comercio **no** envía `payment_source`. PayPal asocia automáticamente la orden con el método de pago correspondiente al constructor de sesión que se invocó.

### 21.4 Reglas de validación del breakdown

```
amount.value === item_total + tax_total + shipping − discount
item_total   === Σ (item.unit_amount × item.quantity) por línea
tax_total    === Σ (item.tax × item.quantity) por línea
```

Si los valores no cuadran, PayPal responde `422 UNPROCESSABLE_ENTITY` con detalle del campo inconsistente.

### 21.5 Capture Order

```http
POST {PAYPAL_API_BASE}/v2/checkout/orders/<ORDER_ID>/capture
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json
PayPal-Request-Id: <CAPTURE_REQUEST_ID>
PayPal-Client-Metadata-Id: <CMID>

{}
```

> **OBLIGATORIO:** `<CAPTURE_REQUEST_ID>` es una llave de idempotencia **distinta** a la usada en Create Order. La misma `<CAPTURE_REQUEST_ID>` se reutiliza únicamente ante reintentos del mismo Capture (timeouts o `5xx` transitorios). Ver §25.2.

La respuesta contiene `purchase_units[0].payments.captures[0]` con `id` (transaction ID), `status: "COMPLETED"`, `amount`, `create_time` y `seller_protection`.

### 21.6 Consulta enriquecida post-capture

Tras una captura exitosa, una consulta a `GET /v2/checkout/orders/{id}` devuelve la orden con el `payment_source` enriquecido (incluye marca de tarjeta y últimos 4 dígitos cuando aplica BCDC, o el `email_address` del comprador en flujos PayPal). Es el dato canónico para registrar en el backoffice del comercio.

```http
GET {PAYPAL_API_BASE}/v2/checkout/orders/<ORDER_ID>
Authorization: Bearer <ACCESS_TOKEN>
```

### 21.7 Contrato frontend → backend y construcción server-side del payload

#### 21.7.1 Contrato de la petición

El frontend **no** construye el payload de Create Order. Envía únicamente referencias controladas que permiten al backend reconstruir el payload desde estado confiable (carrito autenticado en sesión):

| Campo | Tipo | Origen | Propósito |
|-------|------|--------|-----------|
| `_cmid` | string (1–32 alfanumérico) | Frontend (generado en §12) | Header `PayPal-Client-Metadata-Id` y URL de STC. |
| `paymentMethod` | enum (`paypal` / `paylater` / `credit` / `guest`) | Frontend (según el botón pulsado) | Telemetría y validación. |
| `cartId` | string | Frontend (estado del carrito que el comercio ya tenía en sesión) | Referencia al carrito autenticado para reconstruir el payload server-side. |

> **OBLIGATORIO:** El frontend **no** envía monto, items, breakdown, datos del comprador ni dirección de envío. Estos datos se obtienen en el backend a partir de `cartId` y de la sesión autenticada del usuario. Aceptar montos enviados desde el cliente expone al comercio a manipulación de precios y a inconsistencias entre lo cobrado y lo facturado.

#### 21.7.2 Frontend — callback `createOrder`

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
  return { orderId: order.id }; // Forma exigida por el SDK v6
}
```

#### 21.7.3 Backend — `POST /api/orders`

El backend ejecuta cuatro pasos en orden estricto: validación, STC (no bloqueante), construcción del payload desde estado confiable y Create Order con idempotencia gestionada por operación.

```javascript
app.post("/api/orders", async (req, res) => {
  const { _cmid, paymentMethod, cartId } = req.body;

  // 1) Validación de entrada
  if (!isValidCMID(_cmid))                       return res.status(400).json({ error: "invalid cmid" });
  if (!isAllowedPaymentMethod(paymentMethod))    return res.status(400).json({ error: "invalid paymentMethod" });
  const cart = await loadCartForUser(cartId, req.user); // valida ownership
  if (!cart)                                     return res.status(404).json({ error: "cart not found" });

  // 2) STC server-side, secuenciada, no bloqueante
  try {
    await callSTC({
      cmid: _cmid,
      additionalData: buildAdditionalDataFromTrustedState(req.user)
    });
  } catch (err) {
    logger.warn({ err, cmid: _cmid }, "STC failed; continuing checkout");
  }

  // 3) Construcción del payload desde estado confiable
  const orderPayload = buildOrderPayloadFromTrustedState({ cart, user: req.user });

  // 4) Create Order con idempotencia por operación
  const accessToken     = await getAccessToken();
  const createRequestId = await getOrCreateCreateRequestId(cartId); // mismo UUID en reintentos del MISMO Create

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

  // Persistir { orderId, cartId, _cmid, createRequestId } para futuros reintentos / capture
  if (response.ok) {
    await persistOrderContext({ orderId: body.id, cartId, cmid: _cmid, createRequestId });
  }

  res.status(response.status).json(body);
});
```

> **NOTA:** El prefijo `_` en `_cmid` es una convención que indica un campo de control interno entre frontend y backend, **no** parte del payload que viaja a PayPal.

> **OBLIGATORIO:** `getOrCreateCreateRequestId(cartId)` debe devolver **el mismo UUID** ante reintentos de Create Order para el mismo `cartId` (ver §25.2 para la estrategia completa de idempotencia).

### 21.8 Implementación de referencia — `POST /api/orders/:id/capture`

La captura usa una **llave de idempotencia distinta** a la de Create Order. El frontend envía `_cmid` en el body para que el backend pueda inyectar `PayPal-Client-Metadata-Id`.

```javascript
app.post("/api/orders/:id/capture", async (req, res) => {
  const { id } = req.params;
  const { _cmid } = req.body || {};
  if (!isValidCMID(_cmid)) return res.status(400).json({ error: "invalid cmid" });

  const accessToken      = await getAccessToken();
  const captureRequestId = await getOrCreateCaptureRequestId(id); // mismo UUID en reintentos del MISMO Capture

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

> **OBLIGATORIO:** `createRequestId` y `captureRequestId` son llaves **independientes**. Reusar la misma llave para Create y Capture viola la guía de idempotencia de PayPal (ver §25.2, NFR-06).

---

# Parte IV — Integración y operación

## 22. Orquestación end-to-end

La integración completa se descompone en cinco momentos. La distinción es importante porque define **qué se ejecuta una sola vez** vs **qué se ejecuta en cada intento de cobro**.

### 22.1 Momento 1 — Inicialización del checkout (una sola vez por sesión)

```
1. cmid = generateCMID()                                                [§12]
2. { clientId, sdkUrl } = GET /api/config                               [§10.4]
3. await loadSDK(sdkUrl)                                                [§14.3]
4. sdkInstance = await paypal.createInstance({ clientId, components,
                                              pageType, locale })      [§15.1]
5. paymentMethods = await sdkInstance.findEligibleMethods({
                       currencyCode })                                  [§15.2]
6. Si paymentMethods.isEligible('paylater'):
       paylaterDetails = paymentMethods.getDetails('paylater')          [§15.3]
7. Construir las sesiones (cada una con sus callbacks):                 [§17, §18, §19, §20]
       paypalSession   = sdkInstance.createPayPalOneTimePaymentSession({...})
       paylaterSession = sdkInstance.createPayLaterOneTimePaymentSession({...})
       creditSession   = sdkInstance.createPayPalCreditOneTimePaymentSession({...})
       guestSession    = sdkInstance.createPayPalGuestOneTimePaymentSession({...})
8. Renderizar/mostrar únicamente los botones cuyo método es elegible.   [§16.1]
9. Adjuntar addEventListener('click', ...) a cada botón con el patrón
   de activación correcto.                                              [§16.2]
```

### 22.2 Momento 2 — Clic del comprador (sin `await` antes de `start`)

```
btn.addEventListener("click", () => {
  const orderPromise = createOrder({ paymentMethod });   // sin await
  session.start({ presentationMode: "auto" }, orderPromise).catch(onError);
});
```

`createOrder({ paymentMethod })` (frontend) internamente:

```
a) POST /api/orders
   body = { _cmid: cmid, paymentMethod, cartId }
b) return { orderId: order.id }
```

El backend, dentro de `POST /api/orders`, ejecuta en orden estricto:

```
1) Validar _cmid, paymentMethod y ownership de cartId.
2) await callSTC({ cmid, additionalData })            // §13 — try/catch, no bloqueante
3) Construir orderPayload desde estado confiable      // §21.7
4) createRequestId = getOrCreateCreateRequestId(cartId)
5) POST /v2/checkout/orders + headers:
       PayPal-Request-Id:         <CREATE_REQUEST_ID>
       PayPal-Client-Metadata-Id: <CMID>
6) Persistir { orderId, cartId, _cmid, createRequestId }
7) Responder al frontend con { id: orderId }
```

### 22.3 Momento 3 — Aprobación (callback `onApprove`)

```
onApprove(data) {
  const result = await captureOrder(data.orderId);
  showSuccess(result);
}
```

### 22.4 Momento 4 — Captura

```
POST /api/orders/<ORDER_ID>/capture + body._cmid = cmid
   → backend internamente:
       captureRequestId = getOrCreateCaptureRequestId(orderId)
       inyecta headers:
           PayPal-Request-Id:         <CAPTURE_REQUEST_ID>   ← distinto del de Create
           PayPal-Client-Metadata-Id: <CMID>                  ← mismo CMID de la sesión
```

### 22.5 Momento 5 — Consulta enriquecida y registro en backoffice

```
GET /api/orders/<ORDER_ID>
   → respuesta enriquecida con payment_source y datos de captura.
Persistir en el backoffice del comercio: order_id, capture_id, status,
payment_source, invoice_id, custom_id, CMID, createRequestId, captureRequestId.
```

### 22.6 Regla mnemotécnica

| Componente | Frecuencia |
|-----------|-----------|
| **CMID** | Una vez por sesión de checkout. Se reutiliza en STC, Create y Capture. |
| **`createInstance` + `findEligibleMethods`** | Una vez por sesión de checkout (después de cargar el SDK). |
| **STC server-side** | Antes de cada Create Order, dentro del handler `POST /api/orders`. |
| **`createRequestId`** | Un UUID por intención de Create Order (típicamente por `cartId`). Se reutiliza en reintentos del **mismo** Create. |
| **`captureRequestId`** | Un UUID por intención de Capture Order (típicamente por `orderId`). Se reutiliza en reintentos del **mismo** Capture. **Distinto** del `createRequestId`. |
| **`PayPal-Client-Metadata-Id`** | Mismo CMID en Create y Capture. |
| **`session.start(...)`** | Una vez por intento de cobro, dentro del handler del clic, sin `await` previo. |

---

## 23. Puntos de integración (mapa de endpoints)

| Operación | Backend del comercio (sugerido) | API de PayPal |
|-----------|--------------------------------|---------------|
| Configuración pública para el frontend | `GET /api/config` | — (no llega a PayPal) |
| Token OAuth (uso interno del backend) | (interno) | `POST /v1/oauth2/token` |
| Set Transaction Context (uso interno, llamado desde `POST /api/orders`) | (interno) | `PUT /v1/risk/transaction-contexts/{merchant_id}/{cmid}` |
| Crear orden (incluye STC server-side y construcción del payload) | `POST /api/orders` | `POST /v2/checkout/orders` |
| Consultar orden | `GET /api/orders/:id` | `GET /v2/checkout/orders/{id}` |
| Capturar orden | `POST /api/orders/:id/capture` | `POST /v2/checkout/orders/{id}/capture` |

> **NOTA:** No se expone un endpoint público `/api/stc` al frontend. STC se ejecuta server-side dentro de `POST /api/orders` (§13.5, §21.7) para garantizar el orden estricto STC → Create Order y para que el frontend no tenga conocimiento del flujo de riesgo.

---

## 24. Consideraciones de seguridad

Esta sección consolida las decisiones de seguridad dispersas a lo largo del diseño. Cada control responde a uno o varios NFR de §8.

### 24.1 Custodia de credenciales (NFR-02)

| Asset | Almacenamiento | Transmisión |
|-------|----------------|-------------|
| `PAYPAL_CLIENT_SECRET` | Variable de entorno del backend, gestionada por un secrets manager (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, etc.). Nunca en código fuente. | Solo backend → `/v1/oauth2/token` codificado en `Authorization: Basic`. |
| `PAYPAL_MERCHANT_ID` | Variable de entorno del backend. | Solo backend → URL de STC. |
| `access_token` | Memoria del proceso del backend. Caché con TTL inferior al `expires_in`. Nunca persistido. | Solo backend → API REST de PayPal en `Authorization: Bearer`. |

### 24.2 Aislamiento PCI (NFR-01)

- En PayPal, PayLater y Credit, el flujo no involucra tarjeta del comprador desde la perspectiva del comercio: el comprador autentica con su cuenta PayPal o acepta la oferta de financiamiento en la UI hospedada por PayPal.
- En BCDC, los datos de cuenta de tarjeta del comprador se capturan íntegramente en la UI hospedada por PayPal. Nunca entran al DOM ni al backend del comercio.
- El comercio puede certificarse bajo **SAQ A**.

### 24.3 Transporte (NFR-03)

- TLS 1.2 mínimo en producción.
- HSTS recomendado.
- Certificados con cadena de confianza válida; renovación automatizada.

### 24.4 Content Security Policy (NFR-04)

CSP mínima recomendada para el dominio del checkout:

```
script-src   'self' https://www.paypal.com https://www.paypalobjects.com https://c.paypal.com;
frame-src    https://www.paypal.com;
connect-src  'self' https://api-m.paypal.com https://api-m.sandbox.paypal.com;
img-src      'self' https://www.paypalobjects.com data:;
style-src    'self' https://www.paypalobjects.com 'unsafe-inline';
```

En entornos Sandbox agregar adicionalmente `https://www.sandbox.paypal.com` a `script-src` y `frame-src`.

### 24.5 Logging y manejo de datos sensibles (NFR-08)

Permitido en logs:

- `order_id`, `capture_id`, `invoice_id`, `custom_id`, `CMID`, `createRequestId`, `captureRequestId`.
- `status` de la captura, código de error de PayPal y mensajes de validación.
- Nombre del método de pago elegido (`paypal`, `paylater`, `credit`, `guest`).

**Prohibido** en logs:

- `access_token`, `client_secret`, `merchant_id`, header `Authorization` completo.
- Bodies de respuesta de PayPal con secretos sin enmascarar (al loguear respuestas, enmascarar `access_token`, `nonce`, `app_id`).
- Respuestas enriquecidas de `GET /v2/checkout/orders/{id}` que incluyan campos parciales de tarjeta retornados por PayPal (ej. marca y últimos 4 dígitos para reconciliación), si el comercio decide loguearlos: aplicar mascaramiento o limitarlos a los campos estrictamente necesarios.

> **NOTA:** El comercio **no captura** PAN, CVV ni fecha de expiración del comprador en ningún flujo, por lo que esos datos no pueden filtrarse accidentalmente desde el código del comercio. La regla de logging se enfoca en proteger los **secretos del backend** (credenciales y tokens) y en enmascarar los datos parciales de tarjeta que PayPal pueda devolver post-captura.

### 24.6 Validación de entrada en el backend

El backend debe validar antes de reenviar a PayPal:

- Que el `_cmid` recibido del frontend sea un identificador alfanumérico de entre 1 y 32 caracteres, sin guiones ni separadores (regla de validación de §12.3).
- Que el monto, moneda y breakdown del payload sean consistentes con el carrito autenticado del usuario (no confiar en valores enviados por el cliente).
- Que el `invoice_id` corresponda a un pedido válido del usuario en sesión (evitar IDOR).
- Que el `paymentMethod` declarado por el frontend pertenezca al set permitido (`paypal`, `paylater`, `credit`, `guest`).

### 24.7 Aislamiento del frontend

El frontend solo debe conocer:

- `client_id` (público, vía `GET /api/config`).
- URLs `/api/*` del backend del comercio.
- `order_id` y `capture_id` (referencias opacas).

El frontend **no** debe conocer:

- `client_secret`, `merchant_id`, `access_token`.
- URLs `api-m.paypal.com` (no debe construir requests directos a la API REST de PayPal).

---

## 25. Consideraciones operativas

### 25.1 Métricas y observabilidad

Métricas mínimas a instrumentar en producción:

| Métrica | Granularidad | Alarma sugerida |
|---------|-------------|-----------------|
| Tasa de éxito de `POST /v1/oauth2/token` | Por minuto | < 99 % en ventana de 5 min. |
| Latencia p95 de Create Order y Capture Order | Por minuto | Excede SLO interno. |
| Tasa de respuesta `≠ 200` en STC | Por minuto | > 5 % en ventana de 5 min (no bloquea, pero degrada riesgo). |
| Tasa de éxito de captura por método (PayPal, PayLater, Credit, BCDC) | Por hora | Anomalía vs baseline histórico. |
| Tasa de `onCancel` por método | Por hora | Pico inusual sugiere fricción de UI. |
| Tasa de `onError` por método | Por hora | Indica problema técnico (SDK, red, configuración). |
| Tasa de `UNPROCESSABLE_ENTITY` en Create Order | Por minuto | > 0.5 % indica bug en construcción del breakdown. |
| Tasa de elegibilidad nula (`findEligibleMethods` sin métodos) | Por hora | Pico inusual sugiere problema de configuración o de mercado. |

### 25.2 Idempotencia (NFR-06)

PayPal aplica idempotencia **por operación**: cada llamada a la API REST tiene su propia llave `PayPal-Request-Id`, y la misma llave se reutiliza únicamente ante reintentos del **mismo** request. Reutilizar la misma llave entre operaciones distintas (por ejemplo entre Create y Capture) viola la guía oficial.

#### 25.2.1 Llaves por operación

| Operación | Llave recomendada | Reutilización |
|-----------|------------------|---------------|
| Create Order | `createRequestId` (UUID generado server-side, asociado a `cartId`) | Reintentos del mismo Create (timeouts, errores de red, `5xx` transitorios). |
| Capture Order | `captureRequestId` (UUID generado server-side, asociado a `orderId`) | Reintentos del mismo Capture. |
| Nueva orden | Nuevo `createRequestId` | Aunque el CMID pueda conservarse en la misma sesión de checkout. |
| Nueva captura sobre nueva orden | Nuevo `captureRequestId` | — |

#### 25.2.2 Estrategia recomendada

1. **`createRequestId`** se genera la primera vez que el frontend invoca `POST /api/orders` para un `cartId` dado. El backend persiste la asociación `<cartId> → <createRequestId>` durante el ciclo de vida del checkout.
2. Si el frontend reintenta `POST /api/orders` para el mismo `cartId` (timeout o `5xx`), el backend devuelve el mismo `createRequestId` y por lo tanto la misma orden.
3. **`captureRequestId`** se genera la primera vez que el frontend invoca `POST /api/orders/:id/capture` para un `orderId` dado. El backend persiste `<orderId> → <captureRequestId>`.
4. Si el frontend reintenta el Capture, el backend devuelve el mismo `captureRequestId` y PayPal devuelve la captura previa.
5. Tanto `createRequestId` como `captureRequestId` deben persistirse junto a la orden en el backoffice del comercio para auditoría y para sostener reintentos a lo largo del ciclo de vida.

#### 25.2.3 Implementación de referencia

```javascript
// Helpers que materializan la regla de idempotencia por operación
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

> **OBLIGATORIO:** No usar el mismo UUID para Create y Capture. La separación por operación se alinea con la [guía oficial de idempotencia de PayPal](https://developer.paypal.com/reference/guidelines/idempotency/) y previene comportamientos indefinidos.

### 25.3 Tolerancia a fallos

| Servicio | Estrategia |
|---------|-----------|
| `POST /v1/oauth2/token` | Reintentar una vez tras `401/5xx`; si persiste, abortar y alertar (la integración deja de funcionar). |
| `POST /v2/checkout/orders` | Reintentar con el mismo `createRequestId` ante `5xx` o errores de red transitorios. |
| `POST /v2/checkout/orders/{id}/capture` | Igual que Create Order. |
| `PUT /v1/risk/transaction-contexts/...` (STC) | **No** reintentar. Loguear el fallo y continuar el checkout. |
| Carga del SDK v6 | Si el `<script>` no carga, desactivar los botones de pago y mostrar mensaje de degradación al usuario. Telemetría de cliente para detectar incidencias en los dominios de PayPal. |

### 25.4 Rotación de credenciales

- `PAYPAL_CLIENT_SECRET`: rotación coordinada con PayPal Developer Dashboard. La rotación invalida el `access_token` cacheado; el sistema debe refrescarlo automáticamente al recibir el primer `401`.
- `PAYPAL_CLIENT_ID`: cambia muy raramente. Cualquier cambio requiere actualizar también el `clientId` que el frontend recibe de `GET /api/config`. Como el `clientId` se usa en `paypal.createInstance(...)`, una rotación obliga a recargar la página para que el SDK se reinicialice con el valor nuevo.

### 25.5 Promoción Sandbox → Live

| Punto | Cambio |
|-------|--------|
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` → `https://api-m.paypal.com` |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` → `https://www.paypal.com/web-sdk/v6/core` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Credenciales de la app Live, **no** Sandbox. |
| `PAYPAL_MERCHANT_ID` | Merchant ID de la cuenta Live. |
| `application_context.return_url` / `cancel_url` | URLs reales del dominio de producción del comercio. |
| `additional_data` de STC | Datos del usuario autenticado real, no valores de prueba. |
| CSP | Agregar/retirar dominios Sandbox según corresponda. |

### 25.6 Reglas de cambio de entorno en runtime

> **OBLIGATORIO:** El SDK v6 registra *custom elements* al inicializarse. **No es posible** alternar entre Sandbox y Live sin recargar la página. La selección de entorno debe hacerse en arranque del backend (variable de entorno) y permanecer estable durante toda la sesión del comprador.

---

# Parte V — Validación y gobierno

## 26. Estrategia de pruebas y entorno Sandbox

El plan de pruebas debe ejecutarse íntegramente en el entorno Sandbox antes de la promoción a Live.

### 26.1 Configuración del entorno Sandbox

| Variable | Valor en Sandbox |
|----------|------------------|
| `PAYPAL_API_BASE` | `https://api-m.sandbox.paypal.com` |
| `PAYPAL_SDK_URL` | `https://www.sandbox.paypal.com/web-sdk/v6/core` |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Credenciales de la app **Sandbox** (Developer Dashboard). |
| `PAYPAL_MERCHANT_ID` | Merchant ID de la cuenta Sandbox. |

### 26.2 Cuentas Sandbox del comprador

Para pruebas de PayPal, PayLater y PayPal Credit, el comercio debe contar con cuentas de comprador Sandbox creadas desde el Developer Dashboard. PayPal asigna a cada cuenta Sandbox de comprador:

- Un email y contraseña para autenticar en la UI hospedada.
- Un saldo simulado.
- Una o más tarjetas asociadas (para flujos en los que el comprador elige tarjeta dentro de su cuenta PayPal).

### 26.3 Tarjetas Sandbox para BCDC

Para pruebas de BCDC, PayPal publica un set de tarjetas Sandbox. Reglas comunes:

- **Fecha de expiración:** cualquier fecha futura.
- **Código de seguridad de la tarjeta:** cualquier valor de 3 dígitos (4 dígitos para Amex). El comprador (o QA actuando como comprador) lo ingresa en la UI hospedada por PayPal Sandbox; nunca llega al comercio.
- **Nombre del titular:** libre.

> **NOTA:** El set vigente de tarjetas Sandbox debe consultarse en la documentación oficial de PayPal Developer. PayPal puede actualizar el set publicado.

### 26.4 Casos de prueba mínimos (matriz)

| ID | Caso | Resultado esperado | Cumple RF |
|----|------|-------------------|-----------|
| TC-01 | Pago con cuenta PayPal (cuenta Sandbox válida) | Captura exitosa, `purchase_units[0].payments.captures[0].status === "COMPLETED"`. | RF-01, RF-04, RF-05 |
| TC-02 | Pago con PayLater en mercado elegible | Captura exitosa. | RF-03, RF-05 |
| TC-03 | Pago con PayPal Credit en mercado elegible | Captura exitosa. | RF-03, RF-05 |
| TC-04 | Pago con tarjeta vía BCDC (tarjeta Sandbox válida) | Captura exitosa. Inspección del DOM y de la red confirma que ningún payload del comercio contiene datos de cuenta de tarjeta del comprador. La captura ocurre en la UI hospedada por PayPal. | RF-02, RF-04, RF-05, NFR-01 |
| TC-05 | Cancelación por el comprador (`onCancel`) | UI muestra mensaje sobrio, no se invoca captura. | RF-11 |
| TC-06 | Error técnico durante la sesión (`onError`) | UI muestra mensaje accionable, log con detalle del error. | RF-11 |
| TC-07a | Retry técnico de Create por timeout/`5xx` (mismo `cartId`) | Mismo CMID, **mismo `createRequestId`**, mismo `orderId` devuelto (operación idempotente). | NFR-06 |
| TC-07b | Nuevo intento del comprador tras rechazo o cancelación (mismo carrito) | Mismo CMID si sigue en la misma sesión, **nuevo `createRequestId`**, nueva orden. | RF-09 |
| TC-08 | Reintento idempotente de Capture (mismo `captureRequestId` para el mismo `orderId`) | PayPal devuelve la captura previa, no genera duplicado. | NFR-06 |
| TC-09 | STC responde 400 | Checkout no se interrumpe; orden se crea correctamente. | RF-07, NFR-05 |
| TC-10 | Inspección de elegibilidad: mercado sin PayLater | Botón PayLater no se renderiza. | RF-12, NFR-12 |
| TC-11 | Inspección de elegibilidad: moneda sin PayPal Credit | Botón PayPal Credit no se renderiza. | RF-12, NFR-12 |
| TC-12 | Validación de transient activation | El pop-up/modal de PayPal abre sin bloqueo del navegador en Chrome, Firefox, Safari y Edge. | RF-06, NFR-14 |
| TC-13 | `GET /api/config` no expone secretos | Respuesta contiene `clientId` y `sdkUrl`; no contiene `client_secret`, `merchant_id` ni `access_token`. | NFR-02 |
| TC-14 | Validación CSP | Carga del SDK y apertura de la UI hospedada no producen violaciones de CSP en la consola. | NFR-04 |
| TC-15 | Cambio de entorno Sandbox → Live | Tras cambiar variables de entorno y recargar la página, el SDK opera contra el entorno correcto. | §25.5, §25.6 |
| TC-16 | Validación del CMID | Inspección de la red confirma el mismo CMID en STC, en `PayPal-Client-Metadata-Id` de Create Order y en el de Capture Order. | RF-08 |

### 26.5 Verificaciones manuales recomendadas

- **DevTools → Network:** confirmar que ninguna llamada del navegador va directamente a `api-m.paypal.com`. Todas las llamadas de negocio van a `/api/*` del backend.
- **DevTools → Network:** confirmar que la respuesta de `GET /api/config` no contiene `client_secret`, `access_token` ni `merchant_id`.
- **DevTools → Application → Storage:** confirmar que el `access_token` no se persiste en `localStorage`, `sessionStorage` ni cookies del comercio.
- **DevTools → Console:** confirmar la ausencia de violaciones de CSP al iniciar el checkout y al disparar las sesiones.
- **Backend → Logs:** confirmar que ningún log contiene `access_token`, `client_secret` ni el header `Authorization` completo. Los valores enmascarados deben preservar el prefijo y reemplazar el resto. (Datos de cuenta de tarjeta del comprador no deberían aparecer en logs porque el comercio no los recibe; cualquier aparición indica un bug grave o un campo enriquecido de PayPal sin enmascarar.)

---

## 27. Convenciones de nombres REST vs SDK

La inconsistencia entre `snake_case` (REST) y `camelCase` (SDK) es una causa frecuente de bugs en integraciones que mezclan ambas capas. Tabla de equivalencias para esta integración:

| Concepto | API REST (`snake_case`) | SDK JavaScript v6 (`camelCase`) |
|----------|-------------------------|--------------------------------|
| Identificador de orden | `id` (en respuesta) / `order_id` (en headers internos) | `orderId` (en `data.orderId` de `onApprove`) |
| Código de moneda | `currency_code` | `currencyCode` |
| Código de país | `country_code` | `countryCode` |
| Componente del SDK | (no aplica en REST) | `components: ['paypal-payments', 'paypal-guest-payments']` |
| Tipo de página | (no aplica en REST) | `pageType: 'checkout'` |
| Identificador de cliente PayPal | `client_id` (en form-encoded de OAuth) | `clientId` (en `createInstance`) |
| Modo de presentación de la UI | (no aplica en REST) | `presentationMode: 'auto'` |
| Elemento ancla en BCDC (custom element) | (no aplica en REST) | `<paypal-basic-card-button>` registrado por el SDK |
| Header de correlación de riesgo | `PayPal-Client-Metadata-Id` (header HTTP) | (no aplica en SDK; se inyecta server-side) |
| Header de idempotencia | `PayPal-Request-Id` (header HTTP, llave por operación) | (no aplica en SDK; se inyecta server-side) |

> **Regla mental:** Si el dato sale o entra de un endpoint REST (cuerpo JSON o headers HTTP), es `snake_case` o `Pascal-Case` con guiones (en headers). Si lo pasas a un método del objeto `paypal.*` o lo recibes en un callback del SDK, es `camelCase`.

---

## 28. Asunciones, dependencias y restricciones

### 28.1 Asunciones

| ID | Asunción |
|----|----------|
| **A-01** | El comercio dispone de un backend bajo su control donde puede custodiar `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID` y emitir el `access_token`. |
| **A-02** | El comercio tiene un sistema de autenticación de usuarios y un servicio de carrito que produce un breakdown matemáticamente consistente. |
| **A-03** | El mercado destino soporta la moneda configurada y la elegibilidad de los métodos de pago deseados (PayPal, PayLater, Credit, BCDC). |
| **A-04** | El comprador usa un navegador moderno con soporte de pop-ups, *transient activation*, ES2017+ y CSP. |
| **A-05** | La cuenta de PayPal tiene activadas las habilitaciones comerciales listadas en §10.1. |
| **A-06** | El comercio gestiona el cambio de entorno Sandbox → Live mediante variables de entorno del backend; no requiere alternancia en runtime. |

### 28.2 Dependencias externas

| ID | Dependencia | Tipo |
|----|-------------|------|
| **D-01** | API REST de PayPal (`api-m.paypal.com`, `api-m.sandbox.paypal.com`). | Crítica — bloqueante. |
| **D-02** | PayPal Web SDK v6 (`https://www.paypal.com/web-sdk/v6/core` y su equivalente Sandbox). | Crítica — bloqueante. |
| **D-03** | Endpoint OAuth2 (`/v1/oauth2/token`). | Crítica — sin él no hay `access_token`. |
| **D-04** | Endpoint STC (`/v1/risk/transaction-contexts`). | Recomendada — no bloqueante. |
| **D-05** | Dominios `www.paypal.com`, `www.paypalobjects.com`, `c.paypal.com` (y equivalentes Sandbox) accesibles desde el navegador del comprador y permitidos en CSP. | Crítica — la UI hospedada vive en estos dominios. |

### 28.3 Restricciones

| ID | Restricción |
|----|-------------|
| **R-01** | El SDK v6 no admite parámetros de query string en su URL ni atributos `data-*` de configuración. Toda la configuración pasa por `createInstance(...)`. |
| **R-02** | El SDK v6 registra *custom elements* y no puede re-inicializarse en la misma página. Cambiar de entorno (Sandbox ↔ Live) requiere recargar. |
| **R-03** | El callback `createOrder` no puede ser `await`-eado dentro del handler del clic; el patrón obligatorio es construir la promesa y pasarla inmediatamente a `session.start(...)`. |
| **R-04** | El flujo canónico de BCDC se activa con un `addEventListener('click', ...)` sobre `<paypal-basic-card-button>`, sin `targetElement`. La variante con `targetElement` (apertura programática / auto-start) es válida pero queda fuera del flujo canónico de este SDD y requiere validación con el Integration Engineer. |
| **R-05** | El CMID es único por sesión de checkout y no debe reutilizarse entre compradores ni sesiones distintas. |
| **R-06** | `PayPal-Request-Id` se gestiona con llaves **independientes por operación**: `createRequestId` para Create Order, `captureRequestId` para Capture Order. Cada llave se reutiliza únicamente ante reintentos del **mismo** request. |
| **R-07** | El `client_secret` y el `merchant_id` no pueden, bajo ninguna circunstancia, alcanzar el navegador. |
| **R-08** | La integración cubierta por este SDD usa exclusivamente `intent: "CAPTURE"`. `AUTHORIZE` queda fuera de alcance. |

---

## 29. Riesgos y mitigaciones

| ID | Riesgo | Probabilidad | Impacto | Mitigación |
|----|--------|:------------:|:-------:|------------|
| **RG-01** | Exposición de `PAYPAL_CLIENT_SECRET` por commit accidental al repositorio. | Media | Crítico | Pre-commit hooks que detecten patrones de secretos; secrets manager; revisión de seguridad obligatoria. Plan de rotación inmediata si se detecta exposición. |
| **RG-02** | Exposición de `access_token` al frontend por bug en `GET /api/config` o en el envoltorio de respuestas de `/api/*`. | Baja | Crítico | Tests automatizados que validen que las respuestas no contienen `access_token`, `client_secret` ni `merchant_id`; revisión de código obligatoria; mascaramiento centralizado en el backend. |
| **RG-03** | Bloqueo del pop-up por consumo accidental del *transient activation* (uso de `await` antes de `session.start`). | **Alta** | Alto | Code review con checklist explícita; lint rule custom; test E2E que confirme apertura del pop-up sin requerir interacción adicional del usuario. |
| **RG-04** | BCDC con marcado incorrecto (botón HTML propio en lugar de `<paypal-basic-card-button>`, o componente `'paypal-guest-payments'` ausente en `createInstance`) → custom elements no se hidratan o sesión falla al activarse. | Media | Alto | Test E2E que verifique que `<paypal-basic-card-button>` está presente, hidratado y dispara la sesión. Validación en arranque de que `'paypal-guest-payments'` está en `components`. |
| **RG-05** | Mezcla de credenciales Sandbox/Live (entorno cruzado). | Baja | Crítico | Validación del prefijo del `CLIENT_ID` y del `PAYPAL_API_BASE` al arrancar el backend; alarma si hay incoherencia entre variables del mismo bloque. |
| **RG-06** | Order o Capture duplicada por reintento sin idempotencia, o llave reutilizada entre operaciones. | Media | Alto | Llaves separadas por operación (`createRequestId`, `captureRequestId`), persistidas server-side y reutilizadas ante reintentos del **mismo** request (§21.1, §25.2). Test E2E que valide reintentos idempotentes y test que valide que las llaves de Create y Capture son distintas. |
| **RG-07** | Botones de métodos no elegibles renderizados al comprador. | Media | Medio | Filtrado obligatorio por `findEligibleMethods` antes de renderizar (§15.2). Test E2E por mercado. |
| **RG-08** | Falla de CSP que bloquea la carga del SDK o la UI hospedada. | Media | Alto | CSP probada en staging por entorno (Sandbox y Live); fallback de detección y mensaje claro al usuario si los scripts no cargan. |
| **RG-09** | Bloqueo del checkout por error de STC (incumplimiento de NFR-05). | Baja | Crítico | STC implementado como no bloqueante con `try/catch` y respuesta 200 garantizada al frontend (§13.5.1). Test de QA: TC-09. |
| **RG-10** | Inicialización del SDK contra el entorno equivocado (URL o `client_id` cruzados). | Baja | Crítico | `GET /api/config` es la única fuente de `clientId` y `sdkUrl` para el frontend; el backend valida coherencia entre `PAYPAL_API_BASE`, `PAYPAL_SDK_URL` y credenciales. |
| **RG-11** | Re-inicialización del SDK en la misma página al cambiar entorno → conflicto de *custom elements*. | Baja | Alto | Forzar recarga de página al cambiar entorno; documentar la restricción para el equipo de operaciones. |
| **RG-12** | `breakdown` inconsistente → `422 UNPROCESSABLE_ENTITY`. | Media | Medio | Función pura en el backend que arme `breakdown` y `items` con validación matemática previa al envío. |
| **RG-13** | Logs filtran secretos del backend (`access_token`, `client_secret`) o campos parciales de tarjeta retornados por PayPal post-captura sin enmascarar. | Media | Crítico | Wrapper de logging que aplique mascaramiento por defecto a claves sensibles (`access_token`, `nonce`, `app_id`, `Authorization`); revisión de pipeline de observabilidad. |
| **RG-14** | El comercio cambia el `clientId` sin recargar la página → SDK queda con instancia obsoleta. | Baja | Medio | Cambios de `clientId` siempre disparan recarga (`location.reload()` o navegación). |

---

## 30. Criterios de aceptación y checklist pre-producción

Antes de promover la solución a Live, todos los siguientes criterios deben cumplirse.

### 30.1 Seguridad

- [ ] `PAYPAL_CLIENT_SECRET` reside únicamente en variables de entorno del backend; nunca se incluye en código fuente versionado ni se envía al navegador.
- [ ] `PAYPAL_MERCHANT_ID` reside únicamente en variables de entorno del backend.
- [ ] Archivos de configuración con credenciales (`.env`, equivalentes) excluidos del control de versiones.
- [ ] El backend solo expone `clientId` y `sdkUrl` al frontend vía `GET /api/config`; nunca `access_token`, `client_secret` ni `merchant_id`.
- [ ] Logs no registran `access_token`, `client_secret`, headers `Authorization` completos ni campos parciales de tarjeta retornados por PayPal post-captura sin enmascarar.
- [ ] Content Security Policy permite `https://www.paypal.com`, `https://www.paypalobjects.com` y `https://c.paypal.com` (y sus equivalentes Sandbox cuando aplica).
- [ ] TLS 1.2+ habilitado en producción.

### 30.2 Configuración

- [ ] `PAYPAL_API_BASE` apunta a `https://api-m.paypal.com` en Live.
- [ ] `PAYPAL_SDK_URL` apunta a `https://www.paypal.com/web-sdk/v6/core` en Live.
- [ ] `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y `PAYPAL_MERCHANT_ID` corresponden al entorno Live.
- [ ] `application_context.return_url` y `cancel_url` son URLs reales y accesibles del dominio del comercio.
- [ ] El `<script>` del SDK no incluye atributos `data-*` ni parámetros de query string.
- [ ] El array `components` de `createInstance` contiene exactamente `['paypal-payments', 'paypal-guest-payments']` (o el subconjunto que el comercio expone).

### 30.3 Funcional

- [ ] `findEligibleMethods` se invoca en cada inicialización del checkout y solo se renderizan los botones cuyos métodos resultan elegibles.
- [ ] El handler del clic de cada botón **no** contiene `await` antes de `session.start(...)`.
- [ ] BCDC: el HTML contiene `<paypal-basic-card-container>` con `<paypal-basic-card-button>` adentro; el listener de clic está sobre el `<paypal-basic-card-button>` y `session.start(...)` se invoca con `{ presentationMode: 'auto' }` (sin `targetElement`).
- [ ] `breakdown` e `items` reflejan el estado real del carrito y cumplen las reglas de §21.4.
- [ ] `PayPal-Request-Id`: llaves **independientes** por operación (`createRequestId` y `captureRequestId`). Cada una se reutiliza solo ante reintentos del mismo request; nunca se reutiliza la misma llave entre Create y Capture.
- [ ] Manejo de errores implementado en `onError`, `onCancel` y (en BCDC) `onWarn`.
- [ ] Los datos de `payer`, `shipping` y `purchase_units` provienen del estado del checkout, no de placeholders.
- [ ] Tras la captura, el backoffice del comercio registra `order_id`, `capture_id`, `status`, CMID, `createRequestId`, `captureRequestId`, `invoice_id` y `custom_id`.

### 30.4 Riesgo

- [ ] CMID generado una sola vez por sesión de checkout, propagado entre frontend y backend.
- [ ] STC se llama antes de **cada** Create Order (independientemente del método).
- [ ] `additional_data` de STC proviene de la sesión autenticada del comprador.
- [ ] STC no bloquea el checkout: errores se loguean y la transacción continúa.
- [ ] Header `PayPal-Client-Metadata-Id` presente en Create Order y Capture Order, con el mismo CMID.

### 30.5 Pruebas

- [ ] Matriz de casos de prueba TC-01 a TC-16 ejecutada y verde en Sandbox.
- [ ] Inspección DevTools confirma que ninguna llamada del navegador va directamente a `api-m.paypal.com`.
- [ ] Inspección DevTools confirma que `GET /api/config` no expone `access_token`, `client_secret` ni `merchant_id`.
- [ ] Pruebas manuales en Chrome, Firefox, Safari y Edge confirman que el pop-up/modal abre sin bloqueo en los cuatro métodos.

### 30.6 Operación

- [ ] Métricas de §25.1 instrumentadas y conectadas al sistema de observabilidad.
- [ ] Alarmas configuradas para los umbrales sugeridos.
- [ ] Runbook de incidentes documentado: falla de OAuth, falla de Create Order, anomalía en tasas de captura por método, caída del SDK.
- [ ] Plan de rotación de `CLIENT_SECRET` documentado y probado en Sandbox.
- [ ] Procedimiento documentado para promoción Sandbox → Live (§25.5) y para cambio coordinado de variables de entorno.

---

# Apéndices

## Apéndice A — Diagnóstico de errores frecuentes

| Síntoma | Causa más probable | Cómo diagnosticar |
|---------|--------------------|-------------------|
| `401 Unauthorized` en `/v1/oauth2/token` | `CLIENT_ID` / `CLIENT_SECRET` mal copiados o entorno cruzado (Sandbox vs Live). | Verificar que `PAYPAL_API_BASE`, `PAYPAL_SDK_URL` y las credenciales correspondan al **mismo entorno**. |
| El pop-up de PayPal queda bloqueado por el navegador | El handler del clic contiene `await` antes de `session.start(...)`, consumiendo el *transient activation*. | Inspeccionar el handler: la promesa de Create Order debe construirse e inmediatamente pasarse a `session.start(...)` sin `await` previo (§16.2). |
| BCDC: el `<paypal-basic-card-button>` no se renderiza o queda inerte | El componente `'paypal-guest-payments'` no está incluido en `components` de `createInstance(...)`, o el HTML del custom element se montó antes de que el SDK terminara de cargar. | Confirmar que `'paypal-guest-payments'` está en `components`. Asegurarse de invocar `createInstance(...)` antes de mostrar el contenedor. |
| BCDC: el clic no dispara la sesión | El listener se adjuntó a un elemento incorrecto (ej. al `<paypal-basic-card-container>` en vez de al `<paypal-basic-card-button>`), o el elemento se reemplazó por el SDK después de adjuntar el listener. | Adjuntar el listener al `<paypal-basic-card-button>` después de que el SDK haya terminado de hidratar los custom elements. |
| `findEligibleMethods` devuelve un set vacío para el mercado | Combinación `client_id` + `currencyCode` + país del comprador sin habilitaciones suficientes. | Verificar la habilitación comercial en el Developer Dashboard; verificar `currencyCode` ISO 4217; consultar al Integration Engineer. |
| Botón PayLater renderizado pero la sesión falla al activarse | Se renderizó sin validar `paymentMethods.isEligible('paylater')`. | Filtrar por `isEligible(...)` antes de mostrar cada botón (§15.2). |
| `422 UNPROCESSABLE_ENTITY` en Create Order | `breakdown` que no cuadra con `amount.value` y/o suma de items. | Aplicar reglas de §21.4 manualmente; PayPal devuelve el campo específico inconsistente en la respuesta. |
| Captura ejecuta dos veces ante un retry del navegador | El backend genera un `captureRequestId` nuevo por cada llamada en lugar de buscarlo en su store por `orderId`. | Implementar `getOrCreateCaptureRequestId(orderId)` con persistencia para devolver el mismo UUID en reintentos del mismo Capture (§25.2). |
| Mensajes contradictorios al reintentar Create tras un timeout | El backend genera un `createRequestId` nuevo en el reintento → PayPal crea una orden adicional. | Persistir `createRequestId` por `cartId` y reutilizarlo en reintentos del mismo Create (§25.2). |
| Cambio de entorno (Sandbox ↔ Live) deja la página rota | Se intentó re-inicializar el SDK sin recargar la página. | Forzar recarga (`location.reload()`) tras cambiar variables de entorno (§14.4, §25.6). |
| `GET /api/config` devuelve `access_token` o `client_secret` | Bug en la implementación del endpoint: se serializa el objeto completo de configuración. | Implementar lista blanca de campos (`{ clientId, sdkUrl }`) en lugar de `res.json(config)` directo (§24.1, RG-02). |
| STC responde 400 | Tipo de campo incorrecto en `additional_data`. | Validar formatos según §13.3 (especialmente `sender_create_date` y `sender_phone`). |
| STC responde 401 | `MERCHANT_ID` incorrecto, `access_token` expirado o sin permiso de `risk/transaction-contexts`. | Verificar `PAYPAL_MERCHANT_ID`. Refrescar token. Validar habilitación con el Integration Engineer. |
| STC responde 5xx pero el checkout se interrumpe | El handler `POST /api/orders` está propagando el error de STC en lugar de absorberlo dentro de su `try/catch`. | El bloque `await callSTC(...)` debe estar envuelto en `try/catch`; cualquier excepción se loguea como `warn` y se continúa con Create Order (§13.5, §21.7). |
| Funciona en Postman pero falla en el navegador | El frontend está intentando llamar a `api-m.paypal.com` directamente. | El frontend siempre va contra `/api/*` del backend; nunca directo a la API REST de PayPal (§9.2). |
| `paypal.createInstance is not a function` | El `<script>` del SDK no terminó de cargar antes de la llamada. | Esperar el `onload` del `<script>` o usar el helper `loadSDK(...)` con `Promise` (§14.3). |
| El `onApprove` recibe `data.orderId` `undefined` | Forma de la promesa devuelta por `createOrder` incorrecta. | El callback debe devolver **`{ orderId: <ORDER_ID> }`** (no `{ id: ... }` ni el `order_id` desnudo). El SDK v6 lee específicamente la propiedad `orderId` (§16.4). |
| Logs muestran tokens completos | El logger del backend serializa cuerpos crudos de PayPal. | Implementar wrapper de logging que enmascare por defecto `access_token`, `nonce`, `app_id`, `Authorization` (§24.5). |
| El SDK no muestra la UI en el idioma esperado | `locale` mal formado o no soportado en el mercado del comprador. | Usar formato BCP-47 con guion (`'es-MX'`, no `'es_MX'`); validar que el `locale` esté en la lista soportada por PayPal. |

---

## Apéndice B — Limitaciones y trabajo futuro

### B.1 Limitaciones conocidas

- **Cambio de entorno en runtime** no es soportado por el SDK v6 (registra *custom elements*). La selección de Sandbox/Live debe hacerse en arranque del backend y mantenerse estable durante la sesión del comprador.
- **`AUTHORIZE` + captura diferida** queda fuera de alcance. Esta integración usa exclusivamente `intent: "CAPTURE"`.
- **Capacidades de tarjeta avanzadas** (captura en iframes propios, control explícito de autenticación reforzada y su resultado, pagos a meses, reuso de tarjeta entre sesiones) no son parte de esta integración. El comercio que las requiera debe evaluar un SDD complementario o una solución paralela.

### B.2 Trabajo futuro sugerido

| Iniciativa | Descripción |
|------------|-------------|
| **Operaciones de back-office** | SDD complementario para webhooks (`PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CUSTOMER.DISPUTE.CREATED`), reembolsos parciales/totales, settlement y conciliación financiera. |
| **Métodos de pago adicionales** | Extensión de la solución para incluir billeteras locales u otros métodos disponibles en el SDK v6, agregando los componentes correspondientes a `createInstance`. |
| **Captura diferida (`AUTHORIZE`)** | Para modelos de negocio (preorders, dropshipping) donde la captura se realiza tras confirmación de inventario o envío. |
| **Industry pack** | Adopción del set extendido de `additional_data` de STC correspondiente a la vertical del comercio (Travel, Gaming, Financial Services, etc.). |

---

*Solution Design Document para la integración de PayPal Checkout (PayPal, PayLater, PayPal Credit) y Branded Card-Direct Checkout (BCDC) sobre el PayPal JavaScript SDK v6 con arquitectura server-side.*
