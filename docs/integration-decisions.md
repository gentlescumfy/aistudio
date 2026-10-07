# First-slice integration decisions

These decisions clarify the implementation brief without adding public fields. Architecture proposals remain future work unless explicitly adopted here.

## Retry

- Only a `failed` run can be retried; successful nodes and assets are retained.
- Retry returns the run transitioned to `queued` with HTTP 200.
- Other states return HTTP 409, including a concurrent retry after another request has already queued the run.
- Frontend clients refresh the run after a conflict instead of assuming their command succeeded.
- A provider outcome known to be uncertain is not eligible for automatic resubmission.

## Cancel

- Cancelling a `queued` or `running` local mock run returns HTTP 200 with `cancelled` status and stops subsequent scheduling.
- Repeated cancellation of an already `cancelled` run returns that run with HTTP 200.
- Cancelling a `succeeded` or `failed` run returns HTTP 409 and preserves history.
- Late local execution results must not overwrite cancelled state or publish new assets after cancellation.
- These semantics apply only to the current interruptible local mock adapter; real provider cancellation requires a separate contract for pending cancellation and reconciliation.

## Historical execution

Persist run inputs and node definitions before execution. Recovery and retry use that run's stored definitions, rather than looking up the latest template graph. Full immutable template configuration/version snapshots and public revision fields remain a productionization requirement.

## Deferred public API changes

Public template revision, retry/cancel command idempotency keys, cancellation-request metadata, list pagination, authorized production downloads and richer errors are deferred. The local demonstration has no tenant authorization and must not be deployed as a public service.

## Documentation status

Architecture and acceptance documents are design and test requirements, not proof of implemented features. Their retry/cancel descriptions have been aligned with the HTTP policies above. Build, test, restart and UI acceptance results must be recorded separately after delivery.
