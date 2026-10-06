# Loura Ticket Classifier

A small HTTP service that ingests support tickets, classifies them asynchronously with an LLM, and exposes the results over an API.

---

Running the project: 

```bash
npm install
npm run dev        # API on http://localhost:3000
npm run seed       # in a second terminal: loads the 10 sample tickets
npm test
```

---

## How it works 

```
POST /tickets -> save as pending -> 202
worker -> claim -> prompt -> LLM -> validate -> classified | failed
```

---

## Ticket lifecycle 
```
pending -> processing -> classified | failed 
processing (lease expires) -> pending 
```

---

## API

| Method | Path | Success | Errors |
|---|---|---|---|
| `POST` | `/tickets` | `202` new ticket, `200` same id + same content already exists | `400` invalid body, `409` same id with different content, `413` body too large |
| `GET` | `/tickets/:id` | `200` | `404` |
| `GET` | `/tickets?category=&priority=&limit=&cursor=` | `200` `{ items, nextCursor }` | `400` invalid filter or cursor |

- Input: id 1–100 chars, subject 0–500 chars, body 1–20,000 chars. Unknown fields are rejected.
- Errors always look like `{ "error": { "code": "...", "message": "..." } }`. Codes include `invalid_request`, `invalid_json`, `invalid_cursor`, `not_found`, `conflict`.
- Listing is newest first. `limit` defaults to 20 (max 100). `nextCursor` is an opaque token, `null` on the last page.


## Decisions on the open questions


### Storage (planned)
What: I will be utilizing SQLite through the better-sqlite3 library on node.js. There's one tickets table: the ticket itself, its status, the classification fields, attempts, error, and lease. The CHECK constraints restrict the status, category, and priority to the allowed values and require a classified row to have a full classification.

Why: Haven't used SQLite in a while, but it made sense since it requires zero setup, we don't need a db server or docker here, and it gives us everything we need here: transactions, a primary key to force idempotency on the ticket IDs, and an atomic claims to help us use the db as the job queue. The CHECK constrains also help us in adding another layer of validation after our application code runs it's validation. WAL mode helps us in allowing the API to read even when the worker writes. 

Trade off: SQLite is a local file, so the service is limited to one machine, and running multiple instances would mean moving to Postgres. There are no schema migrations, a schema change means deleting the database file.

### How asynchronous work runs (planned)
What: As mentioned above, the db here will be our queue. POST /tickets inserts the ticket as pending and returns 202, that insert acts as the enqueue here. A background worker in the same process is going to be polling every 500ms for pending tickets, claims them atomically, and begins the classification logic. I will not be using a separate queuing system. 

Why: Avoiding the dual write problem. With a separate queue, ingesting a ticket would require two steps, writing to the database and pushing to the queue. If the process dies between the two, you get a ticket that exists but never classified, or a job for a ticket that doesn't exist in the db. With one store, the ticket and its "needs work" state are the same row, written in one statement, so they can't disagree. It also means zero extra infrastructure, simply clone and run.

Trade off: Polling is adding up to 500ms of latency before work starts, and runs a cheap query even when idle. The worker shares a process with the API, so heavy load on one affects the other. At larger scale I'd move the worker to its own process and consider a real queue, accepting the dual write problem and handling it properly. 


### Validating model output 
What: The model's output will be treated as untrusted as highlighted in the document. Before we store anything, we extract first JSON object from the text, parse it, then validate it against  a strict Zod schema. It's built around our allowed values for category and priority, and  a 1 - 200 character limit,  no extra fields are allowed. Parser will not throw, it will either return a valid Classification object or a short reason why it wasnt valid. 

We will not be mapping values, only trimming whitespaces and lowercasing. A rejected response counts as a failed attempt and goes through the retry policy. The raw output is never stored, only the short reason.

We have three lines of defence: the schema at runtime, repository only allowing validated of type Classification, and the DB's CHECK constraint as a final step. 

Why: A repair that changes meaning turns a model error into data that looks correct, and nobody downstream could tell. Rejecting it keeps every stored classification something the model actually said within the rules, and keeps failures visible. Trimming and lowercasing are safe. 

Trade off: Strictness turns some recoverable answers into retries. Taking the first JSON object could pick the wrong one if the model returns several. Most importantly, validation checks shape, not truth: a well formed but wrong classification, including one produced by prompt injection, passes. Catching that needs an evaluation set, not a schema.

### Prompt injection _(planned)_

---

### In-flight work on restart
What: Claiming a ticket sets it to processing, with a lease time of 60 seconds. On startup and every worker tick (500ms), tickets in processing whose lease ended go back to pending, keeping their attempt count. Attemps are counted before each model call, so the crash can't reset the retry budget. Every write after the claim only succeeds if the worker still holds the exact lease it claimed with, the lease value is acting as a fencing token. 

Why: Tickets live in the db instead of the memory, this way the crash cant lose them. It can only leave them stranded in the processing stage, and the lease is their way of unstranding them without a need for a manual cleanup. Keeping attempts means a ticket the constantly fails the worker will still end up as failed instead of being stuck in retrying forever. 

Trade off: Processing is at-least-once, not exactly-once. A crash after the model responds but before the result is saved means that ticket is classified again, an extra model call. Stranded tickets wait up to 60 seconds for their lease to expire before resuming. The lease must stay longer than the worst case time for all retries, or a healthy ticket gets reclaimed in the middle of retry.

### API shape
What: See the API section above. POST returns 202 for a new ticket and 200 for a repeat, reusing an id with different content returns 409. "Same content" means subject and body match exactly, with no normalisation. Every error uses one format. Listing uses cursor pagination, newest first.

Why: 202 says honestly that the work isn't done yet, and differs from 200 so a client can tell "new" from "already had it". Re-sending identical content is a normal client retry; re-using an id with different content is likely a client bug, so it's surfaced instead of silently ignored. Cursor pagination stays correct while new tickets keep arriving; offset pagination would repeat or skip rows when the list shifts.

Trade off: Exact comparison means a resend with a trailing space gets a 409. Cursors can't jump to page n and there's no total count. List filters are built dynamically from fixed SQL fragments, always with bound parameters, so each filter combination can use the (category, priority, created_at, id) index, priority only and unfiltered listings dont use it and scan the table. No authentication and no API versioning.


---

## The LLM



---

## Testing


---

## What changed from the plan


---

## What I'd do with more time

-  

---