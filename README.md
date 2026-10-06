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

### Retries and how a ticket ends up failed
What: Each ticket gets 3 attempts total. Every model call has a 10 second timeout. Between attempts the worker waits with exponential backoff plus some jitter, roughly 1s then 2s, and doesn't wait after the last attempt. Timeouts, provider errors, and invalid output (bad JSON, missing fields, values outside the allowed sets) all count as a failed attempt and share the same budget. After the third failed attempt the ticket is marked failed, with the reason from the last attempt stored on it. If a ticket comes back from lease recovery already out of attempts, it's marked failed straight away without calling the model. If the worker loses its lease mid way, it stops and writes nothing.

Why: Model failures are usually one offs, so a couple of retries recover most of them cheaply. Backoff avoids hammering a provider that's already struggling, and the jitter keeps retries from all firing at the same moment. Failing loudly beats coercing a bad answer into a default, a failed ticket with a reason is visible and fixable, a coerced one looks like a real classification and nobody would ever know the model went wrong.

Trade off: Retrying invalid output with the same prompt might just reproduce the same mistake, with a real model I'd include the validation error in the retry prompt. A ticket waiting in backoff still holds one of the concurrency slots. Worst case per ticket is about 33 seconds (3 * 10s + backoff), which is why the lease is 60 seconds. Rate limit responses from a real provider usually say how long to wait, and I don't honor that, it just counts as a normal failed attempt. Failed tickets stay failed until something requeues them.

---

### Concurrency
What: There is one worker running inside the same process as the API, and it classifies at most 4 tickets at a time (can be adjusted). Every tick it fills any free slots by claiming the oldest pending tickets, and when a classification finishes its slot frees up and gets refilled on the next tick. Everything else just waits in the db as pending. If more than one instance were running, the atomic claim makes sure no two workers ever get the same ticket, the cap controls how many, the claim controls who gets which.

Why: Classifying is mostly waiting on the model, so running a few at once gives real throughput even in a single node process. Capping it protects the model provider, real APIs rate limit you and every call costs money, and unlimited parallel calls would just turn into rate limit errors and more retries. It also means a sudden burst of tickets sits safely in the db instead of all hitting the model at once. 4 is a reasonable start, not a measured number, with a real provider I'd set it based on their rate limit.

Trade off: The cap is per process, so 3 instances would mean up to 12 calls at once. A real global limit would need shared coordination, which is out of scope here. A ticket waiting in retry backoff still holds a slot, so a run of failures slows everything else down a bit.

--- 

### Prompt injection
What: Ticket content comes from the public, so it's treated as untrusted from start to finish. In the prompt, the subject and body are wrapped in <ticket> delimiters, with an explicit instruction that everything inside is customer data and must never be followed as instructions. Any attempt to close the delimiter from inside a ticket (</ticket>, including variants with spaces) is neutralised so a ticket cant break out of its block. On the output side, the schema only allows the fixed category and priority values and caps the summary at 200 characters, so even a successful injection can only pick from valid options and can't plant a long message. At ingest, a simple pattern check looks for instruction like text ("ignore previous instructions", "classify it as", etc.) and sets suspected_injection on the ticket. Flagged tickets still get classified, but they can be found with ?suspected_injection=true for a human to review. t-1005 gets flagged, and none of the other sample tickets do.

Why: An LLM has no hard wall between my instructions and a stranger's text, it's all just text to the model, so injection can be reduced but not fully prevented. Instead of pretending otherwise, I went with layers: make the attack less likely to work (delimiters), limit the damage when it does (fixed values, short summary), and make it visible (the flag). To show the limitation honestly, the fake model has an obeyInjection mode that falls for t-1005, and a test proves the attacker's answer (technical, high, "Approved for immediate refund") passes validation and gets stored, but the ticket is flagged.

Trade off: Delimiters only reduce the risk. The pattern check is crude: rephrasing, another language, or creative wording gets past it, and it could flag an honest ticket that happens to quote similar text. Flagged tickets are still classified automatically, so their category and priority may be attacker chosen within the allowed values. The summary is still model written free text, so anything downstream should treat it as untrusted and never act on it automatically (like approving a refund because a summary says so). A stronger setup would use a second check on the model's output or route flagged tickets to human review before their classification is trusted.

---

### The LLM

There's no real model here, the brief said a convincing fake is fine, so everything goes through an LLMClient interface with a single method: complete(prompt, signal), which takes the prompt and returns raw text. The rest of the code only knows about that interface, so the fake and a real provider are interchangeable.

The prompt lives in src/llm/prompt.ts (PROMPT_VERSION v1): instructions, the allowed values, one worked example, and the ticket wrapped in <ticket> delimiters (see Prompt injection).

FakeLLM (src/llm/fake.ts) has two modes:

- Generated (what the app runs): it reads the ticket back out of the prompt, the same text a real model would see, and picks a category and priority with simple whole-word keyword rules, plus a one-sentence summary from the subject (or the body when the subject is empty, like t-1008). It's deliberately simple and makes realistic mistakes, t-1009 is mostly about an empty export but mentions being overcharged, so it comes out as billing.
- Scripted (for tests): plays back a fixed list of responses, errors, or hangs in order, so each test controls exactly what the "model" says.

To exercise the model boundary, generated mode misbehaves on purpose. With probability FAKE_LLM_FAILURE_RATE (default 0.2) it returns one of six real failures: broken JSON, an out-of-set value (priority "urgent"), a missing field, an extra field, a thrown provider error, or a hang that never responds until the timeout aborts it. Separately, about 30% of valid answers come back wrapped in prose or code fences, which isn't a failure, just messy formatting the parser has to handle. All randomness comes from a seeded RNG (FAKE_LLM_SEED), so runs are reproducible. There's also an obeyInjection option that simulates a model falling for t-1005.

Plugging in a real provider means writing one class that implements LLMClient: send the prompt with the provider's SDK, pass the AbortSignal through so timeouts work, and return the text. With a real provider I'd use its structured output mode, but I'd keep my own validation anyway, since a perfectly formatted answer can still be wrong. No API keys are needed to run this, and none are committed.

---

## Testing


---

## What changed from the plan


---

## What I'd do with more time

-  

---