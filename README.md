# Loura Ticket Classifier

A small HTTP service that ingests support tickets, classifies them asynchronously with an LLM, and exposes the results over an API.

---

Running the project: 

```bash
filling later
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

| Method | Path | Description |
|---|---|---|
| `POST` | `/tickets` | Ingest a ticket. `202` if new, `200` if the id already exists. |
| `GET` | `/tickets/:id` | Fetch one ticket. `404` if missing. |
| `GET` | `/tickets?category=&priority=&limit=&cursor=` | List with filters and cursor pagination. |


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

### API shape

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
