# relay.openspaceproject.com
A lightweight Node.js caching relay for [Celestrak](http://www.celestrak.org) GP (General Perturbations) satellite data. It sits in front of the Celestrak API, serves cached responses when available, and handles Celestrak's rate-limiting gracefully.

## How it works
Incoming requests mirror the Celestrak GP query format. The relay checks for a local cached copy and serves it if it is still fresh (within 2 hours, matching Celestrak's update cadence). If no fresh copy exists the relay fetches from Celestrak, stores the result, and returns it to the caller.

If Celestrak responds with a `403` (rate-limit), the relay falls back to the stale cached copy rather than returning an error. Cached files are stored under `cache/` and named by the sorted, sanitised query parameters so that equivalent queries always hit the same file regardless of parameter order.

The server listens on port **3000** by default.

## API
All requests go to `GET /` with Celestrak GP query parameters passed through verbatim.

### Examples
| Request | Upstream URL |
|---|---|
| `GET /?GROUP=starlink&FORMAT=kvn` | `http://www.celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=kvn` |
| `GET /?GROUP=other-comm&FORMAT=kvn` | `http://www.celestrak.org/NORAD/elements/gp.php?GROUP=other-comm&FORMAT=kvn` |
| `GET /?CATNR=25544&FORMAT=kvn` | `http://www.celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=kvn` |

### Response headers
| Header | Values | Meaning |
|---|---|---|
| `X-Cache` | `HIT` | Served from a fresh cached copy |
| `X-Cache` | `MISS` | Fetched from Celestrak and cached |
| `X-Cache` | `STALE` | Cache was expired or Celestrak returned an error; stale copy served |
| `X-Cache-Date` | UTC date string | When the cached copy was last written |
| `X-Cache-Reason` | `upstream-rate-limited`, `upstream-network-error`, `upstream-<status>` | Why a stale copy was served |

## Cache behavior
| Upstream result | Has cache? | Response |
|---|---|---|
| 200 OK | — | Stores response, returns it (`X-Cache: MISS`) |
| 403 rate-limited | Yes | Returns stale copy (`X-Cache: STALE`) |
| 403 rate-limited | No | `503 Service Unavailable` with Celestrak's message |
| Network error | Yes | Returns stale copy (`X-Cache: STALE`) |
| Network error | No | `502 Bad Gateway` |
| Other non-200 | Yes | Returns stale copy (`X-Cache: STALE`) |
| Other non-200 | No | `502 Bad Gateway` |
