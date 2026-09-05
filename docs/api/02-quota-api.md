# Quota API — Deep Dive

> **Source:** `server/src/routes/quota.ts`, `server/src/services/quota-policy.ts`, `server/src/services/quota-routing.ts`, `server/src/services/quota-forecast.ts`

## 1. Overview

The quota API (`/api/quota`) exposes the quota ledger and shadow router for operator inspection and control. It is protected by the dashboard session bearer token (`requireAuth`). All endpoints return JSON.

## 2. Quota Policy CRUD

### GET /policies?platform=

Returns all enabled policies for a given platform.

**Query Parameters**
- `platform` (string, required): Platform to filter by (e.g. `groq`).

**Response**
```json
{
  "policies": [
    {
      "id": number,
      "platform": string,
      "model_id": string | null,
      "endpoint_scope": string | null,
      "scope": string,
      "metric": string,
      "limit_value": number,
      "period_kind": string,
      "period_ms": number | null,
      "timezone": string | null,
      "anchor_day": number | null,
      "priority": number,
      "enabled": number,
      "source": string,
      "confidence": number,
      "notes": string | null,
      "created_at": string,
      "updated_at": string
    }
  ]
}
```

### PUT /policies

Creates or replaces a policy for one subject+metric (upsert).

**Request Body**
```json
{
  "platform": string,
  "model_id": string | null,
  "endpoint_scope": string | null,
  "scope": string,
  "metric": string,
  "limit_value": number,
  "period_kind": string,
  "period_ms": number | null,
  "timezone": string | null,
  "anchor_day": number | null,
  "priority": number | null,
  "enabled": boolean | null,
  "source": string | null,
  "confidence": number | null,
  "notes": string | null
}
```
All fields are optional except `platform`, `metric`, `limit_value`, `period_kind`. Omitted fields default to:
- `model_id`: `null`
- `endpoint_scope`: `null`
- `scope`: `'provider_account'`
- `priority`: `0`
- `enabled`: `true`
- `source`: `'operator'`
- `confidence`: `0.8`
- `notes`: `null`

**Response**
The created or updated policy object (same shape as in GET /policies).

### DELETE /policies/:id

Deletes a policy by its ID.

**Path Parameters**
- `id` (number): Policy ID.

**Response**
```json
{ "success": true }
```

## 3. Quota State

### GET /state?platform=&model_id=&endpoint_scope=

Returns the effective limits that currently bind the given `(platform, model_id, endpoint_scope)` triplet.

**Query Parameters**
- `platform` (string, required)
- `model_id` (string | null, optional): NULL = every model on the platform
- `endpoint_scope` (string | null, optional): NULL = every endpoint of this platform+model

**Response**
```json
{
  "platform": string,
  "model_id": string | null,
  "endpoint_scope": string | null,
  "quotas": [
    {
      "platform": string,
      "model_id": string | null,
      "metric": string,
      "scope": string,
      "limit": number,
      "period": {
        "kind": string,
        "ms": number | null,
        "timezone": string | null,
        "anchor_day": number | null
      },
      "period_start": number | null,
      "reset_at": number | null,
      "source": string,
      "confidence": number
    }
  ]
}
```
Each entry in `quotas` corresponds to a binding axis (metric + period). The `period_start` and `reset_at` are Unix milliseconds from the quota clock; they may be `null` when not knowable (see quota-clock deep dive).

## 4. Forecast

### GET /forecast

Returns the observed‑balance forecast for all platforms.

**Response**
```json
{
  "forecast": [
    {
      "platform": string,
      "pool": string,
      "used": number | null,
      "remaining": number | null,
      "limit": number | null,
      "remaining_pct": number | null,
      "reset_at": string | null,
      "low_balance": boolean,
      "seconds_until_reset": number | null
    }
  ]
}
```
See `quota-forecast.ts` for the derivation: one aggregated row per platform+pool, where pool is `platform::scope` (e.g. `groq::account`). `remaining_pct` is the share of the window still available (0..100). `low_balance` is true when `<10%` remains or `<20` requests left (if the window is at least 200 requests).

## 5. Shadow Mode Summary

### GET /shadow?days=

Returns shadow‑mode agreement statistics for the given number of days (default: all time).

**Query Parameters**
- `days` (number, optional): Number of days to look back; if omitted, uses all available data.

**Response**
```json
{
  "mode": string,
  "stats": {
    "total": number,
    "agreed": number,
    "agreementRate": number,
    "byLogicalModel": [
      {
        "logicalModel": string,
        "total": number,
        "agreed": number
      }
    ]
  }
}
```
- `mode` is the current quota routing mode (`off`, `shadow`, `active`).
- `agreementRate` is the fraction of decisions where the two routers agreed.
- `byLogicalModel` breaks down the agreement per logical model (normalized group key).

## 6. Routing Decision History

### GET /decisions?disagreed=1&model=&days=&limit=

Returns recent routing decisions, newest first.

**Query Parameters**
- `disagreed` (number, optional): If `1`, narrows to rows where the two routers differed (the rows worth reading).
- `model` (string, optional): Filter by logical model ID.
- `days` (number, optional): Only decisions within the last N days.
- `limit` (number, optional): Maximum number of rows to return (default: 100).

**Response**
```json
{
  "decisions": [
    {
      "id": number,
      "createdAt": string,
      "logicalModel": string,
      "mode": string,
      "actualPlatform": string,
      "actualModelId": string,
      "shadowPlatform": string | null,
      "shadowModelId": string | null,
      "actualEndpoint": string | null,
      "shadowEndpoint": string | null,
      "agreed": boolean,
      "reason": string | null,
      "candidates": unknown
    }
  ]
}
```
- `candidates` is a compact per‑candidate score array: `[{platform, modelId, score, headroom, paceDelta}, ...]`.
- `agreed` is `true` when the shadow router's choice matches the incumbent's choice.
- `reason` is an operator‑readable justification for the shadow router's preference.

## 7. Quota Routing Mode

### GET /mode

Returns the current quota routing mode.

**Response**
```json
{ "mode": string }
```
where `mode` is one of `off`, `shadow`, `active`.

### PUT /mode

Sets the quota routing mode.

**Request Body**
```json
{ "mode": string }
```
Valid values: `off`, `shadow`, `active`.  
`active` is reachable only by an explicit call; the default is `shadow` and never active by default.

**Response**
```json
{ "mode": string }
```
(the new mode)

## 8. Reservation Weights

### GET /reservation

Returns the current reservation weights per platform.

**Response**
```json
{ "weights": Record<string, number> }
```
where each weight is a number in `[0, 1]`. Lower means "hold this pool back".

### PUT /reservation

Sets the reservation weights per platform.

**Request Body**
```json
{ "weights": Record<string, number> }
```
**Response**
```json
{ "weights": Record<string, number> }
```
(the new weights)

---